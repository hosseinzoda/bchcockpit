import type {
  RPCParameter as ElectrumRPCParameter, RequestResponse as ElectrumRequestResponse
} from '@electrum-cash/network';
import { ValueError, InvalidProgramState } from '@cashlab/common/exceptions.js';
import type {
  Output, TokenId, NATIVE_BCH_TOKEN_ID,
} from '@cashlab/common';
import { uint8ArrayEqual, outputFromLibauthOutput } from '@cashlab/common';
import {
  assertSuccess, binToNumberUint16LE, binToUtf8, utf8ToBin,
  decodeTransaction, hexToBin, binToHex, lockingBytecodeToCashAddress,
  sha256,
} from '@cashlab/common/libauth.js';
import type {
  Input as libauthInput
} from '@cashlab/common/libauth.js';

import type { Registry, IdentitySnapshot } from './bcmr-v2.schema.js';
import type { BCHElectronClient } from './bch-electron-client.js';
import { AbortException } from './exceptions.js';

export type BCMROPReturnData = {
  content_hash: Uint8Array;
  urls: string[];
};

export type FetchAuthChainBCMRResult = {
  chain: Array<{
    txhash: Uint8Array;
    bcmr: BCMROPReturnData | null;
  }>;
};

export function parseOPReturnDataPushes (bytecode: Uint8Array): Uint8Array[] {
  if (bytecode[0] != 0x6a) {
    throw new ValueError(`Not a OP_RETURN bytecode!`);
  }
  const result: Uint8Array[] = [];
  let i = 1;
  while (bytecode.length > i) {
    const byte = bytecode[i++] as number;
    let push_size: number;
    if (byte == 0x4c) { // OP_PUSHDATA1
      push_size = bytecode[i++] as number;
      if (push_size > bytecode.length - i) {
        throw new ValueError(`Invalid push size, at: ${i-1}, value: ${push_size}`);
     }
    } else if (byte == 0x4d) { // OP_PUSHDATA2
      push_size = binToNumberUint16LE(bytecode.slice(i, i + 2));
      if (push_size > bytecode.length - i) {
        throw new ValueError(`Invalid push size, at: ${i-2}, value: ${push_size}`);
      }
      i += 2;
    } else if (byte == 0x4e) { // OP_PUSHDATA4
      throw new ValueError(`OP_PUSHDATA4 found in an OP_RETURN bytecode`);
    } else {
      if (byte > 0x00 && byte < 0x4c) {
        push_size = byte;
      } else {
        // not a push
        continue;
      }
    }
    result.push(bytecode.slice(i, i + push_size));
    i += push_size;
  }
  return result;
};

const BCMR_SIGNATURE = utf8ToBin('BCMR');
export function parseBCMROPReturn (bytecode: Uint8Array): BCMROPReturnData {
  const chunks = parseOPReturnDataPushes(bytecode);
  if (chunks.length <= 1) {
    throw new ValueError(`At least two data push is required.`);
  }
  if (!uint8ArrayEqual(chunks[0] as Uint8Array, BCMR_SIGNATURE)) {
    throw new ValueError(`BCMR signature not found.`);
  }
  const content_hash = chunks[1] as Uint8Array;
  if (content_hash.length != 32) {
    throw new ValueError(`content_hash size is not 32 bytes.`);
  }
  return {
    content_hash,
    urls: chunks.slice(2).map(binToUtf8),
  };
};

export function parseBCMRFromBytecodes (bytecode_list: Uint8Array[]): BCMROPReturnData | null {
  for (const bytecode of bytecode_list) {
    try {
      return parseBCMROPReturn(bytecode)
    } catch (err) {
      if (!(err instanceof ValueError)) {
        throw err;
      }
    }
  }
  return null;
};

export type AuthChainMemItem = {
  txhash: Uint8Array;
  outputs_bytecode: Uint8Array[];
  bcmr: BCMROPReturnData | null;
  height?: number;
};
export type AuthChainMemTransaction = {
  txhash: Uint8Array;
  zeroth_utxo_txhash_list: Uint8Array[];
  outputs_bytecode: Uint8Array[];
  height: number;
};
export type AuthChainFetchMem = {
  chain: Array<AuthChainMemItem>;
  indexing_cost: number;
};

