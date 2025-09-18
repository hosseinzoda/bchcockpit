import type { UTXO, TokenId, Exception } from '@cashlab/common';

export type WalletBase = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
};

export type P2PKHWallet = WalletBase & {
  type: 'p2pkh';
  pkh: Uint8Array;
  private_key: Uint8Array;
};

export type P2PKHWatchWallet = WalletBase &  {
  type: 'p2pkh-watch';
  pkh: Uint8Array;
};

export type HdWallet = WalletBase & {
  type: 'hd';
  seed: string;
  derivation_path: string;
};

export type Wallet = |
  P2PKHWallet |
  P2PKHWatchWallet |
  HdWallet;

export type LockingBytecodeInfo = {
  type: 'p2pkh' | 'p2sh20' | 'p2sh32';
  locking_bytecode: Uint8Array;
  address?: string;
};

export type ValueProxy<T> = {
  get (): T;
  set (value: T): void;
  snapshot (): T;
};

export type ListProxy<T> = {
  init (items: T[]): void;
  insert (index: number, item: T): T;
  remove (id: string): void;
  update (item: T): void;
  has (id: string): boolean;
  getItem (id: string): T | undefined;
  getKeys (): string[];
  getListSnapshot (): T[];
  getCount (): number;
};

export type MapProxy<K, T> = {
  init (entries: Array<{ key: K, value: T }>): void;
  set (key: K, value: T): void;
  delete (key: K): void;
  has (key: K): boolean;
  get (key: K): T | undefined;
  getMapSnapshot (): Map<K, T>;
  getSize (): number;
};

export type AddressInfo = {
  id: string;
  cashaddr: string;
  locking_bytecode: Uint8Array;
  subscribed: boolean;
};

export type AddressState = {
  utxo_set: UTXO[];
  excluded_utxo_outpoints: Set<string>;
};

export type WalletUTXOEntry = {
  utxo: UTXO;
  address: AddressInfo;
};

export type TokenIdentity = {
  verified: boolean;
  is_native_token: boolean;
  name: string;
  description?: string;
  symbol_text: string;
  decimals?: number;
  icon_url?: string;
  webpage_url?: string;
};

export type TokenIdentityLoaderRequestStatus = null | 'pending' | 'loading';

export type TokenIdentityLoaderState = {
  request_status: TokenIdentityLoaderRequestStatus;
  has_no_record: boolean;
  load_error: Exception | null;
  valid_until: number;
};

export type TokenIdentityWithState = {
  value: TokenIdentity | null;
  loader_state: TokenIdentityLoaderState | null;
  sendLoadRequest? (): void;
};

export type TokenBalance = {
  token_id: TokenId;
  amount: bigint;
};

export type WalletState = {
  address_list: Array<{ value: AddressInfo, state: AddressState }>;
  utxo_map: Map<string, WalletUTXOEntry>;
  error: string;
  balances: Array<{ value: TokenBalance, token_identity: TokenIdentityWithState }>;
};

export type HdWalletState = WalletState & {
  
};

