import {
  assertSuccess, binToHex,
  deriveHdPrivateNodeFromBip39Mnemonic,
  secp256k1, deriveHdPath, publicKeyToP2pkhLockingBytecode,
  lockingBytecodeToCashAddress,
  hash160,
} from '@cashlab/common/libauth.js';
import type {
  HdPrivateNodeValid,
} from '@cashlab/common/libauth.js';
import { Exception, ValueError, InvalidProgramState, NotImplemented, NATIVE_BCH_TOKEN_ID } from '@cashlab/common';
import type { UTXO } from '@cashlab/common';
import type {
  WalletState, ListProxy, MapProxy, ValueProxy, AddressInfo, AddressState,
  TokenBalance, TokenIdentity, WalletUTXOEntry,
  P2PKHWallet, Wallet, P2PKHWatchWallet, HdWallet,
} from './types.js';
import type { RPCNotification as ElectrumRPCNotification } from '@electrum-cash/network';
import type { BCHElectronClient } from './internal/bch-electron-client.js';
import type { default as UTXOTracker, UTXOTrackerLockingBytecodeEntry } from './internal/utxo-tracker.js';
import { publicKeyHashToP2pkhLockingBytecode } from './internal/util.js';


type DBHdWalletStateAddressRecord = {
  id: string;
  index: number;
  is_change: boolean;
  is_used: boolean;
};

export type WalletStateProxy = {
  address_list: ListProxy<{ value: AddressInfo, state: AddressState }>;
  utxo_map: MapProxy<string, WalletUTXOEntry>;
  error: ValueProxy<string>;
  balances: ListProxy<TokenBalance>;
}

