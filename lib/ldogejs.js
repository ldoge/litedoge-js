/*!
 * ldogejs.js - a javascript bitcoin library.
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License).
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

/* eslint prefer-arrow-callback: "off" */

'use strict';

/**
 * A ldogejs "environment" which exposes all
 * constructors for primitives, the blockchain,
 * mempool, wallet, etc. It also exposes a
 * global worker pool.
 *
 * @exports ldogejs
 * @type {Object}
 */

const ldogejs = exports;

/**
 * Define a module for lazy loading.
 * @param {String} name
 * @param {String} path
 */

ldogejs.define = function define(name, path) {
  let cache = null;
  Object.defineProperty(ldogejs, name, {
    enumerable: true,
    get() {
      if (!cache)
        cache = require(path);
      return cache;
    }
  });
};

/**
 * Set the default network.
 * @param {String} network
 */

ldogejs.set = function set(network) {
  ldogejs.Network.set(network);
  return ldogejs;
};

/*
 * Expose
 */

// Blockchain
ldogejs.define('blockchain', './blockchain');
ldogejs.define('blockstore', './blockstore');
ldogejs.define('Chain', './blockchain/chain');
ldogejs.define('ChainEntry', './blockchain/chainentry');

// BTC
ldogejs.define('btc', './btc');
ldogejs.define('Amount', './btc/amount');
ldogejs.define('URI', './btc/uri');

// Client
ldogejs.define('client', './client');
ldogejs.define('NodeClient', './client/node');
ldogejs.define('WalletClient', './client/wallet');

// Coins
ldogejs.define('coins', './coins');
ldogejs.define('Coins', './coins/coins');
ldogejs.define('CoinEntry', './coins/coinentry');
ldogejs.define('CoinView', './coins/coinview');

// HD
ldogejs.define('hd', './hd');
ldogejs.define('HDPrivateKey', './hd/private');
ldogejs.define('HDPublicKey', './hd/public');
ldogejs.define('Mnemonic', './hd/mnemonic');

// Index
ldogejs.define('indexer', './indexer');
ldogejs.define('Indexer', './indexer/indexer');
ldogejs.define('TXIndexer', './indexer/txindexer');
ldogejs.define('AddrIndexer', './indexer/addrindexer');

// Mempool
ldogejs.define('mempool', './mempool');
ldogejs.define('Fees', './mempool/fees');
ldogejs.define('Mempool', './mempool/mempool');
ldogejs.define('MempoolEntry', './mempool/mempoolentry');

// Miner
ldogejs.define('mining', './mining');
ldogejs.define('Miner', './mining/miner');

// Net
ldogejs.define('net', './net');
ldogejs.define('packets', './net/packets');
ldogejs.define('Peer', './net/peer');
ldogejs.define('Pool', './net/pool');

// Node
ldogejs.define('node', './node');
ldogejs.define('Node', './node/node');
ldogejs.define('FullNode', './node/fullnode');
ldogejs.define('SPVNode', './node/spvnode');

// Primitives
ldogejs.define('primitives', './primitives');
ldogejs.define('Address', './primitives/address');
ldogejs.define('Block', './primitives/block');
ldogejs.define('Coin', './primitives/coin');
ldogejs.define('Headers', './primitives/headers');
ldogejs.define('Input', './primitives/input');
ldogejs.define('InvItem', './primitives/invitem');
ldogejs.define('KeyRing', './primitives/keyring');
ldogejs.define('MerkleBlock', './primitives/merkleblock');
ldogejs.define('MTX', './primitives/mtx');
ldogejs.define('Outpoint', './primitives/outpoint');
ldogejs.define('Output', './primitives/output');
ldogejs.define('TX', './primitives/tx');

// Protocol
ldogejs.define('protocol', './protocol');
ldogejs.define('consensus', './protocol/consensus');
ldogejs.define('Network', './protocol/network');
ldogejs.define('networks', './protocol/networks');
ldogejs.define('policy', './protocol/policy');

// Script
ldogejs.define('script', './script');
ldogejs.define('Opcode', './script/opcode');
ldogejs.define('Script', './script/script');
ldogejs.define('ScriptNum', './script/scriptnum');
ldogejs.define('SigCache', './script/sigcache');
ldogejs.define('Stack', './script/stack');

// Utils
ldogejs.define('utils', './utils');
ldogejs.define('util', './utils/util');

// Wallet
ldogejs.define('wallet', './wallet');
ldogejs.define('Path', './wallet/path');
ldogejs.define('WalletKey', './wallet/walletkey');
ldogejs.define('WalletDB', './wallet/walletdb');

// Workers
ldogejs.define('workers', './workers');
ldogejs.define('WorkerPool', './workers/workerpool');

// Package Info
ldogejs.define('pkg', './pkg');
