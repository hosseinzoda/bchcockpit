import type { UTXO, TokenId } from '@cashlab/common/types.js';
import type { Wallet, TokenIdentity, TokenIdentityWithState } from '$lib/types.js';
  import type { UTXOTrackerLockingBytecodeEntry } from '$lib/internal/utxo-tracker.js';

export type PoolOwnerInfo = {
  id: string;
  wallet: Wallet;
  private_key?: Uint8Array;
  public_key_hash: Uint8Array;
  hd_params?: {
    index: number;
    is_change: boolean;
  };
  locking_bytecode: Uint8Array;
};
export type PoolTrackingItem = {
  info: PoolOwnerInfo;
  tracker: UTXOTrackerLockingBytecodeEntry;
  onTrackerEntryUpdate (entry: UTXOTrackerLockingBytecodeEntry, utxo_set: UTXO[]): void;
  onTrackerSubscriptionStatusChange (entry: UTXOTrackerLockingBytecodeEntry): void;
  utxo_set: UTXO[];
};
export type PoolUTXOItem = {
  utxo: UTXO;
  owner_info_list: PoolOwnerInfo[];
};
export type PairPoolItem = {
  id: string;
  tokens: Array<{ amount: bigint; token_id: TokenId; token_identity: TokenIdentityWithState; }>;
  watch_only: boolean;
  grouped_utxo_map: Map<string, {
    owner_info_list: PoolOwnerInfo[];
    utxo_map: Map<string, UTXO>;
  }>;
};

export type PairPoolItemExtended = PairPoolItem & {
  pair_bch: { amount: bigint; token_id: TokenId; token_identity: { value: TokenIdentity }; };
  pair_token: { amount: bigint; token_id: TokenId; token_identity: TokenIdentityWithState; };
};

export type CauldronV0PoolsContext = {
  state: {
    filters: { wallets: {[id:string]:boolean} };
    filters_visible: boolean;
    grouped_pair_pool_list: {
      with_key: PairPoolItem[];
      watch_only: PairPoolItem[];
    };
    pools_state: {
      address_map: Map<string, {
        type: 'p2pkh';
        pkh: Uint8Array;
        subscribed: boolean;
        owner_info_list: PoolOwnerInfo[];
      }>;
      utxo_map: Map<string, PoolUTXOItem>;
    };
    ready: boolean;
  };
};
