<script lang="ts">
  import { setContext, getContext } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { createMainContext } from '$lib/main.svelte.ts';
  import * as app_navigation from '$app/navigation';
  import type { UTXO } from '@cashlab/common/types.js';
  import type { Wallet } from '$lib/types.js';
  import type { WalletStateManager } from '$lib/wallet-state-manager.js';
  import type { UTXOTrackerLockingBytecodeEntry } from '$lib/internal/utxo-tracker.js';
  import type {
    PoolOwnerInfo, PoolTrackingItem, PoolUTXOItem, PairPoolItem, CauldronV0PoolsContext,
  } from './types.js';


  import { 
    ValueError, InvalidProgramState, uint8ArrayEqual,
    NATIVE_BCH_TOKEN_ID,
  } from '@cashlab/common';
  import {
    deriveHdPath, secp256k1, assertSuccess, hash160,
    lockingBytecodeToCashAddress,
    SigningSerializationFlag,
    binToHex,
  } from '@cashlab/common/libauth.js';
  import { poolV0LockingBytecode } from '$lib/internal/cauldron-v0-pool-helpers.js';

  const buildPoolOwnerInfoWithPKH = (wallet: Wallet, public_key_hash: Uint8Array, hd_params?: { index: number, is_change: boolean }): PoolOwnerInfo => {
    const id = [ wallet.id, hd_params ? (hd_params.is_change ? '1' : '0') + '/' + hd_params.index : '' ].join('|');
    const locking_bytecode = poolV0LockingBytecode(public_key_hash);
    const cashaddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: locking_bytecode })).address;
    return { id, wallet, public_key_hash, hd_params, locking_bytecode, cashaddr };
  };
  const buildPoolOwnerInfoWithPrivateKey = (wallet: Wallet, private_key: Uint8Array, hd_params?: { index: number, is_change: boolean }): PoolOwnerInfo => {
    const id = [ wallet.id, hd_params ? (hd_params.is_change ? '1' : '0') + '/' + hd_params.index : '' ].join('|');
    const public_key = assertSuccess(secp256k1.derivePublicKeyCompressed(private_key));
    const public_key_hash = hash160(public_key);
    const locking_bytecode = poolV0LockingBytecode(public_key_hash);
    const cashaddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: locking_bytecode })).address;
    return {
      id, wallet, private_key, public_key_hash,
      hd_params, locking_bytecode, cashaddr,
    };
  };

  const main: MainContext = getContext('main');
  const ctxstate: CauldronV0PoolsContext['state'] = $state({
    filters: {
      wallets: {},
    },
    grouped_pair_pool_list: { with_key: [], watch_only: [] },
    pools_state: {
      address_map: new SvelteMap(),
      utxo_map: new SvelteMap(),
    },
    filters_visible: true,
    ready: false,
  });
  const context: CauldronV0PoolsContext = {
    state: ctxstate,
  };
  let filters_all_wallets_selected: boolean = $state(true);
  let filters_ready: boolean = $state(false);
  let filter_error: boolean = $state(false);
  const onClickResetFilters = () => {
    ctxstate.filters.wallets = Object.fromEntries(main.state.wallets.filter((a) => a.value.enabled).map((a) => [a.value.id, true]));
    filters_all_wallets_selected = true;    
  };
  const replacePageQuery = (query) => {
    const page_url = new URL(location+'');
    app_navigation.replaceState(page_url.pathname + (query.length > 0 ? '?' + query.map((a) => encodeURIComponent(a[0]) + '=' + encodeURIComponent(a[1])).join('&') : ''), {});
  };
  type FiltersQuery = {
    wallets: string[],
  };
  const convertFiltersToAQuery = (filters: CauldronV0PoolsContext['state']['filters']): FiltersQuery => {
    return {
      wallets: Array.from(Object.entries(filters.wallets).filter((a) => !!a[1]).map((a) => a[0])),
    };
  };
  const isFiltersQueryMatch = (a: FiltersQuery, b: FiltersQuery): boolean => {
    return !!a?.wallets && !!b?.wallets && a.wallets.length === b.wallets.length &&
      a.wallets.filter((c) => b.wallets.indexOf(c) === -1).length == 0;
  };

  $effect(() => {
    if (main.state.wallets_ready) {
      // initiate only once, should detach from $effect to do this.
      setTimeout(() => {
        let input_filters_query = null;
        try {
          const page_url = new URL(location+'');
          input_filters_query = JSON.parse(atob(page_url.searchParams.get('filters')));
        } catch (err) {
          // pass
        }
        if (input_filters_query != null) {
          const filters = { wallets: {} };
          if (Array.isArray(input_filters_query.wallets)) {
            for (const wallet_id of input_filters_query.wallets) {
              if (typeof wallet_id === 'string') {
                filters.wallets[wallet_id] = true;
              }
            }
          }
          filters_all_wallets_selected = Object.entries(filters.wallets).filter((a) => !!a[1]).length === main.state.wallets.filter((a) => a.value.enabled).length;
          ctxstate.filters = filters;
        } else {
          ctxstate.filters.wallets = Object.fromEntries(main.state.wallets.filter((a) => a.value.enabled).map((a) => [a.value.id, true]));
          filters_all_wallets_selected = true;
        }
        filters_ready = true;
      }, 10);
    }
  });

  // update page query if needed
  $effect(() => {
    if (filters_ready) {
      const page_url = new URL(location+'');
      let url_filters_query = null;
      try {
        url_filters_query = JSON.parse(atob(page_url.searchParams.get('filters')));
      } catch (err) {
        // pass
      }
      const current_filters_query = convertFiltersToAQuery(ctxstate.filters);
      if (!isFiltersQueryMatch(current_filters_query, url_filters_query)) {
        const query = Array.from(page_url.searchParams.entries());
        { // remove filters
          let idx;
          while ((idx = query.findIndex((a) => a[0] === 'filters')) !== -1) {
            query.splice(idx, 1);
          }
        }
        // insert filters
        query.unshift([ 'filters', btoa(JSON.stringify(current_filters_query)) ]);
        // replace with some delay
        setTimeout(() => {
          replacePageQuery(query);
        }, 500);
      }
    }
  });
  const didClickSelectAllWalletsCheckbox = (event) => {
    filters_all_wallets_selected = event.target.checked;
    if (filters_all_wallets_selected) {
      ctxstate.filters.wallets = Object.fromEntries(
        main.state.wallets.filter((a) => a.value.enabled).map((a) => [ a.value.id, true ])
      );
    } else {
      ctxstate.filters.wallets = {};
    }
  };
  const didClickFilterWalletCheckbox = (event) => {
    if (Object.entries(ctxstate.filters.wallets).filter((a) => !!a[1]).length === main.state.wallets.filter((a) => a.value.enabled).length) {
      filters_all_wallets_selected = true;
    } else {
      filters_all_wallets_selected = false
    }
  };


  const onTrackerEntryUpdate = (titem: PoolTrackingItem, utxo_set: UTXO[]): void => {    
    try {
      const changes: Array<{ type: 'add' | 'remove', item: PoolUTXOItem }> = [];
      const known_outpoint_set = new Set<string>();
      const new_outpoint_set = new Set<string>();
      for (const utxo of titem.utxo_set) {
        const outpoint = binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index;
        known_outpoint_set.add(outpoint);
      }
      for (const utxo of utxo_set) {
        // nfts are not supported yet!
        const should_exclude = utxo.output.token?.nft != null;
        if (should_exclude) {
          continue;
        }
        const outpoint = binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index;
        new_outpoint_set.add(outpoint);
        if (!known_outpoint_set.has(outpoint)) {
          // add utxo
          let pool_item = ctxstate.pools_state.utxo_map.get(outpoint);
          if (pool_item == null) {
            pool_item = {
              utxo,
              owner_info_list: [],
            };
            ctxstate.pools_state.utxo_map.set(outpoint, pool_item);
          }
          { // add owner_info
            const idx = pool_item.owner_info_list.findIndex((a) => a.wallet.id === titem.info.wallet.id && uint8ArrayEqual(a.public_key_hash, titem.info.wallet.public_key_hash));
            if (idx === -1) {
              pool_item.owner_info_list.push(titem.info);
            }
          }
          changes.push({ type: 'add', item: pool_item });
        }
      }
      // removed utxos
      for (const known_outpoint of known_outpoint_set) {
        if (!new_outpoint_set.has(known_outpoint)) {
          // remove utxo
          const pool_item = ctxstate.pools_state.utxo_map.get(known_outpoint);
          if (pool_item == null) {
            throw new InvalidProgramState('remove utxo, utxo_map.get(known_outpoint) is null!');
          }
          { // remove owner_info
            const idx = pool_item.owner_info_list.findIndex((a) => a.wallet.id === titem.info.wallet.id && uint8ArrayEqual(a.public_key_hash, titem.info.public_key_hash));
            if (idx !== -1) {
              pool_item.owner_info_list.splice(idx, 1);
              if (pool_item.owner_info_list.length === 0) {
                ctxstate.pools_state.utxo_map.delete(known_outpoint);
                changes.push({ type: 'remove', item: pool_item });
              }
            }
          }
        }
      }
      titem.utxo_set = utxo_set;
      if (changes.length > 0) {
        onUpdate(changes);
      }
    } catch (err) {
      console.error(err);
    }
  };
  const onTrackerSubscriptionStatusChange = (item: PoolTrackingItem): void => {
    const lbc_id = binToHex(item.tracker.locking_bytecode);
    let address = ctxstate.pools_state.address_map.get(lbc_id);
    if (address != null) {
      address.subscribed = !!item.tracker.active_sub;
    }
  };
  const includeAddress = (info: PoolOwnerInfo) => {
    const lbc_id = binToHex(info.locking_bytecode);
    let address = ctxstate.pools_state.address_map.get(lbc_id);
    if (address == null) {
      address = {
        type: 'p2pkh',
        pkh: info.public_key_hash,
        subscribed: false,
        owner_info_list: [],
      };
      ctxstate.pools_state.address_map.set(lbc_id, address);
    }
    const idx = address.owner_info_list.findIndex((a) => a.id === info.id);
    if (idx === -1) {
      address.owner_info_list.push(info);
    }
  };
  const onUpdate = (changes: Array<{ type: 'add' | 'remove', item: PoolUTXOItem }>): void => {
    for (const change of changes) {
      const utxo = change.item.utxo;
      if (utxo.output.token == null) {
        continue; // a pool with no token!!!
      }
      const lbc_id = binToHex(utxo.output.locking_bytecode);
      const address = ctxstate.pools_state.address_map.get(lbc_id);
      if (address == null) {
        throw new InvalidProgramState('address data is null!');
      }
      const owner_info_list = address.owner_info_list;
      const has_a_key = owner_info_list.filter((a) => a.wallet.type.indexOf('watch') === -1).length > 0;
      const token_id = utxo.output.token.token_id;
      const gpair_pools = has_a_key ? ctxstate.grouped_pair_pool_list.with_key : ctxstate.grouped_pair_pool_list.watch_only;
      let pair_item = gpair_pools.find((pair) => pair.id == token_id);
      if (pair_item == null) {
        const token_a = {
          amount: 0n,
          token_id: NATIVE_BCH_TOKEN_ID,
          token_identity: main.initTokenIdentity(NATIVE_BCH_TOKEN_ID),
        };
        const token_b = {
          amount: 0n,
          token_id,
          token_identity: main.initTokenIdentity(token_id),
        };
        pair_item = {
          id: token_id,
          tokens: [ token_a, token_b ],
          watch_only: !has_a_key,
          grouped_utxo_map: new SvelteMap(),
        };
        gpair_pools.push(pair_item);
      }
      let grouped_utxo_item = pair_item.grouped_utxo_map.get(lbc_id);
      if (grouped_utxo_item == null) {
        grouped_utxo_item = {
          owner_info_list,
          utxo_map: new SvelteMap(),
        };
        pair_item.grouped_utxo_map.set(lbc_id, grouped_utxo_item);
      }
      const token_a = pair_item.tokens.find((b) => b.token_id === NATIVE_BCH_TOKEN_ID);
      const token_b = pair_item.tokens.find((b) => b.token_id === token_id);
      if (token_a == null || token_b == null) {
        throw new InvalidProgramState(`token_a == null || token_b == null`);
      }
      const utxo_outpoint = binToHex(utxo.outpoint.txhash) + ':' + utxo.outpoint.index;
      if (change.type === 'add') {
        if (grouped_utxo_item.utxo_map.has(utxo_outpoint)) {
          throw new InvalidProgramState(`grouped_utxo_item.utxo_map.has(utxo_outpoint)`);
        }
        grouped_utxo_item.utxo_map.set(utxo_outpoint, utxo);
        token_a.amount += utxo.output.amount;
        token_b.amount += utxo.output.token.amount;
      } else if (change.type === 'remove') {
        if (!grouped_utxo_item.utxo_map.has(utxo_outpoint)) {
          throw new InvalidProgramState(`!grouped_utxo_item.utxo_map.has(utxo_outpoint)`);
        }
        grouped_utxo_item.utxo_map.delete(utxo_outpoint);
        token_a.amount -= utxo.output.amount;
        token_b.amount -= utxo.output.token.amount;
      } else {
        throw new InvalidProgramState(`change.type!!: ${change.type}`);
      }
    }
    for (const gpair_pools of [ ctxstate.grouped_pair_pool_list.with_key, ctxstate.grouped_pair_pool_list.watch_only ]) {
      for (let i = 0; i < gpair_pools.length; ) {
        const pair_item = gpair_pools[i];
        if (pair_item != null && pair_item.grouped_utxo_map.values().reduce((a, b) => a + b.utxo_map.size, 0) === 0) {
          gpair_pools.splice(i, 1);
        } else {
          i++;
        }
      }
    }
  };

  $effect(() => {
    if (!filters_ready || !main.state.runtime_ready) {
      return;
    }
    const includePoolOwner = (info: PoolOwnerInfo): void => {
      if (items_map.has(info.id)) {
        return;
      }
      const tracker = main.utxo_tracker.addTrackerByLockingBytecode(info.locking_bytecode);
      const item = {
        info, tracker,
        onTrackerEntryUpdate (entry: UTXOTrackerLockingBytecodeEntry, utxo_set: UTXO[]): void {
          onTrackerEntryUpdate(item, utxo_set);
        },
        onTrackerSubscriptionStatusChange (entry: UTXOTrackerLockingBytecodeEntry): void {
          onTrackerSubscriptionStatusChange(item);
        },
        utxo_set: [],
      };
      tracker.update_listeners.push(item.onTrackerEntryUpdate);
      tracker.subscription_status_change_listeners.push(item.onTrackerSubscriptionStatusChange);
      setTimeout(() => {
        // access & modify pools_state outside of the effect
        includeAddress(item.info);
        onTrackerSubscriptionStatusChange(item);
        if (item.tracker.data != null) {
          item.onTrackerEntryUpdate(item.tracker, item.tracker.data);
        }
      }, 10);
      items_map.set(info.id, item);
    };
    const onWalletStateManagerUpdate = function () {
      const state_manager: WalletStateManager = this;
      const wallet: Wallet = state_manager.wallet;
      if (wallet.type === 'hd') {
        // main indecies
        for (let index = 0; index < state_manager.last_main_index + state_manager.extend_watch_count+ 1; ++index) {
          const item_private_key = assertSuccess(deriveHdPath(state_manager.node, wallet.derivation_path + '/0/' + index)).privateKey;
          const info = buildPoolOwnerInfoWithPrivateKey(wallet, item_private_key, { index, is_change: false });
          includePoolOwner(info);
        }
        /* do not subscribe to change addresses
        // change indecies
        for (let index = 0; index < state_manager.last_change_index + state_manager.extend_watch_count + 1; ++index) {

        }
        */
      } else if (wallet.type === 'p2pkh') {
        includePoolOwner(buildPoolOwnerInfoWithPrivateKey(wallet, wallet.private_key));
      } else if (wallet.type === 'p2pkh-watch') {
        includePoolOwner(buildPoolOwnerInfoWithPKH(wallet, wallet.pkh));
      } else {
        throw new ValueError(`unknown wallet type: ${wallet.type}`);
      }
    };
    let wallets;
    // use filters
    try {
      wallets = Object.entries(ctxstate.filters.wallets).map((entry) => {
        if (!entry[1]) {
          return null;
        }
        const wallet_id = entry[0];
        let tmp = main.state.wallets.find((a) => a.value.id === wallet_id);
        if (tmp == null) {
          throw new ValueError(`wallet does not exists, wallet_id: ${wallet_id}`);
        }
        return tmp.value;
      }).filter((a) => !!a);
    } catch (err) {
      filter_error = true;
      console.warn('Use filters error', err);
      return;
    }
    let items_map: Map<string, PoolTrackingItem> = new Map();
    for (const wallet of wallets) {
      const state_manager = main.getWalletStateManager(wallet.id);
      if (state_manager != null) {
        state_manager.addEventListener('update', onWalletStateManagerUpdate);
        onWalletStateManagerUpdate.call(state_manager);
      }
    }
    filter_error = false;
    ctxstate.ready = true;
    return () => {
      ctxstate.ready = false;
      for (const wallet of wallets) {
        const state_manager = main.getWalletStateManager(wallet.id);
        if (state_manager != null) {
          state_manager.removeEventListener('update', onWalletStateManagerUpdate);
        }
      }
      for (const item of items_map.values()) {
        {
          const idx = item.tracker.update_listeners.indexOf(item.onTrackerEntryUpdate);
          if (idx !== -1) {
            item.tracker.update_listeners.splice(idx, 1);
          }
        }
        {
          const idx = item.tracker.subscription_status_change_listeners.indexOf(item.onTrackerSubscriptionStatusChange);
          if (idx !== -1) {
            item.tracker.subscription_status_change_listeners.splice(idx, 1);
          }
        }
      }
      ctxstate.grouped_pair_pool_list.with_key = [];
      ctxstate.grouped_pair_pool_list.watch_only = [];
      ctxstate.pools_state.address_map.clear();
      ctxstate.pools_state.utxo_map.clear();
      items_map = null;
    };
  });
  setContext('cauldron-v0-pools', context);

	let { children } = $props();
