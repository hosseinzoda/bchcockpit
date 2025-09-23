<script lang="ts">
	import '../app.css';
  import { setContext } from 'svelte';
  import { createMainContext } from '$lib/main.svelte.ts';
  import { page } from '$app/stores';
  import { asset, resolve } from '$lib/app-path-helpers.js';

  const main = createMainContext();
  setContext('main', main);
	let { children } = $props();

  const nav_items = [
    {
      label: 'Wallets',
      href: resolve('/wallets'),
    },
    
    {
      label: 'Pools',
      href: resolve('/cauldron-v0-pools'),
    },
    {
      label: 'About',
      href: resolve('/about'),
    },
  ];
</script>

<svelte:head>
</svelte:head>

<style>
.client-status {
  width: 16px;
  height: 16px;
  border-radius: 8px;
  background-color: light-grey;
}
.client-status.status-connected {
  background-color: var(--primary-green);
}
.client-status.status-connecting {
  background-color: orange;
}
.client-status.status-disconnected {
  background-color: red;
}

.fatal-error-modal {
  display: none;
  background-color: rgba(0, 0, 0, 0.3);
  position: fixed;         
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  align-items: center;
  justify-content: center;
}
.fatal-error-modal.show {
  display: flex;
}
.fatal-error-modal .dialog {
  display: block;
  width: 450px;
  background-color: white;
  color: black;
  border-radius: 7px;
  padding: 15px;
}

</style>

<div class="container mx-auto px-4 py-4 max-w-md">
  <div class="flex flex-wrap flex-row text-sm font-medium text-center text-gray-500 border-b border-gray-200 dark:border-gray-700 dark:text-gray-400">
    <nav class="main-nav flex flex-row items-center gap-1">
      <a class="rounded-t-lg hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 dark:hover:text-gray-300 mr-3" href={resolve('/')}><img src={asset('/favicon-192x192.png')} alt="BCH-Cockpit" width="48" height="48" /></a>
      {#each nav_items as nav_item (nav_item.href)}
        <a {...(($page.route.id||'').startsWith(nav_item.href) ? {'aria-current': 'page', class: 'p-4 text-blue-600 bg-gray-100 rounded-t-lg active dark:bg-gray-800 dark:text-blue-500'} : { class: 'p-4 rounded-t-lg hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 dark:hover:text-gray-300' })}href={nav_item.href}>{ nav_item.label }</a>
      {/each}
    </nav>
    <div class="flex-grow-1"></div>
    <div class="flex flex-row items-center">
      <div class={['client-status', main.state.client_connecting ? 'status-connecting' : (main.state.client_connected ? 'status-connected' : 'status-disconnected')]}></div>
    </div>
  </div>

  <div class="py-3">
    {@render children?.()}
  </div>
</div>

<div class={['fatal-error-modal', main.state.fatal_error != null ? 'show' : '']}>
  <div class="dialog">
    <div>{ main.state.fatal_error }</div>
  </div>
</div>
