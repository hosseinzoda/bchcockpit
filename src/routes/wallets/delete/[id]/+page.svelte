<script lang="ts">
  import { getContext } from 'svelte';
  import type { MainContext } from '$lib/main.svelte.ts';
  import { tokenDecimalAmount, sanitizeExternalTokenText } from '$lib/helpers.js';
  import { ValueError } from '@cashlab/common/exceptions.js';
  import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common';
  import { page } from '$app/stores';
  import * as app_navigation from '$app/navigation';
  import { pageURLFromLink, pagePathToLink, stripBaseFromPath } from '$lib/app-path-helpers.js';

  const main: MainContext = getContext('main');

  const input: { name: string } = $state({
    name: '',
  });

  const wallet = main.state.wallets.find((a) => a.value.id === $page.params.id);

  const onClickConfirm = function () {
    if (this.disabled) {
      return;
    }
    main.wallet_store.removeWalletById(wallet.value.id);
    app_navigation.goto(pagePathToLink('/wallets'));
  };
</script>

<div class="flex flex-row items-center mb-2" role="group">
  <button class="x-icon x-secondary" aria-label="Back" onclick={() => history.back()}><i class="fa-solid fa-arrow-left"></i></button>
  <div class="grow"></div>
  {#if wallet != null }
  <button class="x-icon x-danger" aria-label="Confirm" disabled={input.name != wallet.value.name} onclick={onClickConfirm}><i class="fa-solid fa-check"></i></button>
  {/if}
</div>

{#if main.state.wallets_ready }
<div>
  {#if wallet == null }
    <h1 class="x">Wallet NOT FOUND!</h1>
  {:else}
    <h1 class="x">Delete Wallet</h1>
    <dl class="x mb-3">
      <dt>Name: </dt>
      <dd>{ wallet.value.name }</dd>
    </dl>
    <p class="mb-3 text-red-600 dark:text-red-500 font-medium">THIS ACTION IS NOT REVERSIBLE.</p>
    <input class="x-text-input w-full mb-4" required type="name" bind:value={input.name} placeholder={`Type the wallet's name "${wallet.value.name}"`} />
  {/if}
</div>
{/if}

