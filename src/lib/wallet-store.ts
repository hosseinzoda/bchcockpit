import type { Wallet, ListProxy } from './types.js';
import { ValueError, NotImplemented } from '@cashlab/common/exceptions.js';
import { serialize, deserialize } from './internal/json-ipc-serializer.js';

export type WalletStore = {
  addWallet (wallet: Wallet): void;
  removeWalletById (wallet_id: string): void;
};

export class WalletStoreNotSupported implements WalletStore {
  constructor () {
  }
  addWallet (wallet: Wallet): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
  removeWalletById (wallet_id: string): void {
    throw new NotImplemented('Can only invoke in runtime!');
  }
}

export class WalletStoreRuntime implements WalletStore {
  wallets: ListProxy<Wallet>;
  constructor (list: ListProxy<Wallet>) {
    this.wallets = list;
    try {
      let data: { wallets: Wallet[] };
      const data_serialized = window.localStorage.getItem('bch-wallets');
      if (!data_serialized) {
        // init
        data = { wallets: this.wallets.getListSnapshot() };
        window.localStorage.setItem('bch-wallets', serialize(data));
      } else {
        data = deserialize(data_serialized);
      }
      this.wallets.init(data.wallets);
    } catch (err) {
      throw new ValueError(`Failed to load wallets from localStorage('bch-wallets')`, { cause: err });
    }
  }
  save (): void {
    const data = { wallets: this.wallets.getListSnapshot() };
    window.localStorage.setItem('bch-wallets', serialize(data));
  }
  updateWallet (wallet: Wallet): void {
    this.wallets.update(wallet);
    this.save();
  }
  addWallet (wallet: Wallet): void {
    const index = this.wallets.getCount();
    this.wallets.insert(index, wallet);
    this.save();
  }
  removeWalletById (wallet_id: string): void {
    this.wallets.remove(wallet_id);
    this.save();
  }
}
