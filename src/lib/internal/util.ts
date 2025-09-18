import type { UTXO } from '@cashlab/common';
import { hexToBin, binToHex } from '@cashlab/common/libauth.js';

export const parseElectrumUTXO = (eutxo: any): UTXO => {
  if (eutxo.has_token && !eutxo.token_data) {
    throw new Error('eutxo has_token = true and token_data is null');
  }
  return {
    outpoint: { txhash: hexToBin(eutxo.tx_hash), index: eutxo.tx_pos },
    output: {
      locking_bytecode: typeof eutxo.locking_bytecode == 'string' ? binToHex(eutxo.locking_bytecode) : eutxo.locking_bytecode,
      amount: BigInt(eutxo.value),
      token: eutxo.token_data ? {
        amount: BigInt(eutxo.token_data.amount),
        token_id: eutxo.token_data.category,
        nft: eutxo.token_data.nft ? {
          capability: eutxo.token_data.nft.capability,
          commitment: hexToBin(eutxo.token_data.nft.commitment),
        } : undefined,
      } : undefined,
    },
    block_height: eutxo.height > 0 ? eutxo.height : undefined,
  };
};

export function deferredPromise<T> (): Promise<{ promise: Promise<T>, resolve: (result: T) => void, reject: (error: any) => void }> {
  return new Promise(function (onready) {
    let promise: Promise<T> | null = null, resolve: ((result: T) => void) | null = null, reject: ((error: any) => void) | null = null, did_call_ready: boolean = false;
    promise = new Promise((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
      if (promise && !did_call_ready) {
        did_call_ready = true;
        onready({promise,resolve,reject});
      }
    });
    if (resolve && reject && !did_call_ready) {
      did_call_ready = true;
      onready({promise,resolve,reject});
    }
  });
}

export const createMainIndexedDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open('main', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('wallet-state-addresses', { keyPath: 'id' });
      db.createObjectStore('token-bcmr-contents', { keyPath: 'id' });
      db.createObjectStore('bcmr-auth-chain-mem', { keyPath: 'id' });
    };
    request.onerror = () => {
      reject(request.error);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
};

export const publicKeyHashToP2pkhLockingBytecode = (pkh: Uint8Array): Uint8Array => {
  const lbc = hexToBin('76a914000000000000000000000000000000000000000088ac');
  lbc.set(pkh, 3);
  return lbc;
};