async function bcmrMemDBGetAuthChain (memdb: IDBDatabase, authbase_txhash: Uint8Array): Promise<AuthChainFetchMem | undefined> {
  return new Promise((resolve, reject) => {
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readonly')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    const request = db_bcmr_authchain_mem.get(`authchain:${binToHex(authbase_txhash)}`);
    request.onsuccess = () => {
      resolve(request.result?.data);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function bcmrMemDBLockingBytecodeTxList (memdb: IDBDatabase, locking_bytecode: Uint8Array): Promise<AuthChainMemTransaction[]> {
  return new Promise((resolve, reject) => {
    const lbc_hex = binToHex(locking_bytecode);
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readonly')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    const request = db_bcmr_authchain_mem.openCursor(IDBKeyRange.bound(`lbc:${lbc_hex}>`, `lbc:${lbc_hex}|`));
    const outputs: AuthChainMemTransaction[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor != null) {
        outputs.push(cursor.value.data);
        cursor.continue();
      } else {
        // end
        resolve(outputs);
      }
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function bcmrMemDBLockingBytecodeTxKeyList (memdb: IDBDatabase, locking_bytecode: Uint8Array): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lbc_hex = binToHex(locking_bytecode);
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readonly')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    const request = db_bcmr_authchain_mem.openCursor(IDBKeyRange.bound(`lbc:${lbc_hex}>`, `lbc:${lbc_hex}|`));
    const outputs: string[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor != null) {
        outputs.push(cursor.value.id);
        cursor.continue();
      } else {
        // end
        resolve(outputs);
      }
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function bcmrMemDBLockingBytecodeTx (memdb: IDBDatabase, locking_bytecode: Uint8Array, txhash: Uint8Array): Promise<AuthChainMemTransaction | undefined> {
  return new Promise((resolve, reject) => {
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readonly')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    const request = db_bcmr_authchain_mem.get(`lbc:${binToHex(locking_bytecode)}>${binToHex(txhash)}`)
    request.onsuccess = () => {
      resolve(request.result?.data);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function bcmrMemDBGetTxSpendingTargetZerothUTXO (memdb: IDBDatabase, zeroth_utxo_txhash: Uint8Array): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readonly')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    const request = db_bcmr_authchain_mem.get(`zop:${binToHex(zeroth_utxo_txhash)}`);
    request.onsuccess = () => {
      resolve(request.result?.data);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });  
}

async function bcmrMemDBSetLockingBytecodeTxData (memdb: IDBDatabase, locking_bytecode: Uint8Array, tx_data: AuthChainMemTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const lbc_hex = binToHex(locking_bytecode);
    const onDBRequest = (request: IDBRequest): void => {
      request.onerror = () => {
        reject(request.error);
      };
    };
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readwrite')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    onDBRequest(db_bcmr_authchain_mem.put({
      id: `lbc:${lbc_hex}>${binToHex(tx_data.txhash)}`,
      data: tx_data,
    }));
    for (const txhash of tx_data.zeroth_utxo_txhash_list) {
      onDBRequest(db_bcmr_authchain_mem.put({
        id: `zop:${binToHex(txhash)}`,
        data: tx_data.txhash,
      }));
    }
    dbtx.oncomplete = () => {
      resolve();
    };
  });
}

async function bcmrMemDBSetAuthChain (memdb: IDBDatabase, authbase_txhash: Uint8Array, data: AuthChainFetchMem): Promise<void> {
  return new Promise((resolve, reject) => {
    const dbtx = memdb.transaction('bcmr-auth-chain-mem', 'readwrite')
    const db_bcmr_authchain_mem = dbtx.objectStore('bcmr-auth-chain-mem');
    const request = db_bcmr_authchain_mem.put({
      id: `authchain:${binToHex(authbase_txhash)}`,
      data: data,
    });
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

const DEFAULT_MAX_INDEXING_COST = 1000;

export async function fetchBCMRFromAuthChainWithAuthBase (client: BCHElectronClient, authbase_txhash: Uint8Array, memdb: IDBDatabase, options?: { max_indexing_cost: number }): Promise<FetchAuthChainBCMRResult> {
  const max_indexing_cost = options && options.max_indexing_cost > 0 ? options.max_indexing_cost : DEFAULT_MAX_INDEXING_COST;
  let mem: AuthChainFetchMem | undefined  = await bcmrMemDBGetAuthChain(memdb, authbase_txhash); 
  if (mem == null) {
    let outputs_bytecode: Uint8Array[];
    const txbin = hexToBin(await client.electrumRequest('blockchain.transaction.get', binToHex(authbase_txhash), false) as string);
    const la_tx = assertSuccess(decodeTransaction(txbin));
    outputs_bytecode = la_tx.outputs.map((a) => a.lockingBytecode);
    mem = {
      chain: [ {
        txhash: authbase_txhash,
        outputs_bytecode,
        bcmr: parseBCMRFromBytecodes(outputs_bytecode),
        height: undefined,
      } ],
      indexing_cost: 1,
    };
    await bcmrMemDBSetAuthChain(memdb, authbase_txhash, mem);
  }
  const onAddIndexingCost = () => {
    mem.indexing_cost += 1;
    if (mem.indexing_cost % 100 == 0) {
      bcmrMemDBSetAuthChain(memdb, authbase_txhash, mem);
    }
  };
  let tmp = mem.chain[mem.chain.length - 1];
  if (tmp == null) {
    throw new ValueError(`Invalid bcmr auth chain mem.`);
  }
  while (true) {
    const txid = binToHex(tmp.txhash);
    const first_locking_bytecode = tmp.outputs_bytecode[0];
    if (first_locking_bytecode == null) {
      throw new ValueError(`A transaction with null locking at output#0, txid: ${txid}`);
    }

    const target_txhash = await bcmrMemDBGetTxSpendingTargetZerothUTXO(memdb, tmp.txhash)
    let target_tx: AuthChainMemTransaction | undefined = undefined;
    if (target_txhash != null) {
      target_tx = await bcmrMemDBLockingBytecodeTx(memdb, first_locking_bytecode, target_txhash);
    }
    if (target_tx == null) {
      const first_lbc_hex = binToHex(first_locking_bytecode);
      const stored_tx_set = new Set(await bcmrMemDBLockingBytecodeTxKeyList(memdb, first_locking_bytecode));

      // fetch locking_bytecode history
      let cashaddr;
      try {
        cashaddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: first_locking_bytecode })).address;
      } catch (err) {
        console.info(`token bcmr identity output is not a standard address, authbase: ${binToHex(authbase_txhash)}, error: ${cashaddr}`);
        break;
      }

      // fetch all transactions for the first locking bytecode
      const response: Array<{ tx_hash: string, height: number }> = await client.electrumRequest('blockchain.address.get_history', cashaddr, tmp.height != null && tmp.height > 0 ? tmp.height : 0, -1) as any;
      onAddIndexingCost();
      const authbase_txid = binToHex(authbase_txhash);
      const abort_controller = new AbortController();
      const promises: Promise<void>[] = [];
      const get_tx_requests: Array<{
        method: string;
        params: ElectrumRPCParameter[];
        onResolve: (result: ElectrumRequestResponse) => void;
        onReject: (error: Error) => void;
      }> = response.map((response_item) => {
        let resolve: () => void = null as any;
        let reject: (error: Error) => void = null as any;
        const promise = new Promise<void>((_resolve, _reject) => {
          resolve = _resolve;
          reject = _reject;
        });
        if (resolve == null || reject == null) {
          throw new InvalidProgramState('resolve == null || reject == null');
        }
        promises.push(promise);
        const item_txid: string = response_item.tx_hash;
        if (stored_tx_set.has(`lbc:${first_lbc_hex}>${item_txid}`)) {
          return null;
        } else {
          return {
            method: 'blockchain.transaction.get',
            params: [ item_txid, false ],
            onReject: (error: Error) => {
              if (error instanceof AbortException) {
                resolve();
              } else {
                reject(error);
              }
            },
            onResolve: (result: ElectrumRequestResponse) => {
              resolve();
            },
            onResponse: (result: ElectrumRequestResponse) => {
              try {
                onAddIndexingCost();
                if (mem.indexing_cost > max_indexing_cost) {
                  abort_controller.abort();
                }
                const la_tx = assertSuccess(decodeTransaction(hexToBin(result as string)));
                const outputs_bytecode = la_tx.outputs.map((a) => a.lockingBytecode);
                const zeroth_utxo_txhash_list: Uint8Array[] = la_tx.inputs.filter((a) => a.outpointIndex === 0).map((a) => a.outpointTransactionHash);
                const tx_data = {
                  txhash: hexToBin(item_txid),
                  zeroth_utxo_txhash_list, outputs_bytecode,
                  height: response_item.height,
                };
                if (target_tx == null) {
                  for (const txhash of tx_data.zeroth_utxo_txhash_list) {
                    if (uint8ArrayEqual(txhash, tmp.txhash)) {
                      target_tx = tx_data;
                      abort_controller.abort();
                    }
                  }
                }
                bcmrMemDBSetLockingBytecodeTxData(memdb, first_locking_bytecode, tx_data);
              } catch (error) {
                console.warn('AAA', {item_txid, result}, error);
                reject(error as Error);
              }
            },
          };
        }
      }).filter((a) => !!a);
      if (get_tx_requests.length > 0) {
        client.enqueueElectrumBatchRequests('bcmr-indexer', get_tx_requests, {
          abort_signal: abort_controller.signal,
        });
        await Promise.all(promises);
      }
    }
    if (target_tx == null) {
      // first output is unspent
      break;
    }
    tmp = {
      txhash: target_tx.txhash,
      outputs_bytecode: target_tx.outputs_bytecode,
      bcmr: parseBCMRFromBytecodes(target_tx.outputs_bytecode),
      height: target_tx.height > 0 ? target_tx.height : undefined,
    };
    mem.chain.push(tmp);
    await bcmrMemDBSetAuthChain(memdb, authbase_txhash, mem);
    if (mem.indexing_cost > max_indexing_cost) {
      break;
    }
  }

  return { chain: mem.chain.map((a) => ({ txhash: a.txhash, bcmr: a.bcmr })) };
}

export function urlFromBCMROPReturnUrl (uri: string, params: { ipfs_endpoint?: string }): string {
  const url_with_no_protocol = uri.indexOf('://') == -1;
  if (url_with_no_protocol) {
    return 'https://' + uri;
  }
  const endpoint_url = new URL(uri);
  if (endpoint_url.protocol === 'ipfs:' && params.ipfs_endpoint != null) {
    return params.ipfs_endpoint + endpoint_url.host + (
      endpoint_url.pathname.length > 0 && endpoint_url.pathname !== '/' ?
        endpoint_url.pathname : ''
    );
  }
  return uri;
};

export async function fetchBCMRContents (urls: string[]): Promise<Uint8Array> {
  const getHttpsUrl =  (urls: string[]): string | null => {
    const https_url = urls.find((a) => a.startsWith('https://'));
    if (https_url != null) {
      return https_url;
    }
    return null;
  };
  const content_https_url = getHttpsUrl(urls);
  if (content_https_url == null) {
    throw new ValueError(`The bcmr has no https url!`);
  }
  const response = await window.fetch(content_https_url);
  if (response.status !== 200) {
    const text = await response.text();
    throw new ValueError(`Failed loading token BCMR, Expecting 200 OK response from https request, url: ${content_https_url} , got: ${response.status}, output body: ${text.substring(0,200)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function validateBCMRRegistry (content: Uint8Array, content_hash: Uint8Array): Registry {
  if (!uint8ArrayEqual(content_hash, sha256.hash(content))) {
    throw new ValueError(`The content of http response does not match with the authenticated data (content_hash).`);
  }
  let registry: Registry;
  try {
    const decoder = new TextDecoder('utf-8');
    registry = JSON.parse(decoder.decode(content));
  } catch (err) {
    throw new ValueError(`Failed to parse token BCMR.`, { cause: err })
  }
  return registry;
}

export async function fetchAndVerifyBCMRContents (bcmr_opreturn_data: BCMROPReturnData): Promise<Registry> {
  const body = await fetchBCMRContents(bcmr_opreturn_data.urls);
  return validateBCMRRegistry(body, bcmr_opreturn_data.content_hash);
}

export function pullTokenIdentitySnapshotFromRegistry (registry: Registry, token_id: TokenId, dt: Date): IdentitySnapshot {
   // register tokens, requires that authbase to be equal category
  for (const [ authbase, history ] of Object.entries(registry.identities || {})) {
    for (const identity of Object.values(history)) {
      if (identity.token && identity.token.category != token_id) {
        throw new Error(`The input identity has one or more category that do not match with the target token_id.`);
      }
    }
    const history_entries: Array<{ key: string, date: Date, snapshot: IdentitySnapshot }> = Object.keys(history).map((key) => ({ key, date: new Date(key), snapshot: history[key] as IdentitySnapshot }))
      .filter((a) => a.snapshot != null)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    const target_entry = history_entries.filter((a) => a.date <= dt)[0];
    if (!target_entry) {
      throw new Error('The identity does not have a current identity, This error may be caused by having an incorrect time in your local machine.');
    }
    const target_identity = target_entry.snapshot;
    if (!target_identity.token) {
      throw new Error('The current identity of the token has no token!');
    }
    if (target_identity.token.category != token_id) {
      throw new Error(`The defined identity.token.category does not match the input token_id!`);
    }
    return target_identity;
  }
  throw new ValueError(`Identity for the target token is not defined!`);
}
