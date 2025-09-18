import { Exception, ValueError, InvalidProgramState } from './internal/exceptions.js';
import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common';
import type { TokenId, Fraction } from '@cashlab/common';
import type {
  Wallet, WalletState, AddressInfo, AddressState, WalletUTXOEntry,
  TokenIdentity, TokenIdentityWithState, TokenIdentityLoaderState, TokenIdentityLoaderRequestStatus,
  TokenBalance,
} from './types.js';
import type { WalletStore } from './wallet-store.js';
import { WalletStoreRuntime, WalletStoreNotSupported } from './wallet-store.js';
import type { RPCNotification as ElectrumRPCNotification } from '@electrum-cash/network';
import type { BCHElectronClient } from './internal/bch-electron-client.js';
import { BCHElectronClientRuntime, BCHElectronClientNotSupported } from './internal/bch-electron-client.js';
import type { BCHElectronClientParameters } from './internal/bch-electron-client.js';
import UTXOTracker from './internal/utxo-tracker.js';
import type { TokenRegistryManager } from './token-registry-manager';
import { TokenRegistryManagerRuntime, TokenRegistryManagerNotSupported } from './token-registry-manager.js';
import { P2PKHWalletStateManager, HdWalletStateManager } from './wallet-state-manager.js';
import type { WalletStateManager } from './wallet-state-manager.js';
import {
  DEFAULT_BCH_ELECTRON_CLIENT_PARAMETERS,
  DEFAULT_IPFS_ENDPOINT,
  TOKEN_EXPLORER_ENDPOINT,
  DEFAULT_TX_FEE_PER_BYTE,
  DEFAULT_PREFERRED_TOKEN_OUTPUT_BCH_AMOUNT,
} from './constants.js';
import { createMainIndexedDB } from './internal/util.js';
import { SvelteMap } from 'svelte/reactivity';
import { getNativeBCHTokenIdentity } from './helpers.js';

export type MainParameters = {
  client: BCHElectronClientParameters;
  ipfs_endpoint: string;
  default_txfee_per_byte: Fraction;
  preferred_token_output_bch_amount: bigint;
};

export type MainState = {
  runtime_ready: boolean;
  wallets_ready: boolean;
  wallets: Array<{ value: Wallet, state: WalletState | null }>;
  token_identity_map: Map<string, TokenIdentityWithState>;
  client_connecting: boolean;
  client_connected: boolean;
  main_parameters: MainParameters;
  db_ready: boolean;
  fatal_error: string | null;
  token_explorer_endpoint: string;
};

export type MainContext = {
  is_client_runtime: boolean;
  state: MainState;
  wallet_store: WalletStore;
  client: BCHElectronClient;
  utxo_tracker: UTXOTracker;
  token_registry_manager: TokenRegistryManager;
  getWalletStateManager (wallet_id: string): WalletStateManager | undefined;
  saveMainParameters (parameters: MainParameters): void;
  onMainParametersChange (parameters: MainParameters): void;
  initTokenIdentity (token_id: TokenId): TokenIdentityWithState;
  reloadTokenIdentity (token_id: TokenId): void;
};

