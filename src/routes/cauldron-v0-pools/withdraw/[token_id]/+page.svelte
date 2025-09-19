  <script lang="ts">
  import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';

  import { getContext } from 'svelte';
  import * as app_navigation from '$app/navigation';
  import type { MainContext } from '$lib/main.svelte.ts';
  import type { Wallet } from '$lib/types.js';
  import type { PairPoolItemExtended, CauldronV0PoolsContext } from './types.js';
  import { page } from '$app/stores';
  import { pageURLFromLink, pagePathToLink } from '$lib/app-path-helpers.js';

  import {
    InvalidProgramState, ValueError, NATIVE_BCH_TOKEN_ID,
    outputToLibauthOutput, PayoutAmountRuleType, SpendableCoinType,
    createPayoutChainedTx, convertFractionDenominator,
  } from '@cashlab/common';
  import type {
    CreatePayoutTxContext, SpendableCoin, PayoutRule, ChainedTxResult,
  } from '@cashlab/common';
  import {
    getDustThreshold, lockingBytecodeToCashAddress, assertSuccess,
    SigningSerializationFlag, createVirtualMachineBCH
  } from '@cashlab/common/libauth.js';

  import {
    tokenDecimalAmount, sanitizeExternalTokenText, getNativeBCHTokenIdentity,
    bigIntToDecString,
  } from '$lib/helpers.js';
  import { addInteractionResponseToast } from '$lib/ui-helpers.js';
  import { publicKeyHashToP2pkhLockingBytecode } from '$lib/internal/util.js';
  import { withdrawPoolV0AsSpendableCoin } from '$lib/internal/cauldron-v0-pool-helpers.js';

  const main: MainContext = getContext('main');
  const context: CauldronPoolsContext = getContext('cauldron-v0-pools');  
  const bch_token_identity = getNativeBCHTokenIdentity();
  let payout_tx_error: string | null = $state(null);
  let deposit_wallet: Wallet | null = $state(null);
  let deposit_wallet_zeroth_index: boolean = $state(false);
  let deposit_address: { cashaddr: string, locking_bytecode } | null = $state(null);
  $effect(() => {
    if (deposit_wallet == null) {
      deposit_address = null;
    } else {
      let locking_bytecode;
      if (deposit_wallet.type === 'hd') {
        const state_manager = main.getWalletStateManager(deposit_wallet.id);
        if (state_manager == null) {
          throw new InvalidProgramState(`state_manager == null!!`);
        }
        if (deposit_wallet_zeroth_index) {
          locking_bytecode = state_manager.getAddress({ index: 0, is_change: false }).locking_bytecode;
        } else {
          locking_bytecode = state_manager.getUnusedAddress({ is_change: false }).locking_bytecode;
        }
      } else if (['p2pkh','p2pkh-watch'].indexOf(deposit_wallet.type) !== -1) {
        locking_bytecode = publicKeyHashToP2pkhLockingBytecode(deposit_wallet.pkh);
      } else {
        throw new ValueError(`unknown wallet type: ${deposit_wallet.type}`);
      }
      deposit_address = {
        locking_bytecode,
        cashaddr: assertSuccess(lockingBytecodeToCashAddress({ bytecode: locking_bytecode })).address,
      };
    }
  });
  const pair_pool: PairPoolItemExtended | undefined = $derived.by(() => {
    let output = context.state.grouped_pair_pool_list.with_key.find((a) => a.tokens.find((b) => b.token_id !== NATIVE_BCH_TOKEN_ID && b.token_id === $page.params.token_id) != null)
    if (output != null) {
      const pair_bch: { amount: bigint; token_id: TokenId; token_identity: { value: TokenIdentity }; } = output.tokens.find((a) => a.token_id === NATIVE_BCH_TOKEN_ID) as any;
      const pair_token = output.tokens.find((a) => a.token_id !== NATIVE_BCH_TOKEN_ID);
      if (!pair_bch || !pair_token) {
        throw new InvalidProgramState('!pair_bch || !pair_token');
      }
      output = {
        ...output,
        pair_bch,
        pair_token,
      };
    }
    return output;
  });
  let txfee_per_byte = $state(main.state.main_parameters.default_txfee_per_byte);
  let txfee_per_byte_dec = $derived(bigIntToDecString(convertFractionDenominator(txfee_per_byte, 1000000n).numerator, 6).replace(/\.?0+$/, ''));

  const onClickConfirm = function (event: MouseEvent): void {
    const onSent = () => {
      addInteractionResponseToast(event, { message: 'Sent!', type: 'success' })
      const page_url = pageURLFromLink(location);
      const query = Array.from(page_url.searchParams.entries());
      app_navigation.goto(pagePathToLink('/cauldron-v0-pools' + (query.length > 0 ? '?' + query.map((a) => encodeURIComponent(a[0]) + '=' + encodeURIComponent(a[1])).join('&') : '')));
    };
    if (this.disabled) {
      return;
    }
    this.disabled = true;
    ;(async () => {
      try {
        const DELAY_TIMEOUT = 1000;
        let counter = 0;
        for (const tx_result of payout_txchain_result.chain) {
          await main.client.broadcast(tx_result.txbin, true);
          if (counter + 1 !== payout_txchain_result.chain.length) {
            // delay 1000 ms
            await new Promise((resolve) => setTimeout(resolve, DELAY_TIMEOUT));
          }
          counter++;
        }
        onSent();
      } catch (err) {
        console.error(err);
        payout_tx_error = err.message;
      } finally {
        this.disabled = false;
      }
    })();
  };

  let txdetails: {
    ready: boolean;
    txcount: number;
    txfee: bigint;
    input_count: number;
  } = $state({
    ready: false,
    txcount: 0,
    txfee: 0n,
    input_count: 0,
  });
  let payout_txchain_result: ChainedTxResult | null = $state(null);

  // create withdraw transactions
  $effect(() => {
    try {
      if (pair_pool == null || deposit_address == null) {
        txdetails.ready = false;
        return;
      }
      const payout_rules: PayoutRule[] = [
        {
          type: PayoutAmountRuleType.CHANGE,
          locking_bytecode: deposit_address.locking_bytecode,
        },
      ];
      const input_coins: SpendableCoin[] = [];
      for (const group of pair_pool.grouped_utxo_map.values()) {
        const owner_info = group.owner_info_list.find((c) => c.private_key != null);
        if (owner_info == null) {
          throw new InvalidProgramState(`owner_info has no private key!`);
        }
        for (const utxo of group.utxo_map.values()) {
          input_coins.push(withdrawPoolV0AsSpendableCoin(utxo, owner_info.private_key as Uint8Array, SigningSerializationFlag.allOutputs | SigningSerializationFlag.forkId | SigningSerializationFlag.utxos));
        }
      }
      if (input_coins.length === 0) {
        txdetails.ready = false;
        return;
      }
      const create_payout_context: CreatePayoutTxContext = {
        txfee_per_byte: $state.snapshot(txfee_per_byte),
        getOutputMinAmount (output: Output): bigint {
          return getDustThreshold(outputToLibauthOutput(output));
        },
        getPreferredTokenOutputBCHAmount (output: Output): bigint | null {
          return main.state.main_parameters.preferred_token_output_bch_amount;
        },
      };
      const result: ChainedTxResult = createPayoutChainedTx(create_payout_context, input_coins, payout_rules);
      txdetails = {
        ready: true,
        txcount: result.chain.length,
        txfee: result.txfee,
        input_count: result.chain.map((a) => a.libauth_transaction.inputs.length).reduce((a, b) => a + b, 0),
      };
      payout_txchain_result = result;
      for (const tx_result of result.chain) {
        const vm = createVirtualMachineBCH();
        const result = vm.verify({
          sourceOutputs: tx_result.libauth_source_outputs,
          transaction: tx_result.libauth_transaction,
        });
        if (typeof result == 'string') {
          throw new ValueError(result);
        }
      }
    } catch (err) {
      payout_tx_error = err.message;
      console.error(err);
    }
  });

  const onReloadTokenIdentity = (token_id: string): void => {
    main.reloadTokenIdentity(token_id);
  };
