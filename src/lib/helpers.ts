import type { TokenIdentity } from './types.js';

export const getNativeBCHTokenIdentity = (): TokenIdentity => {
  return {
    verified: true,
    is_native_token: true,
    name: 'Bitcoin Cash',
    symbol_text: 'BCH',
    decimals: 8,
    icon_url: '/assets/bch-circle.svg',
  };
};

export const tokenDecimalAmount = (value: bigint, token_identity: TokenIdentity): string => {
  return bigIntToDecString(value, token_identity.decimals ? token_identity.decimals : 0);
};

export const bigIntToDecString = (value: bigint, decimals: number): string => {
  let sign;
  if (value < 0n) {
    sign = true;
    value = -1n * value;
  } else {
    sign = false;
  }
  const denominator = 10n ** BigInt(decimals);
  const digits = value / denominator;
  const dec = (value % denominator)+'';
  return (sign ? '-' : '') + digits + (dec.length > 0 && decimals > 0 ? '.' + '0'.repeat(decimals - dec.length) + dec :  '');
};

export const sanitizeExternalTokenText = (s: string): string => {
  return s.replace(/[^a-z\s0-9\-\_]/ig, '');
};
