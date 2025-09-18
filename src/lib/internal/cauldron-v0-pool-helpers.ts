import type {
  UTXO, SpendableCoin, InputParams, Output,
} from '@cashlab/common/types.js';
import * as libauth from '@cashlab/common/libauth.js';
const {
  assertSuccess, encodeDataPush, hash256, hash160, secp256k1,
} = libauth;
import {
  InvalidProgramState, SpendableCoinType, outputToLibauthOutput, uint8ArrayConcat,
} from '@cashlab/common';
import { buildPoolV0RedeemScriptBytecode } from '@cashlab/cauldron/binutil.js';

export function withdrawPoolV0AsSpendableCoin (utxo: UTXO, private_key: Uint8Array, sighash_flags: libauth.SigningSerializationFlag): SpendableCoin {
  return {
    type: SpendableCoinType.UNLOCK_ON_DEMAND,
    unlock: (input_index: number, input: InputParams<Output>, inputs: InputParams<Output>[], outputs: Output[], txparams: { locktime: number, version: number }): Uint8Array => {
      const flags = Uint8Array.from([sighash_flags])
      const la_input_utx_output = outputToLibauthOutput(input.utxo.output);
      const pubkey = assertSuccess(secp256k1.derivePublicKeyCompressed(private_key));
      const pkh = hash160(pubkey);
      const redeem_script = buildPoolV0RedeemScriptBytecode({ withdraw_pubkey_hash: pkh });
      const sighash_preimage = libauth.encodeSigningSerializationBCH({
        locktime: txparams.locktime,
        version: txparams.version,
        correspondingOutput: input_index < outputs.length ?
          libauth.encodeTransactionOutput(outputToLibauthOutput(outputs[input_index] as Output)) :
          undefined,
        outpointIndex: input.utxo.outpoint.index,
        outpointTransactionHash: input.utxo.outpoint.txhash,
        outputTokenPrefix: libauth.encodeTokenPrefix(la_input_utx_output.token),
        outputValue: libauth.valueSatoshisToBin(la_input_utx_output.valueSatoshis),
        sequenceNumber: input.sequence_number,
        transactionOutpoints: libauth.encodeTransactionOutpoints(inputs.map((a) => ({
          outpointIndex: a.utxo.outpoint.index,
          outpointTransactionHash: a.utxo.outpoint.txhash,
        }))),
        transactionOutputs: libauth.encodeTransactionOutputsForSigning(outputs.map(outputToLibauthOutput)),
        transactionSequenceNumbers: libauth.encodeTransactionInputSequenceNumbersForSigning(inputs.map((a) => ({
          sequenceNumber: a.sequence_number,
        }))),
        transactionUtxos: libauth.encodeTransactionOutputsForSigning(inputs.map((a) => outputToLibauthOutput(a.utxo.output))),
        coveredBytecode: redeem_script,
        signingSerializationType: flags,
      });
      const sighash = hash256(sighash_preimage);
      const sig = assertSuccess(secp256k1.signMessageHashSchnorr(private_key, sighash));
      return uint8ArrayConcat([
        // p2sh32 unlocking bytecode
        encodeDataPush(uint8ArrayConcat([sig, flags])), // <sig>
        encodeDataPush(pubkey), // <pubkey>
        encodeDataPush(redeem_script), // <redeem_script>
      ]);
    },
    ...utxo,
  };
}

export function poolV0LockingBytecode (pkh: Uint8Array): Uint8Array {
  const redeem_script = buildPoolV0RedeemScriptBytecode({ withdraw_pubkey_hash: pkh });
  return libauth.encodeLockingBytecodeP2sh32(hash256(redeem_script));
}
