<script lang="ts">
  import { getContext } from 'svelte';
  import type { MainContext } from '$lib/main.svelte.ts';
  import { resolve } from '$lib/app-path-helpers.js';
  const main: MainContext = getContext('main');

  const wallets = main.state.wallets;
</script>
{#if main.state.wallets_ready }
<div class="flex flex-row flex-wrap items-center p-2 place-content-end">
  <div class="inline-flex" role="group">
    <a class="x-button-icon x-primary" href={resolve('/wallets/add')} aria-label="Add"><i class="fa-solid fa-plus"></i></a>
  </div>
</div>

<div class="relative overflow-x-auto">
  <table class="w-full text-sm text-left rtl:text-right text-gray:500 dark:text-gray-400">
    <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
      <tr>
        <th scope="col" class="px-6 py-3">
          Status
        </th>
        <th scope="col" class="px-6 py-3">
          Type
        </th>
        <th scope="col" class="px-6 py-3">
          Name
        </th>
        <th scope="col" class="px-6 py-3">
          Stats
        </th>
      </tr>
    </thead>
    <tbody>
      {#each wallets as wallet (wallet.value.id)}
      <tr class="bg-white border-b dark:bg-gray-800 dark:border-gray-700">
        <td class="text-center">
          {#if wallet.value.enabled }
            <i class="text-green-700 dark:text-green-400 fa-solid fa-plug-circle-bolt"></i>
          {:else}
            <i class="text-gray-500 fa-solid fa-plug-circle-minus"></i>
          {/if}
        </td>
        <td>
        {#if wallet.value.type === 'p2pkh'}
          <i class="fa-solid fa-key"></i>
          P2PKH
        {:else if wallet.value.type === 'p2pkh-watch'}
          <i class="fa-solid fa-eye"></i>
          P2PKH
        {:else if wallet.value.type === 'hd'}
          <i class="fa-solid fa-key"></i>
          Hd
        {/if}
        </td>
        <th scope="row" class="px-6 py-4 font-medium text-gray-900 dark:text-white">
          <a class="text-blue-700 dark:text-blue-400" href={resolve('/wallets/view/' + wallet.value.id)}>{ wallet.value.name }</a>
        </th>
        <td class="text-center">
          {#if wallet.state != null }
            <span class="whitespace-nowrap"><i class="fa-solid fa-at"></i> {  wallet.state.address_list.length }</span> /
            <span class="whitespace-nowrap"><i class="fa-solid fa-coins"></i> { wallet.state.utxo_map.size }</span>
          {:else}
            N/A
          {/if}
        </td>
      </tr>
      {/each}
    </tbody>
  </table>
</div>
{/if}