export const createMainContext = (): MainContext => {
  const is_client_runtime = typeof window !== 'undefined';
  const state: MainState = $state({
    runtime_ready: false,
    wallets_ready: false,
    wallets: [],
    token_identity_map: new SvelteMap(),
    client_connecting: false,
    client_connected: false,
    db_ready: false,
    fatal_error: null,
    main_parameters: {
      client: DEFAULT_BCH_ELECTRON_CLIENT_PARAMETERS,
      ipfs_endpoint: DEFAULT_IPFS_ENDPOINT,
      default_txfee_per_byte: DEFAULT_TX_FEE_PER_BYTE,
      preferred_token_output_bch_amount: DEFAULT_PREFERRED_TOKEN_OUTPUT_BCH_AMOUNT,
    },
    token_explorer_endpoint: TOKEN_EXPLORER_ENDPOINT,
  });
  let bootstrap_completed: boolean = false;
  const checkRuntimeReady = () => {
    if (!state.runtime_ready && state.wallets_ready && state.db_ready && bootstrap_completed) {
      if (db == null) {
        throw new InvalidProgramState(`db is null!`);
      }
      token_registry_manager.onDBConnected(db);
      for (const item of state.wallets) {
        if (item.value.enabled && item.state == null) {
          item.state = initWalletState(item.value);
        }
      }
      state.runtime_ready = true;
    }
  };
  const reloadTokenIdentity = (token_id: TokenId): void => {
    const item = state.token_identity_map.get(token_id);
    if (item != null) {
      item.loader_state = {
        request_status: null,
        has_no_record: false,
        load_error: null,
        valid_until: 0,
      };
      if (item.sendLoadRequest != null) {
        item.sendLoadRequest();
      }
    }
  };
  const initTokenIdentity = (token_id: TokenId): TokenIdentityWithState => {
    if (token_id === NATIVE_BCH_TOKEN_ID) {
      return {
        value: getNativeBCHTokenIdentity(),
        loader_state: null,
      };
    }
    const VALID_TIMEVAL = 6 * 3600 * 1000;
    const ctime = new Date().getTime();
    let known_item = state.token_identity_map.get(token_id);
    if (known_item != null && known_item.loader_state != null) {
      if (known_item.loader_state.request_status != null ||
          (known_item.loader_state.valid_until < ctime &&
            (known_item.loader_state.has_no_record || known_item.value != null))) {
        // return the known item
        return known_item;
      }
    }
    const sendLoadRequest = () => {
      token_registry_manager.requestTokenIdentity(token_id, {
        onStatusChange ({ status }: { status: TokenIdentityLoaderRequestStatus }) {
          item.loader_state.request_status = status;
        },
        onResolve (token_identity: TokenIdentity | null) {
          item.loader_state.has_no_record = token_identity == null;
          item.value = token_identity;
          item.loader_state.valid_until = new Date().getTime() + VALID_TIMEVAL;
        },
        onReject (exception: Exception) {
          console.warn(`Token load failed: `, token_id, exception);
          item.loader_state.load_error = exception;
        },
      });
    };
    const item: TokenIdentityWithState & {
      loader_state: TokenIdentityLoaderState;
      sendLoadRequest (): void;
    } = $state({
      value: null,
      loader_state: {
        request_status: null,
        has_no_record: false,
        load_error: null,
        valid_until: 0,
      },
      sendLoadRequest,
    });
    item.sendLoadRequest();
    state.token_identity_map.set(token_id, item);
    return item;
  };
  const wallet_state_manager_map: Map<string, WalletStateManager> = new Map();
  const utxo_tracker = new UTXOTracker();
  let db: IDBDatabase | null = null;
  const initDB = async () => {
    try {
      db = await createMainIndexedDB();
      db.onversionchange = () => {
        if (db == null) {
          throw new InvalidProgramState(`db is null!`);
        }
        db.close();
        token_registry_manager.onDBDisconnected(db);
        state.fatal_error = 'Database changed, please reload the page';
      };
      state.db_ready = true;
      checkRuntimeReady();
    } catch (err) {
      console.error(err);
      state.fatal_error = `Database init failed, ${(err as any).name}: ${(err as any).message}`;
    }
  };
  const initWalletState = (wallet: Wallet): WalletState => {
    if (wallet_state_manager_map.has(wallet.id)) {
      throw new InvalidProgramState('initWalletState, wallet_state_manager_map.has(wallet.id)')
    }
    if (db == null) {
      throw new InvalidProgramState(`db is null!`);
    }
    const wallet_state: WalletState = $state({
      address_list: [],
      utxo_map: new SvelteMap(),
      error: '',
      balances: [],
    });
    let ManagerClass;
    if (['p2pkh', 'p2pkh-watch'].indexOf(wallet.type) !== -1) {
      ManagerClass = P2PKHWalletStateManager;
    } else if (wallet.type === 'hd') {
      ManagerClass = HdWalletStateManager;
    } else {
      throw new ValueError(`Unknown Wallet type: ${wallet.type}`);
    }
    const initTokenBalanceItem = (token_balance: TokenBalance): { value: TokenBalance, token_identity: TokenIdentityWithState } => {
      return {
        value: token_balance,
        token_identity: initTokenIdentity(token_balance.token_id),
      };
    };
    const state_manager = new ManagerClass(wallet, {
      address_list: {
        init (items: Array<{ value: AddressInfo, state: AddressState }>): void {
          wallet_state.address_list = items;
        },
        insert (index: number, item: { value: AddressInfo, state: AddressState }): { value: AddressInfo, state: AddressState } {
          const idx = wallet_state.address_list.findIndex((a) => a.value.id === item.value.id);
          if (idx !== -1) {
            throw new ValueError(`Item is already defined!`);
          }
          if (index < 0 || index > wallet_state.address_list.length) {
            throw new ValueError(`index out of range, index: ${index}`);
          }
          wallet_state.address_list.splice(index, 0, item);
          return wallet_state.address_list[index];
        },
        has (item_id: string) {
          return wallet_state.address_list.findIndex((a) => a.value.id === item_id) !== -1;
        },
        remove (item_id: string): void {
          const idx = wallet_state.address_list.findIndex((a) => a.value.id === item_id);
          if (idx === -1) {
            throw new ValueError(`Item not found, id: ${item_id}`);
          }
          wallet_state.address_list.splice(idx, 1);
        },
        update (item: { value: AddressInfo, state: AddressState }): void {
          const idx = wallet_state.address_list.findIndex((a) => a.value.id === item.value.id);
          if (idx === -1) {
            throw new ValueError(`Item not found, id: ${item.value.id}`);
          }
          wallet_state.address_list.splice(idx, 1, item);
        },
        getItem (item_id: string): { value: AddressInfo, state: AddressState } | undefined {
          return wallet_state.address_list.find((a) => a.value.id === item_id);
        },
        getKeys (): string[] {
          return wallet_state.address_list.map((a) => a.value.id);
        },
        getListSnapshot (): Array<{ value: AddressInfo, state: AddressState }> {
          return $state.snapshot(wallet_state.address_list);
        },
        getCount (): number {
          return wallet_state.address_list.length;
        },
      },
      utxo_map: {
        init (entries: Array<{ key: string, value: WalletUTXOEntry }>): void {
          wallet_state.utxo_map.clear();
          for (const { key, value } of entries) {
            wallet_state.utxo_map.set(key, value);
          }
        },
        set (key: string, value: WalletUTXOEntry): void {
          wallet_state.utxo_map.set(key, value);
        },
        delete (key: string): void {
          wallet_state.utxo_map.delete(key);
        },
        has (key: string): boolean {
          return wallet_state.utxo_map.has(key);
        },
        get (key: string): WalletUTXOEntry | undefined {
          return wallet_state.utxo_map.get(key);
        },
        getMapSnapshot (): Map<string, WalletUTXOEntry> {
          return $state.snapshot(wallet_state.utxo_map);
        },
        getSize (): number {
          return wallet_state.utxo_map.size;
        },
      },
      error: {
        get (): string {
          return wallet_state.error;
        },
        set (value: string): void {
          wallet_state.error = value;
        },
        snapshot (): string {
          return $state.snapshot(wallet_state.error);
        },
      },
      balances: {
        init (token_balance_list: TokenBalance[]): void {
          wallet_state.balances = token_balance_list.map(initTokenBalanceItem);
        },
        insert (index: number, token_balance: TokenBalance): TokenBalance {
          const idx = wallet_state.balances.findIndex((a) => a.value.token_id === token_balance.token_id);
          if (idx !== -1) {
            throw new ValueError(`Item is already defined!`);
          }
          if (index < 0 || index > wallet_state.balances.length) {
            throw new ValueError(`index out of range, index: ${index}`);
          };
          wallet_state.balances.splice(index, 0, initTokenBalanceItem(token_balance))
          return wallet_state.balances[index].value;
        },
        has (item_id: string) {
          return wallet_state.balances.findIndex((a) => a.value.token_id === item_id) !== -1;
        },
        remove (item_id: string): void {
          const idx = wallet_state.balances.findIndex((a) => a.value.token_id === item_id);
          if (idx === -1) {
            throw new ValueError(`Item not found, id: ${item_id}`);
          }
          wallet_state.balances.splice(idx, 1);
        },
        update (token_balance: TokenBalance): void {
          const item = wallet_state.balances.find((a) => a.value.token_id === token_balance.token_id);
          if (item == null) {
            throw new ValueError(`Item not found, id: ${token_balance.token_id}`);
          }
          item.value = token_balance;
        },
        getItem (item_id: string): TokenBalance | undefined {
          const item = wallet_state.balances.find((a) => a.value.token_id === item_id);
          if (item == null) {
            return undefined;
          }
          return item.value;
        },
        getKeys (): string[] {
          return wallet_state.balances.map((a) => a.value.token_id);
        },
        getListSnapshot (): TokenBalance[] {
          return $state.snapshot(wallet_state.balances.map((a) => a.value));
        },
        getCount (): number {
          return wallet_state.balances.length;
        },
      }
    }, utxo_tracker, db);
    if (state.client_connected && state_manager instanceof HdWalletStateManager) {
      state_manager.onClientConnected(client);
    }
    wallet_state_manager_map.set(wallet.id, state_manager);
    return wallet_state;
  };
  const initClient = (main_parameters: MainParameters): BCHElectronClient => {
    const client = new BCHElectronClientRuntime(main_parameters.client, {
      onConnected (): void {
        state.client_connecting = false;
        state.client_connected = true;
        utxo_tracker.onClientConnected(client);
        token_registry_manager.onClientConnected(client);
        for (const state_manager of wallet_state_manager_map.values()) {
          if (state_manager instanceof HdWalletStateManager) {
            state_manager.onClientConnected(client);
          }
        }
      },
      onConnecting (): void {
        state.client_connecting = true;
      },
      onDisconnected (): void {
        state.client_connecting = false;
        state.client_connected = false;
        utxo_tracker.onClientDisconnected(client);
        for (const state_manager of wallet_state_manager_map.values()) {
          if (state_manager instanceof HdWalletStateManager) {
            state_manager.onClientDisconnected(client);
          }
        }
        token_registry_manager.onClientDisconnected(client);
      },
      onElectrumNotification (message: ElectrumRPCNotification): void {
        utxo_tracker.onElectrumNotification(message);
      },
    });
    client.createBatchSenderCategory('bcmr-indexer', {
      rate_limit: { // 1000 requests per minute
        max: 500,
        interval: 20 * 1000,
      },
    });
    return client;
  };
  const loadMainParameters = (): MainParameters => {
    try {
      let main_parameters;
      const data_serialized = window.localStorage.getItem('main-parameters');
      if (data_serialized) {
        main_parameters = state.main_parameters = JSON.parse(data_serialized);
        if (state.runtime_ready) {
          onMainParametersChange(main_parameters)
        }
      } else {
        main_parameters = state.main_parameters;
      }
      return main_parameters;
    } catch (err) {
      throw new ValueError(`Failed to load client parameters from localStorage('main-parameters')`, { cause: err });
    }
  };
  const saveMainParameters = (parameters: MainParameters): void => {
    window.localStorage.setItem('main-parameters', JSON.stringify(parameters));
  };
  let onMainParametersChange_pending_promise: Promise<void> | null = null;
  const onMainParametersChange = async (main_parameters: MainParameters): Promise<void> => {    
    const run = async (): Promise<void> => {
      try {
        if (client != null) {
          await client.destroy();
        }
        client = initClient(main_parameters);

        token_registry_manager.setParameters({ ipfs_endpoint: main_parameters.ipfs_endpoint });
      } catch (err) {
        console.warn(`client restart fail, `, err);
      } finally {
        if (promise === onMainParametersChange_pending_promise) {
          onMainParametersChange_pending_promise = null;
        }
      }
    };
    let promise = onMainParametersChange_pending_promise =
      (onMainParametersChange_pending_promise != null ?
        onMainParametersChange_pending_promise : Promise.resolve())
        .then(run, run);
  };
  let token_registry_manager: TokenRegistryManager;
  let wallet_store: WalletStore;
  let client: BCHElectronClient;
  if (is_client_runtime) {
    const main_parameters = loadMainParameters();
    initDB();
    token_registry_manager = new TokenRegistryManagerRuntime({ ipfs_endpoint: main_parameters.ipfs_endpoint });
    wallet_store = new WalletStoreRuntime({ 
      init (wallets: Wallet[]): void {
        state.wallets = wallets.map((wallet) => ({ value: wallet, state: null }));
        state.wallets_ready = true;
        checkRuntimeReady();
      },
      insert (index: number, wallet: Wallet): Wallet{ 
        const idx = state.wallets.findIndex((a) => a.value.id === wallet.id);
        if (idx !== -1) {
          throw new ValueError(`wallet is already defined!`);
        }
        if (index < 0 || index > state.wallets.length) {
          throw new ValueError(`index out of range, index: ${index}`);
        }
        const item: { value: Wallet, state: WalletState | null } = { value: wallet, state: null };
        if (state.runtime_ready && item.value.enabled) {
          item.state = initWalletState(item.value);
        }
        state.wallets.splice(index, 0, item);
        return item.value;
      },
      has (wallet_id: string) {
        return state.wallets.findIndex((a) => a.value.id === wallet_id) !== -1;
      },
      remove (wallet_id: string): void {
        const wallet_idx = state.wallets.findIndex((a) => a.value.id === wallet_id);
        if (wallet_idx === -1) {
          throw new ValueError(`Wallet not found, id: ${wallet_id}`);
        }
        state.wallets.splice(wallet_idx, 1);
        const state_manager = wallet_state_manager_map.get(wallet_id);
        if (state_manager != null) {
          // destroy wallet state
          wallet_state_manager_map.delete(wallet_id);
          ;(async() => {
            try {
              await state_manager.destroy();
            } catch (err) {
              console.warn('state manager destroy fail,', err);
            }
          })();
        }
      },
      update (wallet: Wallet): void {
        const idx = state.wallets.findIndex((a) => a.value.id === wallet.id);
        if (idx === -1) {
          throw new ValueError(`wallet is not defined!`);
        }
        const entry = state.wallets[idx];
        const state_manager = wallet_state_manager_map.get(wallet.id);
        if (state_manager == null) {
          if (state.runtime_ready && wallet.enabled && entry.state == null) {
            entry.state = initWalletState(wallet);
          }
        } else {
          if (wallet.enabled) {
            // update state
            state_manager.onWalletDataChange(wallet);
          } else {
            // destroy wallet state
            wallet_state_manager_map.delete(wallet.id);
            ;(async() => {
              try {
                await state_manager.destroy();
                entry.state = null;
              } catch (err) {
                console.warn('state manager destroy fail,', err);
              }
            })();
          }
        }
        entry.value = wallet;
      },
      getItem (wallet_id: string): Wallet | undefined {
        const entry = state.wallets.find((a) => a.value.id === wallet_id);
        if (entry == null) {
          return undefined;
        }
        return entry.value;
      },
      getKeys (): string[] {
        return state.wallets.map((a) => a.value.id);
      },
      getListSnapshot (): Wallet[] {
        return $state.snapshot(state.wallets.map((a) => a.value));
      },
      getCount (): number {
        return state.wallets.length;
      },
    });
    client = initClient(main_parameters);
    bootstrap_completed = true;
    checkRuntimeReady();
  } else {
    token_registry_manager = new TokenRegistryManagerNotSupported();
    wallet_store = new WalletStoreNotSupported();
    client = new BCHElectronClientNotSupported();
  }
  return {
    is_client_runtime,
    state,
    wallet_store,
    client,
    utxo_tracker,
    token_registry_manager,
    getWalletStateManager (wallet_id: string): WalletStateManager | undefined {
      return wallet_state_manager_map.get(wallet_id);
    },
    saveMainParameters,
    onMainParametersChange,
    initTokenIdentity,
    reloadTokenIdentity,
  };
};