export class WalletStateManager extends EventTarget {
  wallet: Wallet;
  state_proxy: WalletStateProxy;
  utxo_tracker: UTXOTracker;
  utxo_tracker_entry_map: Map<string, UTXOTrackerLockingBytecodeEntry>;
  db: IDBDatabase;
  constructor (wallet: Wallet, state_proxy: WalletStateProxy, utxo_tracker: UTXOTracker, db: IDBDatabase) {
    super();
    this.db = db;
    this.wallet = wallet;
    this.state_proxy = state_proxy;
    this.utxo_tracker = utxo_tracker;
    this.utxo_tracker_entry_map = new Map();
    // bind event listeners
    for (const name of [ 'onTrackerSubscriptionStatusChange', 'onTrackerEntryUpdate' ]) {
      (this as any)[name] = (this as any)[name].bind(this);
    }
    this.state_proxy.address_list.init([]);
    this.state_proxy.utxo_map.init([]);
    this.state_proxy.balances.init([
      {
        token_id: NATIVE_BCH_TOKEN_ID,
        amount: 0n,
      },
    ]);
  }
  async destroy (): Promise<void> {
    for (const entry of this.utxo_tracker_entry_map.values()) {
      {
        const idx = entry.update_listeners.indexOf(this.onTrackerEntryUpdate);
        if (idx !== -1) {
          entry.update_listeners.splice(idx, 1);
        }
      }
      {
        const idx = entry.subscription_status_change_listeners.indexOf(this.onTrackerSubscriptionStatusChange);
        if (idx !== -1) {
          entry.subscription_status_change_listeners.splice(idx, 1);
        }
      }
    }
    this.utxo_tracker_entry_map = new Map();
  }
  setNeedsUpdate (): void {
    if ((this as any).__needs_update_timeout != null) {
      return;
    }
    (this as any).__needs_update_timeout = setTimeout(() => {
      delete (this as any).__needs_update_timeout;
      this.update();
    }, 300);
  }
  onWalletDataChange (wallet: Wallet): void {
    if (wallet.id !== wallet.id) {
      throw new Error(`WalletStateManager::onWalletDataChange, should not change wallet.id!`);
    }
    this.wallet = wallet;
  }
  includeLockingBytecode (locking_bytecode: Uint8Array): UTXOTrackerLockingBytecodeEntry {
    const entry_id = binToHex(locking_bytecode);
    let entry = this.utxo_tracker_entry_map.get(entry_id);
    if (entry == null) {
      entry = this.utxo_tracker.addTrackerByLockingBytecode(locking_bytecode);
      entry.update_listeners.push(this.onTrackerEntryUpdate);
      entry.subscription_status_change_listeners.push(this.onTrackerSubscriptionStatusChange);
      this.utxo_tracker_entry_map.set(entry_id, entry);
      const address = {
        id: entry_id,
        cashaddr: entry.cashaddr,
        locking_bytecode,
        subscribed: !!entry.active_sub,
      };
      const address_state = {
        utxo_set: [],
        excluded_utxo_outpoints: new Set<string>(),
      };
      this.state_proxy.address_list.insert(this.state_proxy.address_list.getCount(), { value: address, state: address_state });
      if (entry.data != null) {
        this.onTrackerEntryUpdate(entry, entry.data);
      }
    }
    return entry;
  }
  removeLockingBytecode (locking_bytecode: Uint8Array): void {
    const entry_id = binToHex(locking_bytecode);
    const entry = this.utxo_tracker_entry_map.get(entry_id);
    if (entry != null) {
      this.utxo_tracker_entry_map.delete(entry_id);
    }
    const item = this.state_proxy.address_list.getItem(entry_id);
    if (item != null) {
      for (const utxo of item.state.utxo_set) {
        const id = binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index;
        this.state_proxy.utxo_map.delete(id);
      }
      const changes: Array<{ type: 'remove', utxo: UTXO }> = item.state.utxo_set
        .filter((utxo) => !item.state.excluded_utxo_outpoints.has(binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index))
        .map((utxo) => ({ type: 'remove', utxo }));
      if (changes.length > 0) {
        this.onUpdateBalance(changes);
      }
      this.state_proxy.address_list.remove(entry_id);
    }
  }
  update (): Promise<void> {
    throw new NotImplemented('');
  }
  onTrackerSubscriptionStatusChange (entry: UTXOTrackerLockingBytecodeEntry): void {
    const entry_id = binToHex(entry.locking_bytecode);
    const item = this.state_proxy.address_list.getItem(entry_id);
    if (item != null) {
      item.value.subscribed = !!entry.active_sub;
    }
  }
  onTrackerEntryUpdate (entry: UTXOTrackerLockingBytecodeEntry, utxo_set: UTXO[]): void {
    const entry_id = binToHex(entry.locking_bytecode);
    const address_item = this.state_proxy.address_list.getItem(entry_id);
    if (address_item != null) {
      const changes: Array<{ type: 'add' | 'remove', utxo: UTXO }> = [];
      const excluded_utxo_outpoints = new Set<string>();
      const known_excluded_utxo_outpoints = address_item.state.excluded_utxo_outpoints;
      const known_outpoint_set = new Set<string>();
      const new_outpoint_set = new Set<string>();
      for (const utxo of address_item.state.utxo_set) {
        const outpoint = binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index;
        known_outpoint_set.add(outpoint);
      }
      for (const utxo of utxo_set) {
        // nfts are not supported yet!
        const should_exclude = utxo.output.token?.nft != null;
        const outpoint = binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index;
        new_outpoint_set.add(outpoint);
        if (should_exclude) {
          excluded_utxo_outpoints.add(outpoint);
        }
        if (!known_outpoint_set.has(outpoint)) {
          // add utxo
          this.state_proxy.utxo_map.set(outpoint, { utxo, address: address_item.value });
          if (!should_exclude) {
            changes.push({ type: 'add', utxo });
          }
        }
      }
      // removed utxos
      for (const known_outpoint of known_outpoint_set) {
        if (!new_outpoint_set.has(known_outpoint)) {
          // remove utxo
          const utxo_entry = this.state_proxy.utxo_map.get(known_outpoint);
          if (utxo_entry == null) {
            throw new InvalidProgramState('remove utxo, utxo_map.get(known_outpoint) is null!');
          }
          this.state_proxy.utxo_map.delete(known_outpoint);
          if (!known_excluded_utxo_outpoints.has(known_outpoint)) {
            changes.push({ type: 'remove', utxo: utxo_entry.utxo });
          }
        }
      }
      address_item.state.utxo_set = utxo_set;
      address_item.state.excluded_utxo_outpoints = excluded_utxo_outpoints;
      if (changes.length > 0) {
        this.onUpdateBalance(changes);
      }
    }
  }
  onUpdateBalance (changes: Array<{ type: 'add' | 'remove', utxo: UTXO }>): void {
    const known_tokens = this.state_proxy.balances.getKeys().filter((a) => a !== NATIVE_BCH_TOKEN_ID);
    const native_bch_balance = this.state_proxy.balances.getItem(NATIVE_BCH_TOKEN_ID);
    if (native_bch_balance == null) {
      throw new InvalidProgramState('native_bch_balance == null');
    }
    for (const change of changes) {
      if (change.type === 'add') {
        native_bch_balance.amount += change.utxo.output.amount;
      } else if (change.type === 'remove') {
        native_bch_balance.amount -= change.utxo.output.amount;
      }
      if (change.utxo.output.token != null) {
        const token_id = change.utxo.output.token.token_id;
        let token_balance: TokenBalance = this.state_proxy.balances.getItem(token_id) as TokenBalance;
        if (token_balance == null) {
          token_balance = this.state_proxy.balances.insert(this.state_proxy.balances.getCount(), {
            token_id,
            amount: 0n,
          });
        }
        if (change.type === 'add') {
          token_balance.amount += change.utxo.output.token.amount;
        } else if (change.type === 'remove') {
          token_balance.amount -= change.utxo.output.token.amount;
        }
      }
    }
    for (const token_id of this.state_proxy.balances.getKeys()) {
      const token_balance = this.state_proxy.balances.getItem(token_id);
      if (!((token_balance?.amount as bigint) >= 0n)) {
        throw new InvalidProgramState(`balance of a token is negative or invalid!!, token_id: ${token_id}, value: ${token_balance?.amount}`);
      }
    }
    for (const token_id of known_tokens) {
      const token_balance = this.state_proxy.balances.getItem(token_id);
      if ((token_balance?.amount as bigint) === 0n) {
        this.state_proxy.balances.remove(token_id);
      }
    }
  }
}

