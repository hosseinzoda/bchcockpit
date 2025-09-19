<script lang="ts">
  import { getContext } from 'svelte';
  import type { MainContext } from '$lib/main.svelte.ts';
  import { ValueError } from '@cashlab/common/exceptions.js';
  import {
    assertSuccess, decodePrivateKeyWif, secp256k1, hash160, binToHex,
    deriveHdPrivateNodeFromBip39Mnemonic, deriveHdPath,
    decodeCashAddress, publicKeyToP2pkhLockingBytecode,
  } from '@cashlab/common/libauth.js';
  import * as app_navigation from '$app/navigation';
  import { pagePathToLink } from '$lib/app-path-helpers.js';

  const main: MainContext = getContext('main');

  const input = $state({
    name: '',
    type: null,
    wif: '',
    address: '',
    seed_word_count: 12,
    derivation_path: "m/44'/0'/0'", // default derivation path
    is_with_passphrase: false,
    passphrase: '',
  });
  let input_seed = $state([]);
  $effect(() => input_seed = new Array(input.seed_word_count).map(() => ''));
  let error = $state('');

  const onHdWalletWordInput = (event: InputEvent, index: number) => {
    const pieces = event.data.split(/\s+/g).filter((a, i) =>  i === 0 || !!a);
    if (pieces.length > 1) {
      pieces[0] = event.target.value + pieces[0];
      event.preventDefault();
      for (let i = index, c = 0; i < input_seed.length && c < pieces.length; i++, c++) {
        input_seed[i] = pieces[c];
      }
      // last element
      const last_element = event.target.parentNode.parentNode.querySelector(`input[x-index="${Math.min(input_seed.length - 1, index + pieces.length - 1)}"]`);
      if (last_element != null) {
        last_element.focus();
      }
    }
  };

  const onSubmitClicked = () => {
    try {
      error = '';
      let wallet: Wallet;
      if (!input.name) {
        throw new ValueError(`A name is required!`);
      }
      switch (input.type) {
        case 'p2pkh': {
          if (!input.wif) {
            throw new ValueError(`Enter the p2pkh's private key (expecting a wif formatted private key)!`);
          }
          try {
            const private_key = assertSuccess(decodePrivateKeyWif(input.wif)).privateKey;
            const public_key = assertSuccess(secp256k1.derivePublicKeyCompressed(private_key));
            const public_key_hash = hash160(public_key);
            wallet = {
              id: 'p2pkh:' + binToHex(public_key_hash),
              type: 'p2pkh',
              name: input.name,
              enabled: true,
              pkh: public_key_hash,
              private_key,
            };
          } catch (err) {
            throw new ValueError(`Invalid wif, ${err.message}`);
          }
          break;
        }
        case 'p2pkh-watch': {
          if (!input.address) {
            throw new ValueError(`Enter the p2pkh's address (expecting a bitcoincash address)!`);
          }
          let address_info;
          try {
            address_info = assertSuccess(decodeCashAddress(input.address));
          } catch (err) {
            throw new ValueError(`Invalid address, ${err.message}`);
          }
          if (['p2pkh', 'p2pkhWithTokens'].indexOf(address_info.type) === -1) {
            throw new ValueError(`Expecting a p2pkh address, got: ${address_info.type}`);
          }
          const public_key_hash = address_info.payload;
          wallet = {
            id: 'p2pkh-watch:' + binToHex(public_key_hash),
            type: 'p2pkh-watch',
            name: input.name,
            enabled: true,
            pkh: public_key_hash,
          };
          break;
        }
        case 'hd': {
          if (input_seed.filter((a) => typeof a === 'string' && a.length > 0).length !== input_seed.length) {
            throw new ValueError(`Seed phrase is not complete.`);
          }
          try {
            // test the hd wallet
            const passphrase = input.is_with_passphrase ? input.passphrase : undefined;
            const seed_phrase = input_seed.join(' ');
            const node = deriveHdPrivateNodeFromBip39Mnemonic(seed_phrase, { passphrase });
            const zeroth_key = assertSuccess(deriveHdPath(node, input.derivation_path + '/0/0')).privateKey;
            const zeroth_public_key = assertSuccess(secp256k1.derivePublicKeyCompressed(zeroth_key));
            const zeroth_locking_bytecode = assertSuccess(publicKeyToP2pkhLockingBytecode({ publicKey: zeroth_public_key }));
            wallet = {
              id: 'hd-p2pkh:' + binToHex(zeroth_locking_bytecode),
              type: 'hd',
              name: input.name,
              enabled: true,
              seed: seed_phrase,
              ...Object.fromEntries([
                [ 'passphrase', passphrase ],
              ].filter((a) => a[1] != null)) as { passphrase?: string },
              derivation_path: input.derivation_path,
            };
          } catch (err) {
            throw new ValueError(`Invalid seed/derivation_path, ${err.message||err}`);
          }
          break;
        }
        default: {
          throw new ValueError(`Wallet type not selected!`);
          break;
        }
      }
      main.wallet_store.addWallet(wallet);
      app_navigation.goto(pagePathToLink('/wallets'));
    } catch (err) {
      if (err instanceof ValueError) {
        error = err.message;
      } else {
        throw err;
      }
    }
  };
