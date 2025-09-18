import type { TokenIdentity, TokenIdentityLoaderRequestStatus } from './types.js';
import { VERIFIED_TOKEN_BCMR_MAP } from './constants.js';
import type { Registry, IdentitySnapshot } from './internal/bcmr-v2.schema.js';
import type {
  BCMROPReturnData, FetchAuthChainBCMRResult,
} from './internal/bcmr-helpers.ts';
import {
  fetchBCMRFromAuthChainWithAuthBase, fetchBCMRContents, validateBCMRRegistry,
  pullTokenIdentitySnapshotFromRegistry, urlFromBCMROPReturnUrl,
} from './internal/bcmr-helpers.js';
import {
  NotImplemented, Exception, ValueError, NotFoundError, NetworkError
} from './internal/exceptions.js';
import type { TokenId } from '@cashlab/common';
import type { BCHElectronClient } from './internal/bch-electron-client.js';
import { binToHex, hexToBin } from '@cashlab/common/libauth.js';

type TokenBCMRContentsDBRecord =  {
  id: string;
  content: Uint8Array;
  urls: string[];
  content_hash: Uint8Array
  token_id: TokenId;
};

type FetchIdentityListeners = {
  status_change: Array<(event: { status: TokenIdentityLoaderRequestStatus }) => void>;
  resolve: Array<(token_identity: TokenIdentity | null) => void>;
  reject: Array<(except: Exception) => void>;
};

export type TokenRegistryManagerParameters = {
  ipfs_endpoint?: string;
};

export type TokenRegistryManager = {
  setParameters (parameters: TokenRegistryManagerParameters): void;
  onDBConnected (db: IDBDatabase): void;
  onDBDisconnected (db: IDBDatabase): void;
  onClientConnected (client: BCHElectronClient): void;
  onClientDisconnected (client: BCHElectronClient): void;
  requestTokenIdentity (token_id: TokenId, listeners: {
    onStatusChange: (event: { status: TokenIdentityLoaderRequestStatus }) => void,
    onResolve: (token_identity: TokenIdentity | null) => void,
    onReject: (exception: Exception) => void,
  }): void;
};

export class TokenRegistryManagerNotSupported implements TokenRegistryManager {
  setParameters (parameters: TokenRegistryManagerParameters) {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  onDBConnected (db: IDBDatabase): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  onDBDisconnected (db: IDBDatabase): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  onClientConnected (client: BCHElectronClient): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  onClientDisconnected (client: BCHElectronClient): void {
    throw new NotImplemented('Can only invoke in runtime!'); 
  }
  requestTokenIdentity (token_id: TokenId, listeners: {
    onStatusChange: (event: { status: TokenIdentityLoaderRequestStatus }) => void,
    onResolve: (token_identity: TokenIdentity | null) => void,
    onReject: (exception: Exception) => void,
  }) {
    throw new NotImplemented('Can only invoke in runtime!'); 
  }
}

export class TokenRegistryManagerRuntime implements TokenRegistryManager {
  db: IDBDatabase | null;
  client: BCHElectronClient | null;
  pending_fetch_requests: Array<{ token_id: TokenId, listeners: FetchIdentityListeners }>;
  running_fetch_requests: Array<{ token_id: TokenId, listeners: FetchIdentityListeners }>;
  max_concurrent_fetch_requests: number;
  parameters: TokenRegistryManagerParameters;
  constructor (parameters: TokenRegistryManagerParameters) {
    this.db = null;
    this.client = null;
    this.parameters = parameters;
    // bind event listeners
    for (const name of [ 'onClientConnected', 'onClientDisconnected' ]) {
      (this as any)[name] = (this as any)[name].bind(this);
    }
    this.pending_fetch_requests = [];
    this.running_fetch_requests = [];
    this.max_concurrent_fetch_requests = 20;
  }

  setParameters (parameters: TokenRegistryManagerParameters) {
    this.parameters = parameters;
  }

  onDBConnected (db: IDBDatabase): void {
    this.db = db;
  }
  onDBDisconnected (db: IDBDatabase): void {
    this.db = null
  }

  onClientConnected (client: BCHElectronClient): void {
    this.client = client;
    this.dequeueFetchTokenIdentity();
  }
  onClientDisconnected (client: BCHElectronClient): void {
    this.client = null;
  }

  requestTokenIdentity (token_id: TokenId, listeners: {
    onStatusChange: (event: { status: TokenIdentityLoaderRequestStatus }) => void,
    onResolve: (token_identity: TokenIdentity | null) => void,
    onReject: (exception: Exception) => void,
  }): void {
    let item;
    const request_item = this.running_fetch_requests.find((a) => a.token_id === token_id);
    if (request_item != null) {
      item = request_item;
      listeners.onStatusChange({ status: 'loading' });
    } else {
      const pending_item = this.pending_fetch_requests.find((a) => a.token_id === token_id);
      if (pending_item != null) {
        item = pending_item;
      } else {
        item = {
          token_id,
          listeners: {
            status_change: [],
            resolve: [],
            reject: [],
          },
        };
        this.pending_fetch_requests.push(item);
      }
      listeners.onStatusChange({ status: 'pending' });
    }
    item.listeners.status_change.push(listeners.onStatusChange);
    item.listeners.resolve.push(listeners.onResolve);
    item.listeners.reject.push(listeners.onReject);
    this.dequeueFetchTokenIdentity();
  }
  