</script>

<div class="flex flex-row items-center mb-2" role="group">
  <button class="x-icon x-secondary" aria-label="Back" onclick={() => history.back()}><i class="fa-solid fa-arrow-left"></i></button>
  <div class="grow"></div>
  {#if txdetails.ready }
  <button class="x-icon x-primary" aria-label="Confirm" onclick={onClickConfirm}><i class="fa-solid fa-check"></i></button>
  {/if}
</div>

{#if pair_pool == null || !main.state.runtime_ready }
<div class="p-2 flex flex-row mb-2">
  <LoadingSpinner size="24" class="me-2" />
  <div class="x-token-id whitespace-nowrap">token_id: 0x{ $page.params.token_id }</div>
</div>
{:else}
<div class="px-3">
  {#if payout_tx_error }
  <p class="p-2 font-medium text-red-600"><strong>{ payout_tx_error }</strong></p>   
  {/if}
  <h3 class="x">Withdraw Details</h3>
  <div class="flex flex-row place-content-evenly">
    <div class="px-2 py-1">
      {#if pair_pool.pair_token.token_identity.value }
      <div class="flex flex-row">
        <span class="me-2">
          {#if pair_pool.pair_token.token_identity.value.verified === true }
          <i class="x-verified-symbol fa-solid fa-check"></i>
          {:else}
          <i class="x-unverified-symbol fa-solid fa-triangle-exclamation"></i>
          {/if}
        </span>
        <div class="flex flex-col">
          <span class="x-token-name mb-1">
            { sanitizeExternalTokenText(pair_pool.pair_token.token_identity.value.name) }
          </span>
          <div class="flex flex-row mb-1 items-center">
            <span class="x-pool-pair-icon me-1">
              <img class="primary" src={pair_pool.pair_bch.token_identity.value.icon_url} alt={sanitizeExternalTokenText(pair_pool.pair_bch.token_identity.value.symbol_text)} />
              <img class="secondary" src={pair_pool.pair_token.token_identity.value.icon_url} alt={sanitizeExternalTokenText(pair_pool.pair_token.token_identity.value.symbol_text)} />
            </span>
            <div class="flex flex-row">
              <a class="x-token-explorer-link" target="_blank" href={main.state.token_explorer_endpoint + encodeURIComponent(pair_pool.pair_token.token_id)} aria-label="View in token explorer"><i class="fa-solid fa-eye"></i></a>
              {#if pair_pool.pair_token.token_identity.value?.webpage_url }
              <a class="x-token-webpage-link" target="_blank" href={pair_pool.pair_token.token_identity.value.webpage_url} aria-label="Token webpage"><i class="fa-solid fa-globe"></i></a>
              {/if}
            </div>
          </div>
          <span class="x-pool-pair-symbols">
            { sanitizeExternalTokenText(pair_pool.pair_bch.token_identity.value.symbol_text) }/{ sanitizeExternalTokenText(pair_pool.pair_token.token_identity.value.symbol_text) }
          </span>
        </div>
      </div>
      {:else}
      <div class="flex flex-row items-center">
        <div class="me-2 w-6 h-6 flex items-center justify-center">
          {#if pair_pool.pair_token.token_identity.loader_state == null }
          <span>??</span>
          {:else if pair_pool.pair_token.token_identity.loader_state.request_status === 'loading' }
          <LoadingSpinner size="16" />
          {:else if pair_pool.pair_token.token_identity.loader_state.request_status === 'pending' }
          <i class="fa-solid fa-hourglass-half"></i>
          {:else}
          {#if !pair_pool.pair_token.token_identity.loader_state.has_no_record }
          <button type="button" class="x-icon x-sm" aria-label="Reload" onclick={() => onReloadTokenIdentity(pair_pool.pair_token.token_id)}><i class="fa-solid fa-rotate-right"></i></button>
          {/if}
          {/if}
        </div>
        <a class="x-token-id w-25 x-token-explorer-link whitespace-nowrap" target="_blank" href={main.state.token_explorer_endpoint + encodeURIComponent(pair_pool.pair_token.token_id)} aria-label="View in token explorer">
          <i class="fa-solid fa-eye"></i>
          0x{ pair_pool.pair_token.token_id }
        </a>
      </div>
      {/if}
    </div>
    <div class="">
      <div class="flex flex-col w-fit items-stretch">
        {#each pair_pool.tokens as token (token.token_id)}
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
    </div>
  </div>
  {#if deposit_wallet && deposit_wallet.type.indexOf('watch') !== -1}
  <p class="p-2 font-medium text-red-600"><strong>This is a Watch-Only wallet, This wallet cannot access the funds deposited to watch wallets. ONLY CONFIRM IF YOU KNOW WHAT YOU&apos;RE DOING.</strong></p>
  {/if}
  <div class="p-1 mb-2">
    <div class="me-2">Deposit to: </div>
    <select class="x w-full mb-1" required bind:value={deposit_wallet}>
      <option value={null}>Select a wallet</option>
      {#each main.state.wallets as wallet (wallet.value.id) }
      <option value={wallet.value}>{wallet.value.name + (wallet.value.type.indexOf('watch') === -1 ? '' : ' (Watch-Only)')}</option>
      {/each}
    </select>
    {#if deposit_wallet && deposit_wallet.type === 'hd' }
    <div class="ps-2">
      <label>
        <input type="checkbox" bind:checked={deposit_wallet_zeroth_index} />
        Use hd wallet&apos;s zeroth index
      </label>
    </div>
    {/if}
  </div>
  {#if txdetails.ready }
  <p class="mb-1">
    Confirm to sign & broadcast the withdraw transaction(s).
  </p>
  <dl class="x mb-2">
    <dt class="mb-1">Deposit address</dt>
    <dd class="x-cashaddr-text">{ deposit_address ? deposit_address.cashaddr : '' }</dd>
    <dt>Number of transactions</dt>
    <dd>{ txdetails.txcount }</dd>
    <dt>Number of inputs</dt>
    <dd>{ txdetails.input_count }</dd>
    <dt>Transaction fee</dt>
    <dd>
      <span class="x-token-amount">{ tokenDecimalAmount(txdetails.txfee, bch_token_identity) }</span>
      <span class="x-token-symbol">{ sanitizeExternalTokenText(bch_token_identity.symbol_text) }</span>
    </dd>
    <dt>Transaction fee rate (sat/byte)</dt>
    <dd>{ txfee_per_byte_dec }</dd>
  </dl>
  {:else}
    {#if deposit_wallet != null }
    <div class="p-3 flex items-center justify-center">
      <LoadingSpinner size="32" />
    </div>
    {/if}
  {/if}
</div>
{/if}