</script>
{#if ctxstate.filters_visible && filters_ready }
<div class="flex flex-row items-center pb-2 mb-2 border-b border-gray-700">
  <div class="w-full">
    <div class="flex flex-row">
      <div class="font-semibold">Filters: </div>
      <div class="grow"></div>
      <div>
        {#if main.state.client_connected }
          <i class="fa-solid fa-at"></i> {  ctxstate.pools_state.address_map.size } /
          <i class="fa-solid fa-coins"></i> { ctxstate.pools_state.utxo_map.size }
        {/if}
      </div>
    </div>
    <div class="p-1">
      <div class="font-semibold pb-2">Wallets:</div>
      <div class="flex flex-row flex-wrap mx-1 max-h-21 overflow-hidden overflow-y-auto items-center">
        <div class="flex items-center p-1 me-2">
          <input bind:checked={filters_all_wallets_selected} onchange={didClickSelectAllWalletsCheckbox} id="filters-wallet--all" type="checkbox" class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded-sm focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600">
          <label for="filters-wallet--all" class="ms-1 text-sm font-medium text-gray-900 dark:text-gray-300">All Wallets</label>
        </div>
        {#each main.state.wallets.filter((a) => a.value.enabled) as wallet (wallet.value.id) }
        <div class="flex items-center p-1 me-2">
          <input bind:checked={ctxstate.filters.wallets[wallet.value.id]} onchange={didClickFilterWalletCheckbox} value={true} id={'filters-wallet-' + wallet.value.id} type="checkbox" class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded-sm focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600">
          <label for={'filters-wallet-' + wallet.value.id} class="ms-1 text-sm font-medium text-gray-900 dark:text-gray-300">
            {#if wallet.value.type.indexOf('watch') === -1 }
              <i class="fa-solid fa-key"></i>
            {:else}
              <i class="fa-solid fa-eye"></i>
            {/if}
            { wallet.value.name }
          </label>
        </div>
        {/each}
      </div>
    </div>
  </div>
</div>
{/if}

{#if filter_error }
  <p>
   Failed to apply the provided filters. 
   <button type="button" class="x" onclick={() => onClickResetFilters()}>Reset filters</button>
  </p>
{:else if ctxstate.ready}
  {@render children?.()}
{/if}
