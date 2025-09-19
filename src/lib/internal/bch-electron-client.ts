import type {
  ElectrumClientEvents, RPCNotification as ElectrumRPCNotification, 
  RPCParameter as ElectrumRPCParameter, RequestResponse as ElectrumRequestResponse,
} from '@electrum-cash/network';
import {
  ConnectionStatus as ElectrumConnectionStatus
} from '@electrum-cash/network';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import {
  binToHex, hashTransactionUiOrder,
} from '@cashlab/common/libauth.js';
import { ValueError, NotImplemented, InvalidProgramState } from '@cashlab/common/exceptions.js';
import { AbortException, NetworkError } from './exceptions.js';
import type { TimeoutId } from './types.js';

const BATCH_LIMIT_REACHED_RESEND_INTERVAL = 30 * 1000;
const BATCH_SEND_MAX_CHUNK_SIZE = 100;

export type BCHElectronClient = {
  getInitPromise (): Promise<void>;
  destroy (): Promise<void>;
  electrumSubscribe (method: string, ...args: ElectrumRPCParameter[]): Promise<void>;
  electrumUnsubscribe (method: string, ...args: ElectrumRPCParameter[]): Promise<void>;
  electrumRequest (method: string, ...args: ElectrumRPCParameter[]): Promise<ElectrumRequestResponse>;
  createBatchSenderCategory (name: string, params: BatchSenderCategoryParameters): void;
  enqueueElectrumBatchRequests (category_name: string, batch: Array<BatchRequestItem>, options?: { abort_signal?: AbortSignal }): void;
  broadcast (txbin: Uint8Array, wait_for_confirmation: boolean): Promise<{ txhash: string }>;
};