</script>

<h1 class="x">Add Wallet</h1>
<input class="x-text-input w-full mb-4" required type="name" bind:value={input.name} placeholder="Choose a name for the wallet" />
<select class="x w-full mb-4" required bind:value={input.type}>
  <option value={null}>Select a type</option>
  <option value="p2pkh">P2PKH</option>
  <option value="p2pkh-watch">P2PKH-Watch</option>
  <option value="hd">Seed (hd-wallet bip39)</option>
</select>
{#if input.type === 'p2pkh'}
  <input required type="wif" class="x-text-input mb-4" bind:value={input.wif} placeholder="wif formatted private key" autocomplete="off" autocorrect="off" autocapitalize="off" />
{:else if input.type === 'p2pkh-watch'}
  <input required type="crypto-address" class="x-text-input mb-4" bind:value={input.address} placeholder="bitcoincash:...." />
{:else if input.type === 'hd'}
  <select class="x mb-4" required bind:value={input.seed_word_count}>
    <option value={12}>12 words</option>
    <option value={24}>24 words</option>
  </select>
  <p class="pb-3">BIP39 seed phrase</p>
  <div class="flex flex-row gap-2 flex-wrap items-center justify-center mb-4">
    {#each input_seed as item, index (index) }
      <label for={'add-wallet-seed-input-'+index} class="block">
        <span class="inline-block min-w-5 text-center">{index + 1}.</span>
        <input id={'add-wallet-seed-input-'+index} class="x-text-input !inline-block w-25" required type="crypto-seed-word" bind:value={input_seed[index]} autocomplete="off" autocorrect="off" autocapitalize="off" x-index={index} onbeforeinput={(event) => onHdWalletWordInput(event, index)} />
      </label>
    {/each}
  </div>
  <div class="mb-4">
    <label for="add-wallet-derivation-path">
      <span class="inline-block mr-2">Derivation Path:</span>
      <input id="add-wallet-derivation-path" required type="derivation-path" class="x-text-input !inline-block" bind:value={input.derivation_path} autocomplete="off" autocorrect="off" autocapitalize="off" />
    </label>
  </div>
  <div class="mb-2">
    <label for="add-wallet-is-with-passphrase">
      <input type="checkbox" bind:checked={input.is_with_passphrase} />
      With passphrase
    </label>
  </div>
  {#if input.is_with_passphrase }
  <div class="mb-4">
    <label for="add-wallet-passphrase">
      <span class="inline-block mr-2">Passphrase:</span>
      <input id="add-wallet-passphrase" required type="passphrase" class="x-text-input !inline-block" bind:value={input.passphrase} autocomplete="off" autocorrect="off" autocapitalize="off" />
    </label>
  </div>
  {/if}
{/if}
{#if error}
  <p class="my-3 text-sm text-red-600 dark:text-red-500 font-medium">Error: {error}</p>
{/if}
<button class="x !bg-blue-700 !text-gray-50 dark:!bg-gray-700 dark:!text-gray-100" onclick={onSubmitClicked}>Submit</button>


