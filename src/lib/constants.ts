

export const DEFAULT_BCH_ELECTRON_CLIENT_PARAMETERS = {
  electrum_node_url: 'wss://electrum.imaginary.cash:50004/',
};

export const DEFAULT_IPFS_ENDPOINT = 'https://ipfs.io/ipfs/';

export const VERIFIED_TOKEN_BCMR_MAP: { [token_id: string]: { verified_contents_hash_set: Set<string> } } = {
  // MUSDV1
  'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366': {
    verified_contents_hash_set: new Set(['0e9fd254f8ed69c524acffb692adcbe0500cb84a331e0a772788439788c742cb']),
  },
  'b79bfc8246b5fc4707e7c7dedcb6619ef1ab91f494a790c20b0f4c422ed95b92': {
    verified_contents_hash_set: new Set(['c705cc90a56ac7ef9a15ef90ebbc8ba7e60e4c622e5464d52d8baf7887949fcc']),
  },
};

export const TOKEN_EXPLORER_ENDPOINT = 'https://tokenexplorer.cash/?tokenId=';

export const DEFAULT_TX_FEE_PER_BYTE = {
  numerator: 1n,
  denominator: 1n,
};

export const DEFAULT_PREFERRED_TOKEN_OUTPUT_BCH_AMOUNT = 800n;

export const DEFAULT_BIP39_DERIVATION_PATH = `m/44'/145'/0'`;

