<script lang="ts">
  import { getContext } from 'svelte';
  import type { MainContext } from '$lib/main.svelte.ts';
  import { tokenDecimalAmount, sanitizeExternalTokenText } from '$lib/helpers.js';
  import { ValueError } from '@cashlab/common/exceptions.js';
  import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common';
  import { page } from '$app/stores';
  import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';

  const main: MainContext = getContext('main');

  const wallet = main.state.wallets.find((a) => a.value.id === $page.params.id);

  const onToggleStatus = () => {
    const wallet_data = $state.snapshot(wallet.value);
    wallet_data.enabled = !wallet_data.enabled;
    main.wallet_store.updateWallet(wallet_data);
  };  
  const onReloadTokenIdentity = (token_id: string): void => {
    main.reloadTokenIdentity(token_id);
  };
</script>
{#if main.state.wallets_ready }
<div>
  {#if wallet == null }
    <h1 class="x">Wallet NOT FOUND!</h1>
  {:else}
    <h1 class="x">Wallet</h1>
    <dl class="x">
      <dt>Name: </dt>
      <dd>{ wallet.value.name }</dd>
      <dt>Status</dt>
      <dd>
        <span class="me-3">{ wallet.value.enabled ? 'Enabled' : 'Disabled' }</span>
        <button type="button" class="x" aria-label={wallet.value.enabled ? 'Enable' : 'Disable'} onclick={onToggleStatus}>
        {#if wallet.value.enabled }
          Disable
        {:else}
          Enable
        {/if}
        </button>
      </dd>
      {#if wallet.state }
      <dt>UTXO Set size: </dt>
      <dd>{ wallet.state.utxo_map.size }</dd>
      <dt>Addresses: </dt>
      <dd>{ wallet.state.address_list.length }</dd>
      <dt>Subscribed addresses: </dt>
      <dd>{ wallet.state.address_list.filter((a) => a.value.subscribed).length }</dd>
      {/if}
    </dl>
    {#if wallet.state }
    <h2 class="x">Balances</h2>
    <div class="relative overflow-x-auto">
      <table class="w-full text-sm text-left rtl:text-right text-gray:500 dark:text-gray-200">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-200">
          <tr>
            <th scope="col" class="px-6 py-3">
              Name
            </th>
            <th scope="col" class="px-6 py-3">
              Amount
            </th>
            <th scope="col" class="px-6 py-3">
              Info
            </th>
          </tr>
        </thead>
        <tbody>
          {#each wallet.state.balances as balance (balance.value.token_id)}
          <tr class="bg-white border-b dark:bg-gray-800 dark:border-gray-700">
            <td class="px-2 py-1 w-40">
              {#if balance.token_identity.value }
              <div class="flex flex-row">
                  <span class="me-2">
                    {#if balance.token_identity.value.verified === true }
                    <i class="x-verified-symbol fa-solid fa-check"></i>
                    {:else}
                    <i class="x-unverified-symbol fa-solid fa-triangle-exclamation"></i>
                    {/if}
                  </span>
                  <div class="flex flex-col">
                    <span class="x-token-name mb-1">
                      { sanitizeExternalTokenText(balance.token_identity.value.name) }
                    </span>
                    <span class="x-token-icon"><img src={balance.token_identity.value.icon_url} alt={sanitizeExternalTokenText(balance.token_identity.value.symbol_text)} /></span>
                  </div>
                </div>
              {:else}
                <div class="flex flex-row items-center">
                  <div class="me-2 w-6 h-6 flex items-center justify-center">
                    {#if balance.token_identity.loader_state == null }
                      <span>??</span>
                    {:else if balance.token_identity.loader_state.request_status === 'loading' }
                      <LoadingSpinner size="16" />
                    {:else if balance.token_identity.loader_state.request_status === 'pending' }
                      <i class="fa-solid fa-hourglass-half"></i>
                    {:else}
                      {#if !balance.token_identity.loader_state.has_no_record }
                        <button type="button" class="x-icon x-sm" aria-label="Reload" onclick={() => onReloadTokenIdentity(balance.value.token_id)}><i class="fa-solid fa-rotate-right"></i></button>
                      {/if}
                    {/if}
                  </div>
                  <span class="x-token-id w-25">
                    0x{ balance.value.token_id }
                  </span>
                </div>
              {/if}
            </td>
            <td class="tabular-nums">
              <div class="flex flex-row items-center">
                {#if balance.token_identity.value }
                  <span class="x-token-amount">{ tokenDecimalAmount(balance.value.amount, balance.token_identity.value) }</span>
                  <span class="x-token-symbol">{ sanitizeExternalTokenText(balance.token_identity.value.symbol_text) }</span>
                {:else}
                  <span class="x-amount">{ balance.value.amount }</span>
                {/if}
              </div>
            </td>
            <td>
              <div class="flex flex-row justify-center">
                {#if balance.value.token_id !== NATIVE_BCH_TOKEN_ID }
                <a class="x-token-explorer-link" target="_blank" href={main.state.token_explorer_endpoint + encodeURIComponent(balance.value.token_id)} aria-label="View in token explorer"><i class="fa-solid fa-eye"></i></a>
                {/if}
                {#if balance.token_identity.value?.webpage_url }
                  <a class="x-token-webpage-link" target="_blank" href={balance.token_identity.value.webpage_url} aria-label="Token webpage"><i class="fa-solid fa-globe"></i></a>
                {/if}
              </div>
            </td>
          </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {/if}
  {/if}
</div>
{/if}