  async dequeueFetchTokenIdentity (): Promise<void> {
    if (this.client == null) {
      return;
    }
    const dt = new Date();
    while (this.pending_fetch_requests.length > 0 &&
      this.running_fetch_requests.length < this.max_concurrent_fetch_requests) {
      const item = this.pending_fetch_requests.shift();
      if (item == null) {
        continue;
      }
      const onEnd = () => {
        for (const listener of item.listeners.status_change) {
          listener({ status: null });
        }
        const idx = this.running_fetch_requests.findIndex((a) => a.token_id === item.token_id);
        if (idx !== -1) {
          this.running_fetch_requests.splice(idx, 1);
        }
        this.dequeueFetchTokenIdentity();
      };
      const onResolve = (token_identity: TokenIdentity | null) => {
        onEnd();
        for (const listener of item.listeners.resolve) {
          listener(token_identity);
        }
      };
      const onReject = (exc: Exception) => {
        onEnd();
        for (const listener of item.listeners.reject) {
          listener(exc);
        }
      };
      for (const listener of item.listeners.status_change) {
        listener({ status: 'loading' });
      }
      this.fetchTokenIdentity(item.token_id, dt)
        .then(onResolve, onReject);
      this.running_fetch_requests.push(item);
    }
  }

  async fetchTokenBCMR (token_id: TokenId, bcmr_opreturn_data: BCMROPReturnData): Promise<Registry> {
    try {
      const result: TokenBCMRContentsDBRecord | undefined = await new Promise((resolve, reject) => {
        if (this.db == null) {
          return resolve(undefined);
        }
        const dbtx = this.db.transaction('token-bcmr-contents', 'readonly');
        const db_bcmr_contents = dbtx.objectStore('token-bcmr-contents');
        const request = db_bcmr_contents.get(`token:${token_id}|hash:${binToHex(bcmr_opreturn_data.content_hash)}`);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error);
        };
      });
      if (result != null) {
        return validateBCMRRegistry(result.content, bcmr_opreturn_data.content_hash);
      }
    } catch (err) {
      console.warn(`load from db token-bcmr-contents fail, `, err);
    }
    const urls = bcmr_opreturn_data.urls.map((url) => {
      return urlFromBCMROPReturnUrl(url, { ipfs_endpoint: this.parameters.ipfs_endpoint });
    });
    const content = await fetchBCMRContents(urls);
    const registry = validateBCMRRegistry(content, bcmr_opreturn_data.content_hash);
    try {
      await new Promise<void>((resolve, reject) => {
        if (this.db == null) {
          return resolve();
        }
        const dbtx = this.db.transaction('token-bcmr-contents', 'readwrite');
        const db_bcmr_contents = dbtx.objectStore('token-bcmr-contents');
        const request = db_bcmr_contents.put({
          id: `token:${token_id}|hash:${binToHex(bcmr_opreturn_data.content_hash)}`,
          content,
          urls: bcmr_opreturn_data.urls,
          content_hash: bcmr_opreturn_data.content_hash,
          token_id,
        });
        request.onerror = () => {
          reject(request.error)
        };
        dbtx.oncomplete = () => {
          resolve();
        };
      });
    } catch (err) {
      console.warn(`save to db token-bcmr-contents fail, `, err);
    }
    return registry;
  }

  async loadTokenIdentitySnapshot (token_id: TokenId, dt: Date): Promise<{
    authchain: Array<{
      txhash: Uint8Array;
      bcmr: BCMROPReturnData | null;
    }>,
    identity: IdentitySnapshot,
    identity_bcmr: BCMROPReturnData,
    registry: Registry
  }> {
    if (this.client == null) {
      throw new NetworkError(`client is not available!`);
    }
    if (this.db == null) {
      throw new Error(`this.db is null`);
    }
    const authbase_txhash = hexToBin(token_id);
    const result: FetchAuthChainBCMRResult = await fetchBCMRFromAuthChainWithAuthBase(this.client, authbase_txhash, this.db);
    const chain = result.chain.filter((a) => a.bcmr != null);
    if (chain.length == 0) {
      throw new NotFoundError(`No BCMR found!`);
    }
    const max_attempts = Math.min(chain.length, 3);
    let current_bcmr, registry, identity;
    let counter = 0;
    while (true) {
      try {
        current_bcmr = chain[chain.length - 1 - counter]?.bcmr as BCMROPReturnData;
        registry = await this.fetchTokenBCMR(token_id, current_bcmr);
        identity = pullTokenIdentitySnapshotFromRegistry(registry, token_id, dt);
        break;
      } catch (err) {
        if (counter + 1 < max_attempts) {
          console.warn(`Failed to register a bcmr token, trying earlier bcmr, token_id: ${token_id}, error: `, err);
          counter += 1;
        } else {
          throw err;
        }
      }
    }
    return {
      authchain: result.chain,
      identity_bcmr: current_bcmr,
      registry,
      identity,
    };
  }

  async fetchTokenIdentity (token_id: TokenId, dt: Date): Promise<TokenIdentity | null> {
    try {
      const { identity, identity_bcmr } = await this.loadTokenIdentitySnapshot(token_id, dt);
      if (identity.token == null) {
        throw new ValueError(`identity.token is null!`);
      }
      const uris = Object.fromEntries(
        Object.entries(identity.uris||[])
          .map((a) => {
            return [ a[0], urlFromBCMROPReturnUrl(a[1], { ipfs_endpoint: this.parameters.ipfs_endpoint }) ];
          })
      );
      return {
        is_native_token: false,
        verified: VERIFIED_TOKEN_BCMR_MAP[token_id] ? 
          VERIFIED_TOKEN_BCMR_MAP[token_id].verified_contents_hash_set.has(binToHex(identity_bcmr.content_hash)) : false,
        name: identity.name,
        description: identity.description,
        symbol_text: identity.token.symbol,
        decimals: identity.token.decimals,
        icon_url: uris.icon,
        webpage_url: uris.web,
      };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      } else {
        throw err;
      }
    }
  }

}