export class P2PKHWalletStateManager extends WalletStateManager {
  wallet: P2PKHWallet | P2PKHWatchWallet;
  main_entry: UTXOTrackerLockingBytecodeEntry | null;
  constructor (wallet: Wallet, state_proxy: WalletStateProxy, utxo_tracker: UTXOTracker, db: IDBDatabase) {
    super(wallet, state_proxy, utxo_tracker, db);
    this.wallet = wallet as any; // relax the static type check, the check occurs dynamically
    try {
      if (['p2pkh', 'p2pkh-watch'].indexOf(this.wallet.type) === -1) {
        throw new ValueError(`wallet type should be p2pkh or p2pkh-watch, got: ${this.wallet.type}`);
      }
    } catch (err) {
      console.warn('wallet state init fail, wallet_name: ', this.wallet.name, err);
      this.state_proxy.error.set(`${(err as any).name}: ${(err as any).message}`);
    }
    this.main_entry = null;
    this.update();
  }
  async destroy (): Promise<void> {
    await super.destroy();
    this.main_entry = null;
  }
  async update (): Promise<void> {
    try {
      this.main_entry = this.includeLockingBytecode(publicKeyHashToP2pkhLockingBytecode(this.wallet.pkh));
      this.dispatchEvent(new Event('update'));
    } catch (err) {
      console.warn('wallet state update fail, wallet_name: ', this.wallet.name, err);
      this.state_proxy.error.set(`${(err as any).name}: ${(err as any).message}`);
    }
  }
}