export class BCHElectronClientNotSupported implements BCHElectronClient {
  getInitPromise (): Promise<void> {
    return Promise.resolve();
  }
  destroy (): Promise<void> {
    return Promise.resolve();
  }
  async electrumSubscribe (method: string, ...args: ElectrumRPCParameter[]): Promise<void> {
    throw new NotImplemented('Can only invoke in runtime!'); 
  }
  async electrumUnsubscribe (method: string, ...args: ElectrumRPCParameter[]): Promise<void> {
    throw new NotImplemented('Can only invoke in runtime!'); 
  }
  async electrumRequest (method: string, ...args: ElectrumRPCParameter[]): Promise<ElectrumRequestResponse> {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  createBatchSenderCategory (name: string, params: BatchSenderCategoryParameters): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  enqueueElectrumBatchRequests (category_name: string, batch: Array<BatchRequestItem>, options?: { abort_signal?: AbortSignal }): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  broadcast (txbin: Uint8Array, wait_for_confirmation: boolean): Promise<{ txhash: string }> {
    throw new NotImplemented('Can only invoke in runtime!'); 
  }
};

export type BCHElectronClientParameters = {
  electrum_node_url: string;
};
export type BCHElectronClientManager = {
  onConnected (): void;
  onDisconnected (): void;
  onConnecting (): void;
  onElectrumNotification (message: ElectrumRPCNotification): void;
};

export type BatchRequestItem = {
  method: string;
  params: ElectrumRPCParameter[];
  onResolve: (result: ElectrumRequestResponse) => void;
  onReject: (error: Error) => void;
  onResponse?: (result: ElectrumRequestResponse) => void;
};

export type InternalBatchRequestItem = BatchRequestItem & {
  ended: boolean;
  request_id: number;
};

export type BatchSenderCategoryParameters = {
  rate_limit: {
    max: number;
    interval: number;
  };
};

export type BatchSenderCategoryState = {
  name: string;
  rate_limit: {
    max: number;
    interval: number;
  };
  rate_tracking_list: Array<{ ts: number, size: number }>;
  pending_response: InternalBatchRequestItem[];
  pending_send: InternalBatchRequestItem[];
  pause: boolean;
  next_schedule_timeout?: TimeoutId;
};

export class BCHElectronClientRuntime implements BCHElectronClient {
  parameters: BCHElectronClientParameters; 
  manager: BCHElectronClientManager;
  electrum_web_socket: ElectrumWebSocket;
  electrum_client: ElectrumClient<ElectrumClientEvents>;
  init_promise: Promise<void>;
  destroyed: boolean;
  batch_sender_state_map: Map<string, BatchSenderCategoryState>;
  batch_rate_limit_reached_timeout: TimeoutId | undefined;
  constructor (parameters: BCHElectronClientParameters, manager: BCHElectronClientManager) {
    this.parameters = parameters;
    this.manager = manager;
    this.destroyed = false;
    this.batch_sender_state_map = new Map();
    for (const listener_name of [
      'onElectrumNotification', 'onElectrumDisconnected', 'onElectrumConnected',
      'onElectrumConnecting',
    ]) {
      (this as any)[listener_name] = (this as any)[listener_name].bind(this);
    }
    const url = new URL(this.parameters.electrum_node_url);
    if (['wss:','ws:'].indexOf(url.protocol) == -1 || isNaN(parseInt(url.port||'443'))) {
      throw new ValueError('Expecting electrum-node to be a valid websocket url, got: ' + this.parameters.electrum_node_url);
    }
    const url_info = {
      host: url.hostname,
      port: parseInt(url.port||'443'),
      encrypted: url.protocol == 'wss:',
    };
    this.electrum_web_socket = new ElectrumWebSocket(
      url_info.host,
      url_info.port,
      url_info.encrypted
    );
    this.electrum_client = new ElectrumClient('electrum-cash', '1.4.3', this.electrum_web_socket, {
      disableBrowserVisibilityHandling: true,
      disableBrowserConnectivityHandling: true,
      sendKeepAliveIntervalInMilliSeconds: 30 * 1000,
    });
    this.electrum_client.addListener('notification', this.onElectrumNotification);
		this.electrum_client.addListener('disconnected', this.onElectrumDisconnected);
		this.electrum_client.addListener('connected', this.onElectrumConnected);
		this.electrum_client.addListener('connecting', this.onElectrumConnecting);
    // nullify resubscribeOnConnect, it's not expected for the client to resubscribe upon reconnect
    if ((this.electrum_client as any).resubscribeOnConnect != null) {
      const origResubscribeOnConnect = (this.electrum_client as any).resubscribeOnConnect;
      (this.electrum_client as any).resubscribeOnConnect = function () {
        this.subscriptionMethods = {};
        return origResubscribeOnConnect.apply(this, arguments);
      };
    }
    // better error reporting
	  if (typeof (this.electrum_client as any).response === 'function') {
      const self = this;
      const origResponse = (this.electrum_client as any).response;
      (this.electrum_client as any).response = function (message: any): void {
        if (message.id == null && message.error) {
          if (message.error.code === 4) {
            if (self.batch_rate_limit_reached_timeout != null) {
              return;
            }
            // batch rate limit reached
            console.warn(`batch rate limit reached, pause & reschedule resend in ${BATCH_LIMIT_REACHED_RESEND_INTERVAL/1000} seconds`);
            for (const batch_state of self.batch_sender_state_map.values()) {
              batch_state.pause = true;
            }
            self.batch_rate_limit_reached_timeout = setTimeout(() => {
              self.batch_rate_limit_reached_timeout = undefined;
              for (const batch_state of self.batch_sender_state_map.values()) {
                batch_state.pending_send = batch_state.pending_response.concat(batch_state.pending_send);
                batch_state.pending_response = [];
                batch_state.pause = false;
                self._dequeueBatchRequests(batch_state);
              }
            }, BATCH_LIMIT_REACHED_RESEND_INTERVAL); 
            return;
          } else {
            console.warn(`electrum-client error: (${message.error.code}) ${message.error.message}`);
          }
        }
        try {
          return origResponse.apply(this, arguments);
        } catch (err) {
          console.warn(`electrum-client.response handler failed, `, err);
        }
      };
    }

    this.init_promise = this.electrumClientConnect();
  }
  async electrumClientConnect () {
    try {
      await this.electrum_client.connect();
    } catch (err) {
      console.warn(`Initial connect attempt to electrum has failed, `, err);
    }
  }
  getInitPromise (): Promise<void> {
    if (this.destroyed) {
      throw new ValueError(`client has been destroyed!`);
    }
    return this.init_promise;
  }
  async destroy (): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.batch_rate_limit_reached_timeout != null) {
      clearTimeout(this.batch_rate_limit_reached_timeout);
    }
    for (const batch_state of this.batch_sender_state_map.values()) {
      if (batch_state.next_schedule_timeout != null) {
        clearTimeout(batch_state.next_schedule_timeout);
      }
    }
    this.electrum_client.removeListener('notification', this.onElectrumNotification);
		this.electrum_client.removeListener('disconnected', this.onElectrumDisconnected);
		this.electrum_client.removeListener('connected', this.onElectrumConnected);
		this.electrum_client.removeListener('connecting', this.onElectrumConnecting);
    await this.electrum_client.disconnect(true, true);
  }
  async prepare (): Promise<void> {
    await this.init_promise;
  }
  onElectrumNotification (message: ElectrumRPCNotification): void {
    this.manager.onElectrumNotification(message);
  }
  onElectrumDisconnected (): void {
    console.info(`Connection to the electrum node is lost.`);
    this.manager.onDisconnected();
  }
  onElectrumConnected (): void {
    console.info(`Connection to the electrum node is established.`);
    this.manager.onConnected();
  }
  onElectrumConnecting (): void {
    console.info(`Connecting to the electrum node.`);
    this.manager.onConnecting();
  }
  electrumSubscribe (method: string, ...args: ElectrumRPCParameter[]): Promise<void> {
    return this.electrum_client.subscribe(method, ...args);
  }
  electrumUnsubscribe (method: string, ...args: ElectrumRPCParameter[]): Promise<void> {
    return this.electrum_client.unsubscribe(method, ...args);
  }
  async electrumRequest (method: string, ...args: ElectrumRPCParameter[]): Promise<ElectrumRequestResponse> {
    const output = await this.electrum_client.request(method, ...args);
    if (output instanceof Error) {
      throw output;
    }
    return output;
  }
  createBatchSenderCategory (name: string, params: BatchSenderCategoryParameters): void {
    if (this.batch_sender_state_map.has(name)) {
      throw new ValueError(`batch-sender exists! name: ${name}`);
    }
    const state = {
      name,
      rate_limit: params.rate_limit,
      rate_tracking_list: [],
      pending_response: [],
      pending_send: [],
      pause: false,
    };
    this.batch_sender_state_map.set(name, state);
  }

  _scheduleNextDequeueBatchRequestsRateLimitReached (state: BatchSenderCategoryState, ctime: number): void {
    const tracking_item = state.rate_tracking_list[0];
    if (tracking_item == null) {
      throw new ValueError(`_scheduleNextDequeueBatchRequestsRateLimitReached called when rate_tracking_list.length is zero!`);
    }
    const next_call_delay = Math.max(state.rate_limit.interval - (ctime - tracking_item.ts) + 200, 200);
    state.next_schedule_timeout = setTimeout(() => {
      state.next_schedule_timeout = undefined;
      this._dequeueBatchRequests(state);
    }, next_call_delay);
  }
  _updateBatchRequestsRateLimit (state: BatchSenderCategoryState, ctime: number): number {
    for (let i = 0; i < state.rate_tracking_list.length; ++i) {
      const item = state.rate_tracking_list[i];
      if (item != null && item.ts + state.rate_limit.interval > ctime) {
        if (i > 0) {
          state.rate_tracking_list = state.rate_tracking_list.slice(i);
        }
        break;
      }
    }
    const reqcount = state.rate_tracking_list.reduce((a, b) => a + b.size, 0);
    return Math.min(state.rate_limit.max - reqcount, BATCH_SEND_MAX_CHUNK_SIZE);
  }
  _dequeueBatchRequests (state: BatchSenderCategoryState): void {
    try {
      if (state.pause) {
        return;
      }
		  if((this.electrum_client as any).connection.status !== ElectrumConnectionStatus.CONNECTED) {
			 throw new NetworkError(`Unable to send request to a disconnected server '${this.electrum_client.hostIdentifier}'.`);
		  }
      const ctime = performance.now();
      const limit = this._updateBatchRequestsRateLimit(state, ctime);
      if (limit <= 0) {
        this._scheduleNextDequeueBatchRequestsRateLimitReached(state, ctime);
        return; // skip
      }
      const prepareRequest = (item: InternalBatchRequestItem): { request: { id: number, method: string, params: ElectrumRPCParameter[] }, promise: Promise<void> } => {
        const request = {
          id: item.request_id,
          method: item.method,
          params: item.params,
        };
        return {
          request,
          promise: new Promise((resolve) => {
			      // Add a request resolver for this promise to the list of requests.
			      (this.electrum_client as any).requestResolvers[item.request_id] = (error?: Error, data?: ElectrumRequestResponse) => {
              try {
				        if(error) {
                  if (!item.ended) {
					          item.onReject(error);
                  }
				        } else {
                  if (item.onResponse != null) {
                    item.onResponse(data as ElectrumRequestResponse);
                  }
                  if (!item.ended) {
					          item.onResolve(data as ElectrumRequestResponse);
				          }
                }
              } catch (err) {
                console.warn(`Unhandled request onResolve/onReject, `, err);
              }
              { // remove from pending response
                const idx = state.pending_response.indexOf(item);
                state.pending_response.splice(idx, 1);
              }
              resolve();
			      };
          }),
        };
      };
      const promises = [];
      const chunk: Array<{ id: number, method: string, params: ElectrumRPCParameter[] }> = []
      // remove ended from pending_send while taking items to send
      let next_pending_send: InternalBatchRequestItem[] = [];
      let additional_pending_response: InternalBatchRequestItem[] = [];
      for (let i = 0; i < state.pending_send.length; i++) {
        if (chunk.length >= limit) {
          next_pending_send = state.pending_send.slice(i)
          break;
        }
        const item = state.pending_send[i];
        if (item != null && !item.ended) {
          const { request, promise } = prepareRequest(item);
          additional_pending_response.push(item);
          chunk.push(request);
          promises.push(promise);
        }
      }
      state.pending_response = state.pending_response.concat(additional_pending_response);
      state.pending_send = next_pending_send;
      if (chunk.length > 0) {
        state.rate_tracking_list.push({ ts: ctime, size: chunk.length });
        console.debug(`Sending batch requests, category: ${state.name}, count: ${chunk.length}`);
			  // send the requests
			  (this.electrum_client as any).connection.send(JSON.stringify(chunk));
        Promise.all(promises)
          .then(() => this._dequeueBatchRequests(state));
      }
    } catch (err) {
      for (const item of state.pending_response) {
        if (!item.ended) {
          item.ended = true;
          item.onReject(err as Error);
        }
      }
      state.pending_response = [];
      for (const item of state.pending_send) {
        if (!item.ended) {
          item.ended = true;
          item.onReject(err as Error);
        }
      }
      state.pending_send = [];
    }
  }
  enqueueElectrumBatchRequests (category_name: string, batch: Array<BatchRequestItem>, options?: { abort_signal?: AbortSignal }): void {
    if (options?.abort_signal) {
      if (options?.abort_signal.aborted) {
        const exc = new AbortException()
        for (const item of batch) {
          item.onReject(exc);
        }
        return;
      }
      options.abort_signal.addEventListener('abort', () => {
        const exc = new AbortException()
        for (const item of items) {
          if (!item.ended) {
            item.ended = true;
            item.onReject(exc);
          }
        }
      });
    }
    const state = this.batch_sender_state_map.get(category_name);
    if (state == null) {
      throw new ValueError(`unknown category name: ${category_name}`);
    }
    const items = batch.map((item) => {
      const request_id = (this.electrum_client as any).requestId + 1;
      if (isNaN(request_id)) {
        throw new InvalidProgramState('isNaN(request_id)');
      }
      (this.electrum_client as any).requestId = request_id;
      return {
        ...item,
        ended: false,
        request_id,
      };
    });
    for (const item of items) {
      state.pending_send.push(item);
    }
    this._dequeueBatchRequests(state);
  }
  broadcast (txbin: Uint8Array, wait_for_confirmation: boolean): Promise<{ txhash: string }>  {
    return new Promise(async (resolve, reject) => {
      try {
        const txhex = binToHex(txbin);
        const txhash = binToHex(hashTransactionUiOrder(txbin));
        if (wait_for_confirmation) {
          const onDisconnected = () => {
			      this.electrum_client.removeListener('disconnected', onDisconnected);
            this.electrum_client.removeListener('notification', onNotification);
            reject(new Error('Client disconnected before broadcast confirmation'));
          };
          const onNotification = (message: ElectrumRPCNotification): void  => {
            switch (message.method) {
              case 'blockchain.transaction.subscribe': {
                if (message.params == null) {
                  return;
                }
                const notif_txhash: string = (message.params as any[])[0];
                if (notif_txhash == txhash) {
                  if (message.params[1] == null) {
                    return
                  }
                  ;(async () => {
                    try {
                      await this.electrum_client.unsubscribe('blockchain.transaction.subscribe', txhash);
                    } catch (err) {
                      // pass
                    }
                  })();
			            this.electrum_client.removeListener('disconnected', onDisconnected);
                  this.electrum_client.removeListener('notification', onNotification);
                  resolve({ txhash });
                }
                break;
              }
            }
          }
			    this.electrum_client.addListener('disconnected', onDisconnected);
          this.electrum_client.addListener('notification', onNotification);
          await this.electrum_client.subscribe('blockchain.transaction.subscribe', txhash);
          try {
            await this.electrumRequest('blockchain.transaction.broadcast', txhex);
          } catch (err) {
            await this.electrum_client.unsubscribe('blockchain.transaction.subscribe', txhash);
            throw err;
          }
        } else {
          await this.electrumRequest('blockchain.transaction.broadcast', txhex);
          resolve({ txhash });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

}

