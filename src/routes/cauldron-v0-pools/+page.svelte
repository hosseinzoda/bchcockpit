<script lang="ts">
  import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';

  import * as app_navigation from '$app/navigation';
  import { page } from '$app/stores';
  import { getContext } from 'svelte';
  import type { MainContext } from '$lib/main.svelte.ts';
  import type { PairPoolItemExtended, CauldronV0PoolsContext } from './types.js';

  import { 
    InvalidProgramState, NATIVE_BCH_TOKEN_ID,
  } from '@cashlab/common';
  import { tokenDecimalAmount, sanitizeExternalTokenText } from '$lib/helpers.js';

  const main: MainContext = getContext('main');
  const context: CauldronPoolsContext = getContext('cauldron-v0-pools');  

  const grouped_pair_pool_list_extended: {
    with_key: PairPoolItemExtended[];
    watch_only: PairPoolItemExtended[];
  } = $derived.by(() => {
    return Object.fromEntries(
      Object.entries(context.state.grouped_pair_pool_list)
        .map((entry) => {
          return [ entry[0], entry[1].map((item) => {
            const pair_bch: { amount: bigint; token_id: TokenId; token_identity: { value: TokenIdentity }; } = item.tokens.find((a) => a.token_id === NATIVE_BCH_TOKEN_ID) as any;
            const pair_token = item.tokens.find((a) => a.token_id !== NATIVE_BCH_TOKEN_ID);
            if (!pair_bch || !pair_token) {
              throw new InvalidProgramState('!pair_bch || !pair_token');
            }
            return {
              ...item,
              pair_bch,
              pair_token,
            };
          }) ];
        })
    );
  });
  $effect(() => {
    context.state.filters_visible = true;
  });

  const onClickWithdraw = (pair_item: PairPoolItemExtended): void => {
    const token_id = pair_item.pair_token.token_id;
    const query = Array.from($page.url.searchParams.entries());
    app_navigation.goto($page.url.pathname + '/withdraw/' + token_id + (query.length > 0 ? '?' + query.map((a) => encodeURIComponent(a[0]) + '=' + encodeURIComponent(a[1])).join('&') : ''));
  };
  const onReloadTokenIdentity = (token_id: string): void => {
    main.reloadTokenIdentity(token_id);
  };
</script>

{#if Object.values(grouped_pair_pool_list_extended).reduce((a, b) => a + b.length, 0) == 0 }
  <p>Pool set is empty.</p>
{/if}
{#each Object.entries(grouped_pair_pool_list_extended) as gpair_pool_entry (gpair_pool_entry[0]) }
  {#if gpair_pool_entry[0] == 'watch_only' && gpair_pool_entry[1].length > 0 }
  <h2 class="x">Watch-Only</h2>
  {/if}
  {#if gpair_pool_entry[1].length > 0 }
  <div class="relative overflow-x-auto mb-3">
    <table class="w-full text-sm text-left rtl:text-right text-gray:500 dark:text-gray-200">
      <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-200">
        <tr>
          <th scope="col" class="px-6 py-3">
            Pair
          </th>
          <th scope="col" class="px-6 py-3">
            Amounts
          </th>
          <th scope="col" class="py-3">
          </th>
        </tr>
      </thead>
      <tbody>
        {#each gpair_pool_entry[1] as item (item.id)}
        <tr class="bg-white border-b dark:bg-gray-800 dark:border-gray-700">
          <td class="px-2 py-1 w-40">
            {#if item.pair_token.token_identity.value }
            <div class="flex flex-row">
              <span class="me-2">
                {#if item.pair_token.token_identity.value.verified === true }
                  <i class="x-verified-symbol fa-solid fa-check"></i>
                {:else}
                  <i class="x-unverified-symbol fa-solid fa-triangle-exclamation"></i>
                {/if}
              </span>
              <div class="flex flex-col">
                <span class="x-token-name mb-1">
                  { sanitizeExternalTokenText(item.pair_token.token_identity.value.name) }
                </span>
                <div class="flex flex-row mb-1 items-center">
                 <span class="x-pool-pair-icon me-1">
                   <img class="primary" src={item.pair_bch.token_identity.value.icon_url} alt={sanitizeExternalTokenText(item.pair_bch.token_identity.value.symbol_text)} />
                   <img class="secondary" src={item.pair_token.token_identity.value.icon_url} alt={sanitizeExternalTokenText(item.pair_token.token_identity.value.symbol_text)} />
                 </span>
                 <div class="flex flex-row">
                   <a class="x-token-explorer-link" target="_blank" href={main.state.token_explorer_endpoint + encodeURIComponent(item.pair_token.token_id)} aria-label="View in token explorer"><i class="fa-solid fa-eye"></i></a>
                   {#if item.pair_token.token_identity.value?.webpage_url }
                   <a class="x-token-webpage-link" target="_blank" href={item.pair_token.token_identity.value.webpage_url} aria-label="Token webpage"><i class="fa-solid fa-globe"></i></a>
                   {/if}
                 </div>
                </div>
                <span class="x-pool-pair-symbols">
                  { sanitizeExternalTokenText(item.pair_bch.token_identity.value.symbol_text) }/{ sanitizeExternalTokenText(item.pair_token.token_identity.value.symbol_text) }
                </span>
              </div>
            </div>
            {:else}
            <div class="flex flex-row items-center">
              <div class="me-2 w-6 h-6 flex items-center justify-center">
                {#if item.pair_token.token_identity.loader_state == null }
                  <span>??</span>
                {:else if item.pair_token.token_identity.loader_state.request_status === 'loading' }
                  <LoadingSpinner size="16" />
                {:else if item.pair_token.token_identity.loader_state.request_status === 'pending' }
                  <i class="fa-solid fa-hourglass-half"></i>
                {:else}
                  {#if !item.pair_token.token_identity.loader_state.has_no_record }
                    <button type="button" class="x-icon x-sm" aria-label="Reload" onclick={() => onReloadTokenIdentity(item.pair_token.token_id)}><i class="fa-solid fa-rotate-right"></i></button>
                  {/if}
                {/if}
              </div>
              <a class="x-token-id w-25 x-token-explorer-link whitespace-nowrap" target="_blank" href={main.state.token_explorer_endpoint + encodeURIComponent(item.pair_token.token_id)} aria-label="View in token explorer">
                <i class="fa-solid fa-eye"></i>
                0x{ item.pair_token.token_id }
              </a>
            </div>
            {/if}
          </td>
          <td class="tabular-nums">
            <div class="flex flex-col w-fit items-stretch">
              {#each item.tokens as token (token.token_id)}
                <div class="flex flex-row place-content-between">
                  {#if token.token_identity.value }
                    <span class="x-token-amount">{ tokenDecimalAmount(token.amount, token.token_identity.value) }</span>
                    <span class="x-token-symbol">{ sanitizeExternalTokenText(token.token_identity.value.symbol_text) }</span>
                  {:else}
                    <span class="x-amount">{ token.amount }</span>
                  {/if}
                </div>
              {/each}
            </div>
          </td>
          <td class="text-center">
            {#if !item.watch_only }
              <button type="button" class="x" onclick={() => onClickWithdraw(item)}>Withdraw</button>
            {/if}
          </td>
        </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {/if}
{/each}


