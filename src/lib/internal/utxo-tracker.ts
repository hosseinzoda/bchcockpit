import type {
  RPCNotification as ElectrumRPCNotification, 
} from '@electrum-cash/network';
import type { BCHElectronClient } from './bch-electron-client.js';
import type { UTXO } from '@cashlab/common';
import { assertSuccess, lockingBytecodeToCashAddress } from '@cashlab/common/libauth.js';
import { deferredPromise, parseElectrumUTXO } from './util.js';
import type { TimeoutId } from './types.js';


export type UTXOTrackerRefId = string;

export type UTXOTrackerLockingBytecodeEntry = {
  type: 'locking_bytecode';
  locking_bytecode: Uint8Array;
  cashaddr: string;
  pending_request: Promise<any> | null,
  data: UTXO[] | null,
  error: any;
  initialized: boolean;
  active_sub: boolean;
  update_listeners: Array<(entry: UTXOTrackerLockingBytecodeEntry, utxo_set: UTXO[]) => void>;
  subscription_status_change_listeners: Array<(entry: UTXOTrackerLockingBytecodeEntry) => void>;
};

export type UTXOTrackerEntry = |
  UTXOTrackerLockingBytecodeEntry;

export default class UTXOTracker {
  client: BCHElectronClient | null;
  cashaddr_finalization_registry: FinalizationRegistry<any>;
  cashaddr_entries_ref: Map<string, WeakRef<UTXOTrackerEntry>>;
  cached_entries: Array<{ nouse_timeout_id: TimeoutId | null, value: UTXOTrackerEntry }>;
  subscribed_cashaddrs: Set<string>;
  constructor () {
    this.client = null;
    this.cashaddr_entries_ref = new Map();
    this.cached_entries = [];
    this.subscribed_cashaddrs = new Set();
    this.cashaddr_finalization_registry = new FinalizationRegistry((cashaddr: string) => {
      this.cashaddr_entries_ref.delete(cashaddr);
      if (this.subscribed_cashaddrs.has(cashaddr)) {
        this.subscribed_cashaddrs.delete(cashaddr);
        if (this.client != null) {
          this.client.electrumUnsubscribe('blockchain.address.subscribe', cashaddr);
        }
      }
    });
  }
  async destroy () {
    for (const { nouse_timeout_id } of this.cached_entries) {
      if (nouse_timeout_id != null) {
        clearTimeout(nouse_timeout_id);
      }
    }
    for (const ref of this.cashaddr_entries_ref.values()) {
      const entry = ref.deref()
      if (entry != null) {
        this.cashaddr_finalization_registry.unregister(entry);
      }
    }
    this.cashaddr_entries_ref = new Map();
    if (this.client != null) {
      await Promise.all(Array.from(this.subscribed_cashaddrs).map((a) => this.client != null  && this.client.electrumUnsubscribe('blockchain.address.subscribe', a)));
    }
    this.client = null;
    this.subscribed_cashaddrs = new Set();
    this.cached_entries = [];
  }
  onClientConnected (client: BCHElectronClient): void {
    this.client = client;
    for (const [ cashaddr, ref ] of this.cashaddr_entries_ref.entries()) {
      const entry = ref.deref();
      if (entry != null) {
        this.initEntry(entry);
      } else {
        this.cashaddr_entries_ref.delete(cashaddr);
      }
    }
  }
  onClientDisconnected (client: BCHElectronClient): void {
    if (this.client !== client) {
      return;
    }
    this.client = null;
    for (const [ cashaddr, ref ] of this.cashaddr_entries_ref.entries()) {
      const entry = ref.deref();
      if (entry != null) {
        entry.initialized = false;
        entry.active_sub = false;
        for (const listener of entry.subscription_status_change_listeners) {
          listener(entry);
        }
        entry.pending_request = null;
        entry.data = null
      } else {
        this.cashaddr_entries_ref.delete(cashaddr);
      }
    }
  }
  onElectrumNotification (message: ElectrumRPCNotification): void {
    switch (message.method) {
      case 'blockchain.address.subscribe': {
        if (message.params == null || typeof message.params[0] != 'string') {
          return;
        }
        const cashaddr: string = message.params[0];
        const entry_ref = this.cashaddr_entries_ref.get(cashaddr);
        if (entry_ref != null) {
          const entry = entry_ref.deref();
          if (entry != null && entry.initialized) {
            this.reloadEntryData(entry);
          }
        }
        break;
      }
    }
  }
  async initEntry (entry: UTXOTrackerEntry) {
    if (entry.type != 'locking_bytecode') {
      throw new Error('Unknown entry type=locking_bytecode');
    }
    const { promise: pending_promise, resolve } = await deferredPromise<void>();
    entry.error = null;
    entry.pending_request = pending_promise;
    (async () => {
      try {
        if (this.client == null) {
          throw new Error(`client is null!`);
        }
        await this.client.electrumSubscribe('blockchain.address.subscribe', entry.cashaddr)
        entry.active_sub = true;
        for (const listener of entry.subscription_status_change_listeners) {
          listener(entry);
        }
        if (entry.pending_request != pending_promise) {
          await entry.pending_request;
          return; // exit
        }
        const result = await this.client.electrumRequest('blockchain.address.listunspent', entry.cashaddr, 'include_tokens');
        if (entry.pending_request != pending_promise) {
          return; // exit
        }
        if (!Array.isArray(result)) {
          throw new Error('Expecting response of blockchain.address.listunspent to be an array');
        }
        entry.initialized = true;
        for (const item of result) {
          item.locking_bytecode = entry.locking_bytecode;
        }
        entry.data = result.map(parseElectrumUTXO);
        for (const listener of entry.update_listeners) {
          listener(entry, entry.data);
        }
      } catch (err) {
        console.warn(`UTXOTracker initEntry fail, cashaddr: ${entry.cashaddr}, error: `, err);
        if (entry.pending_request != pending_promise) {
          await entry.pending_request;
          return; // exit
        }
        entry.error = err;
        entry.data = null;
      } finally {
        entry.pending_request = null;
        resolve();
      }
    })();
    await pending_promise;
  }
  async reloadEntryData (entry: UTXOTrackerEntry) {
    if (entry.type != 'locking_bytecode') {
      throw new Error('Unknown entry type=locking_bytecode');
    }
    const { promise: pending_promise, resolve } = await deferredPromise<void>();
    entry.error = null;
    entry.pending_request = pending_promise;
    ;(async () => {
      try {
        if (this.client == null) {
          throw new Error(`client is null!`);
        }
        const result = await this.client.electrumRequest('blockchain.address.listunspent', entry.cashaddr, 'include_tokens');
        if (entry.pending_request != pending_promise) {
          await entry.pending_request;
          return; // exit
        }
        if (!Array.isArray(result)) {
          throw new Error('Expecting response of blockchain.address.listunspent to be an array');
        }
        for (const item of result) {
          item.locking_bytecode = entry.locking_bytecode;
        }
        entry.data = result.map(parseElectrumUTXO);
        for (const listener of entry.update_listeners) {
          listener(entry, entry.data);
        }
      } catch (err) {
        if (entry.pending_request != pending_promise) {
          await entry.pending_request;
          return; // exit
        }
        entry.error = err;
        entry.data = null;
      } finally {
        entry.pending_request = null;
        resolve();
      }
    })();
    return await pending_promise;
  }
  async addTrackerByLockingBytecodeAwaitInit (locking_bytecode: Uint8Array): Promise<UTXOTrackerEntry> {
    const network_prefix = 'bitcoincash';
    const cashaddr = assertSuccess(lockingBytecodeToCashAddress({
      bytecode: locking_bytecode,
      prefix: network_prefix,
      tokenSupport: false,
    })).address;
    let entry = this.getTrackerEntryByCashAddr(cashaddr);
    if (entry != null) {
      if (entry.pending_request != null) {
        await entry.pending_request;
      }
      return entry;
    }
    entry = this.addTrackerByLockingBytecode(locking_bytecode);
    if (this.client != null) {
      await this.initEntry(entry);
    }
    return entry;
  }
  addTrackerByLockingBytecode (locking_bytecode: Uint8Array): UTXOTrackerEntry {
    const network_prefix = 'bitcoincash';
    const cashaddr = assertSuccess(lockingBytecodeToCashAddress({
      bytecode: locking_bytecode,
      prefix: network_prefix,
      tokenSupport: false,
    })).address;
    let entry = this.getTrackerEntryByCashAddr(cashaddr);
    if (entry != null) {
      return entry;
    }
    entry = {
      type: 'locking_bytecode',
      locking_bytecode,
      cashaddr,
      pending_request: null,
      data: null,
      error: null,
      initialized: false,
      active_sub: false,
      update_listeners: [],
      subscription_status_change_listeners: [],
    };
    this.cashaddr_entries_ref.set(cashaddr, new WeakRef(entry));
    this.cashaddr_finalization_registry.register(entry, cashaddr);
    if (this.client != null) {
      this.initEntry(entry);
    }
    return entry;
  }
  getTrackerEntryByCashAddr (cashaddr: string): UTXOTrackerEntry | undefined {
    const ref = this.cashaddr_entries_ref.get(cashaddr);
    return ref != null ? ref.deref() : undefined;
  }
  async getEntryUTXOList (entry: UTXOTrackerEntry): Promise<UTXO[]> {
    const matched_ref_value = this.cashaddr_entries_ref.get(entry.cashaddr)
    if (!matched_ref_value || matched_ref_value.deref() != entry) {
      throw new Error('The entry is not registered');
    }
    if (entry.pending_request != null) {
      await entry.pending_request;
    }
    if (entry.data == null && this.client != null) {
      await this.initEntry(entry);
    }
    this.onEntryUsed(entry);
    return entry.data || [];
  }
  onEntryUsed (entry: UTXOTrackerEntry): void {
    const cached_entry = this.cached_entries.find((a) => a.value == entry);
    if (cached_entry != null) {
      if (cached_entry.nouse_timeout_id != null) {
        clearTimeout(cached_entry.nouse_timeout_id);
      }
      const NOUSE_TIMEOUT_DURATION = 10 * 60 * 1000
      cached_entry.nouse_timeout_id = setTimeout(() => {
        const cached_entry_idx = this.cached_entries.findIndex((a) => a.value == entry);
        if (cached_entry_idx != -1) {
          this.cached_entries.splice(cached_entry_idx, 1);
        }
      }, NOUSE_TIMEOUT_DURATION);
    }
  }
  async getUTXOListForLockingBytecode (locking_bytecode: Uint8Array): Promise<UTXO[]> {
    const entry = await this.addTrackerByLockingBytecodeAwaitInit(locking_bytecode);
    const idx = this.cached_entries.findIndex((a) => a.value == entry);
    if (idx == -1) {
      this.cached_entries.push({ nouse_timeout_id: null, value: entry });
    }
    return await this.getEntryUTXOList(entry);
  }
}