export class HdWalletStateManager extends WalletStateManager {
  wallet: HdWallet;
  node?: HdPrivateNodeValid;
  last_main_index: number;
  last_change_index: number;
  extend_watch_count: number;
  use_detected_pending_items: Array<{ is_change: boolean, index: number, run: () => void }>;
  pending_update: Promise<void> | undefined;
  client: BCHElectronClient | null;
  constructor (wallet: Wallet, state_proxy: WalletStateProxy, utxo_tracker: UTXOTracker, db: IDBDatabase) {
    super(wallet, state_proxy, utxo_tracker, db);
    this.wallet = wallet as any; // relax the static type check, the check occurs dynamically
    this.client = null;
    this.last_main_index = -1;
    this.last_change_index = -1;
    this.extend_watch_count = 20;
    this.use_detected_pending_items = [];
    try {
      if (['hd'].indexOf(this.wallet.type) === -1) {
        throw new ValueError(`wallet type is expected to be "hd", got: ${this.wallet.type}`);
      }
      this.node = deriveHdPrivateNodeFromBip39Mnemonic(this.wallet.seed, { passphrase: this.wallet.passphrase });
    } catch (err) {
      console.warn('wallet state init fail, wallet_name: ', this.wallet.name, err);
      this.state_proxy.error.set(`${(err as any).name}: ${(err as any).message}`);
    }
    this.update();
  }
  onClientConnected (client: BCHElectronClient): void {
    this.client = client;
    this.setNeedsUpdate();
  }
  onClientDisconnected (client: BCHElectronClient): void {
    if (this.client !== client) {
      return;
    }
    this.client = null;
  }
  indexToFixedSizeString (index: number): string {
    const b = new ArrayBuffer(4);
    (new DataView(b)).setUint32(0, index);
    return binToHex(new Uint8Array(b));
  }
  useDetected (item: { is_change: boolean, index: number }): void {
    const run = async () => {
      try {
        // only one instance is running at a time
        let target_recorded_item: DBHdWalletStateAddressRecord | null = null;
        const target_item_key = `w:${this.wallet.id}>${item.is_change?'C':'M'}>${this.indexToFixedSizeString(item.index)}`;
        const keys: Set<string> = new Set();
        await new Promise<void>((resolve, reject) => {
          const dbtx = this.db.transaction('wallet-state-addresses', 'readonly');
          const db_wallet_addresses = dbtx.objectStore('wallet-state-addresses');
          const request = db_wallet_addresses.openCursor(IDBKeyRange.bound(`w:${this.wallet.id}>${item.is_change?'C':'M'}>${this.indexToFixedSizeString(0)}`, target_item_key));
          request.onsuccess = () => {
            const cursor = request.result
            if (cursor != null) {
              keys.add(cursor.value.id);
              if (cursor.value.id === target_item_key) {
                target_recorded_item = cursor.value;
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          request.onerror = () => {
            reject(request.error);
          };
        });
        // insert
        await new Promise<void>((resolve, reject) => {
          const dbtx = this.db.transaction('wallet-state-addresses', 'readwrite');
          const db_wallet_addresses = dbtx.objectStore('wallet-state-addresses');
          const onDBRequest = (request: IDBRequest): void => {
            request.onerror = () => {
              reject(request.error);
            };
          };
          let request;
          // insert missing items
          for (let i = 0; i < item.index; i++) {
            const key = `w:${this.wallet.id}>${item.is_change?'C':'M'}>${this.indexToFixedSizeString(i)}`;
            if (!keys.has(key)) {
              db_wallet_addresses.add({ id: key, index: i, is_change: item.is_change, is_used: false });
            }
          }
          let did_change_to_is_used = false;
          if (target_recorded_item != null) {
            did_change_to_is_used = !target_recorded_item.is_used;
            target_recorded_item.is_used = true;
            onDBRequest(db_wallet_addresses.put(target_recorded_item));
          } else {
            did_change_to_is_used = true;
            onDBRequest(db_wallet_addresses.add({ id: target_item_key, index: item.index, is_change: item.is_change, is_used: true }));
          }
          if (did_change_to_is_used) {
            this.setNeedsUpdate();
          }
          dbtx.oncomplete = () => {
            resolve();
          };
        });
      } catch (err) {
        console.warn(`useDetected action fail!!, wallet_name: `, this.wallet.name,  err);
      } finally {
        // done
        const idx = this.use_detected_pending_items.findIndex((a) => item.is_change === a.is_change && item.index === a.index);
        if (idx !== -1) {
          this.use_detected_pending_items.splice(idx, 1);
        }
        // next item
        const next = this.use_detected_pending_items.shift()
        if (next != null) {
          setTimeout(next.run);
        }
      }
    };
    const should_run = this.use_detected_pending_items.length === 0;
    const existing_item = this.use_detected_pending_items.find((a) => item.is_change === a.is_change && item.index === a.index);
    if (existing_item != null) {
      return;
    }
    this.use_detected_pending_items.push({ ...item, run });
    if (should_run) {
      run();
    }
  }
  update (): Promise<void> {
    const run = async () => {
      // only one instance is running at a time
      try {
        const promises: Array<Promise<void>> = [];
        const included_locking_bytecode_set: Set<string> = new Set();
        const addItem = (is_used: boolean, is_change: boolean, index: number) => {
          if (this.node == null) {
            throw new ValueError(`hd wallet's node is not defined!`);
          }
          const item_private_key = assertSuccess(deriveHdPath(this.node, this.wallet.derivation_path + '/' + (is_change ? '1' : '0') + '/' + index)).privateKey;
          const item_public_key = assertSuccess(secp256k1.derivePublicKeyCompressed(item_private_key));
          const item_locking_bytecode = assertSuccess(publicKeyToP2pkhLockingBytecode({ publicKey: item_public_key }));
          this.includeLockingBytecode(item_locking_bytecode);
          included_locking_bytecode_set.add(binToHex(item_locking_bytecode));
          if (!is_used && this.client != null) {
            // detect used
            promises.push((async () => {
              try {
                const client = this.client as BCHElectronClient;
                const item_cashaddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: item_locking_bytecode })).address;
                const result = await client.electrumRequest('blockchain.address.get_first_use', item_cashaddr);
                if (result != null) {
                  this.useDetected({ is_change, index });
                }
              } catch (err) {
                console.warn('HdWalletState::update, addItem promise fail!, wallet_name: ' + this.wallet.name, err);
              }
            })());
          }
        };
        await new Promise<void>((resolve, reject) => {
          const dbtx = this.db.transaction('wallet-state-addresses', 'readwrite');
          const db_wallet_addresses = dbtx.objectStore('wallet-state-addresses');
          const request = db_wallet_addresses.openCursor(IDBKeyRange.bound(`w:${this.wallet.id}>`, `w:${this.wallet.id}|`));
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor != null) {
              const item = cursor.value;
              addItem(item.is_used, item.is_change, item.index);
              if (!item.is_change) {
                if (item.index > this.last_main_index) {
                  this.last_main_index = item.index;
                }
              } else {
                if (item.index > this.last_change_index) {
                  this.last_change_index = item.index;
                }
              }
              cursor.continue();
            } else {
              // end
              resolve();
            }
          };
          request.onerror = () => {
            reject(request.error);
          };
        });
        // extend watch
        for (let index = this.last_main_index + 1; index <= this.last_main_index + this.extend_watch_count; index++) {
          addItem(false, false, index);
        }
        for (let index = this.last_change_index + 1; index <= this.last_change_index + this.extend_watch_count; index++) {
          addItem(false, true, index);
        }
        await Promise.all(promises);
        this.dispatchEvent(new Event('update'));
      } catch (err) {
        console.warn('wallet state update fail, wallet_name: ', this.wallet.name, err);
        this.state_proxy.error.set(`${(err as any).name}: ${(err as any).message}`);
      } finally {
        if (promise === this.pending_update) {
          this.pending_update = undefined;
        }
      }
    };
    const promise = (this.pending_update != null ? this.pending_update : Promise.resolve())
                      .then(run, run);
    return this.pending_update = promise;
  }
  getAddress ({ index, is_change }: { index: number, is_change: boolean }): { locking_bytecode: Uint8Array, pkh: Uint8Array, index: number, is_change: boolean } {
    if (this.node == null) {
      throw new ValueError(`hd wallet's node is not defined!`);
    }
    if (typeof is_change !== 'boolean') {
      throw new ValueError(`input param is_change should be a boolean`);
    }
    if (typeof index !== 'number' || index !== Math.floor(index) ||
        index < 0) {
      throw new ValueError(`input param index should be positive interger`);
    }
    const private_key = assertSuccess(deriveHdPath(this.node, this.wallet.derivation_path + '/' + (is_change ? '1' : '0') + '/' + index)).privateKey;
    const public_key = assertSuccess(secp256k1.derivePublicKeyCompressed(private_key));
    const locking_bytecode = assertSuccess(publicKeyToP2pkhLockingBytecode({ publicKey: public_key }));
    const pkh = hash160(public_key);
    return { locking_bytecode, pkh, index, is_change };
  }

  getUnusedAddress ({ is_change }: { is_change: boolean }): { locking_bytecode: Uint8Array, pkh: Uint8Array, index: number, is_change: boolean } {
    if (this.node == null) {
      throw new ValueError(`hd wallet's node is not defined!`);
    }
    return this.getAddress({ index: this.last_main_index + 1, is_change });
  }
}
