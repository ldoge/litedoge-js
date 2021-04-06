/*!
 * block.js - block object for ldogejs
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {BufferSet} = require('buffer-map');
const hash256 = require('bcrypto/lib/hash256');
const merkle = require('bcrypto/lib/merkle');
const consensus = require('../protocol/consensus');
const AbstractBlock = require('./abstractblock');
const TX = require('./tx');
const MerkleBlock = require('./merkleblock');
const Headers = require('./headers');
const Network = require('../protocol/network');
const util = require('../utils/util');
const {encoding} = bio;
const {inspectSymbol} = require('../utils');
const GCSFilter = require('../golomb/golomb');
const {opcodes} = require('../script/common');

/**
 * Block
 * Represents a full block.
 * @alias module:primitives.Block
 * @extends AbstractBlock
 * @property {TX[]} txs
 */

class Block extends AbstractBlock {
  /**
   * Create a block.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.txs = [];

    this._raw = null;
    this._size = -1;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    this.parseOptions(options);

    if (options.txs) {
      assert(Array.isArray(options.txs));
      for (const tx of options.txs) {
        assert(tx instanceof TX);
        this.txs.push(tx);
      }
    }

    return this;
  }

  /**
   * Instantiate block from options.
   * @param {Object} options
   * @returns {Block}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Clear any cached values.
   * @param {Boolean?} all - Clear transactions.
   */

  refresh(all) {
    this._refresh();

    this._raw = null;
    this._size = -1;

    if (!all)
      return this;

    for (const tx of this.txs)
      tx.refresh();

    return this;
  }

  /**
   * Serialize the block.
   * @returns {Buffer}
   */

  toRaw() {
    return this.frame().data;
  }

  /**
   * Check if block has been serialized.
   * @returns {Boolean}
   */

  hasRaw() {
    return Boolean(this._raw);
  }

  /**
   * Serialize the block
   * @returns {Buffer}
   */

  toNormal() {
    return this.toRaw();
  }

  /**
   * Serialize the block
   * @param {BufferWriter} bw
   */

  toWriter(bw) {

    const raw = this.frame();
    bw.writeBytes(raw.data);

    return bw;
  }

  /**
   * Serialize the block.
   * @param {BufferWriter} bw
   */

  toNormalWriter(bw) {
    return this.toWriter(bw);
  }

  /**
   * Get the raw block serialization.
   * @private
   * @returns {RawBlock}
   */

  frame() {
    if (this._raw) {
      assert(this._size >= 0);
      const raw = new RawBlock(this._size);
      raw.data = this._raw;
      return raw;
    }

    const raw = this.frameNormal();
    this._raw = raw.data;
    this._size = raw.size;
    return raw;
  }

  /**
   * Calculate real size.
   * @returns {Object} Contains `size`.
   */

  getSizes() {
    return this.frame();
  }

  /**
   * Calculate virtual block size.
   * @returns {Number} Virtual size.
   */

  getVirtualSize() {
    return (this.getWeight()) | 0;
  }

  /**
   * Calculate block weight.
   * @returns {Number} weight
   */

  getWeight() {
    const raw = this.getSizes();
    const base = raw.size;
    return base;
  }

  /**
   * Get real block size.
   * @returns {Number} size
   */

  getSize() {
    return this.getSizes().size;
  }

  /**
   * Get base block size.
   * @returns {Number} size
   */

  getBaseSize() {
    const raw = this.getSizes();
    return raw.size;
  }


  /**
   * Test the block's transaction vector against a hash.
   * @param {Hash} hash
   * @returns {Boolean}
   */

  hasTX(hash) {
    return this.indexOf(hash) !== -1;
  }

  /**
   * Find the index of a transaction in the block.
   * @param {Hash} hash
   * @returns {Number} index (-1 if not present).
   */

  indexOf(hash) {
    for (let i = 0; i < this.txs.length; i++) {
      const tx = this.txs[i];
      if (tx.hash().equals(hash))
        return i;
    }

    return -1;
  }

  /**
   * Calculate merkle root. Returns null
   * if merkle tree has been malleated.
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Hash|null}
   */

  createMerkleRoot(enc) {
    const leaves = [];

    for (const tx of this.txs)
      leaves.push(tx.hash());

    const [root, malleated] = merkle.createRoot(hash256, leaves);

    if (malleated)
      return null;

    return enc === 'hex' ? root.toString('hex') : root;
  }

  /**
   * Do non-contextual verification on the block. Including checking the block
   * size, the coinbase and the merkle root. This is consensus-critical.
   * @returns {Boolean}
   */

  verifyBody() {
    const [valid] = this.checkBody();
    return valid;
  }


  /**
   * two types of block: proof-of-work or proof-of-stake
   * @returns {Boolean}
   */
  isProofOfStake() {
    return (this.txs.length > 1 && this.txs[1].isCoinstake());
  }

  /**
   * two types of block: proof-of-work or proof-of-stake
   * @returns {Boolean}
   */
  isProofOfWork() {
    return !this.isProofOfStake();
  }

  /**
   * Do non-contextual verification on the block. Including checking the block
   * size, the coinbase and the merkle root. This is consensus-critical.
   * @returns {Array} [valid, reason, score]
   */

  checkBody() {
    // Check base size.
    if (this.txs.length === 0
      || this.txs.length > consensus.MAX_BLOCK_SIZE
      || this.getBaseSize() > consensus.MAX_BLOCK_SIZE) {
      return [false, 'bad-blk-length', 100];
    }

    // First TX must be a coinbase.
    if (this.txs.length === 0 || !this.txs[0].isCoinbase())
      return [false, 'bad-cb-missing', 100];

    if (this.isProofOfStake()) {
      if (this.txs[0].outputs.length !== 1 || !this.txs[0].outputs[0].isEmpty())
        return [false, 'bad-cs-coinbasenotempty', 100];

      if (this.txs.length === 0 || !this.txs[1].isCoinstake())
        return [false, 'bad-cs-missing', 100];
      
    }


    // Check merkle root.
    const root = this.createMerkleRoot();

    // If the merkle is mutated,
    // we have duplicate txs.
    if (!root)
      return [false, 'bad-txns-duplicate', 100];

    if (!this.merkleRoot.equals(root))
      return [false, 'bad-txnmrklroot', 100];


    let sigops = 0;

    for (let i = 0; i < this.txs.length; i++) {
      const tx = this.txs[i];

      // The rest of the txs must not be coinbases.
      if (i > 0 && tx.isCoinbase())
        return [false, 'bad-cb-multiple', 100];

      if (i > 1 && tx.isCoinstake())
        return [false, 'bad-cs-multiple', 100];

      // Sanity checks.
      const [valid, reason, score] = tx.checkSanity();

      if (!valid)
        return [valid, reason, score];

      // Count legacy sigops (do not count scripthash).
      sigops += tx.getLegacySigops();
      if (sigops > consensus.MAX_BLOCK_SIGOPS_COST)
        return [false, 'bad-blk-sigops', 100];
    }

    return [true, 'valid', 0];
  }

  /**
   * Retrieve the coinbase height from the coinbase input script.
   * @returns {Number} height (-1 if not present).
   */

  getCoinbaseHeight() {
    if (this.version < 2)
      return -1;

    if (this.txs.length === 0)
      return -1;

    const coinbase = this.txs[0];

    if (coinbase.inputs.length === 0)
      return -1;

    return coinbase.inputs[0].script.getCoinbaseHeight();
  }

  /**
   * Get the "claimed" reward by the coinbase.
   * @returns {Amount} claimed
   */

  getClaimed() {
    assert(this.txs.length > 0);
    assert(this.txs[0].isCoinbase());
    return this.txs[0].getOutputValue();
  }

  /**
   * Get all unique outpoint hashes in the
   * block. Coinbases are ignored.
   * @returns {Hash[]} Outpoint hashes.
   */

  getPrevout() {
    const prevout = new BufferSet();

    for (let i = 1; i < this.txs.length; i++) {
      const tx = this.txs[i];

      for (const input of tx.inputs)
        prevout.add(input.prevout.hash);
    }

    return prevout.toArray();
  }

  /**
   * Inspect the block and return a more
   * user-friendly representation of the data.
   * @returns {Object}
   */

  [inspectSymbol]() {
    return this.format();
  }

  /**
   * Inspect the block and return a more
   * user-friendly representation of the data.
   * @param {CoinView} view
   * @param {Number} height
   * @returns {Object}
   */

  format(view, height) {
    return {
      hash: this.rhash(),
      height: height != null ? height : -1, //height maybe should be 0
      size: this.getSize(),
      virtualSize: this.getVirtualSize(),
      date: util.date(this.time),
      version: this.version.toString(16),
      prevBlock: util.revHex(this.prevBlock),
      merkleRoot: util.revHex(this.merkleRoot),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce,
      vchBlockSig: this.vchBlockSig,
      txs: this.txs.map((tx, i) => {
        return tx.format(view, null, i);
      })
    };
  }

  /**
   * Convert the block to an object suitable
   * for JSON serialization.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON();
  }

  /**
   * Convert the block to an object suitable
   * for JSON serialization. Note that the hashes
   * will be reversed to abide by bitcoind's legacy
   * of little-endian uint256s.
   * @param {Network} network
   * @param {CoinView} view
   * @param {Number} height
   * @param {Number} depth
   * @returns {Object}
   */

  getJSON(network, view, height, depth) {
    network = Network.get(network);
    return {
      hash: this.rhash(),
      height: height,
      depth: depth,
      version: this.version,
      prevBlock: util.revHex(this.prevBlock),
      merkleRoot: util.revHex(this.merkleRoot),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce,
      vchBlockSig: this.vchBlockSig,
      txs: this.txs.map((tx, i) => {
        return tx.getJSON(network, view, null, i);
      })
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'Block data is required.');
    assert(Array.isArray(json.txs));

    this.parseJSON(json);

    for (const tx of json.txs)
      this.txs.push(TX.fromJSON(tx));

    return this;
  }

  /**
   * Instantiate a block from a jsonified block object.
   * @param {Object} json - The jsonified block object.
   * @returns {Block}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromReader(br) {
    br.start();

    this.readHead(br);

    const count = br.readVarint();

    for (let i = 0; i < count; i++) {
      const tx = TX.fromReader(br, true);
      this.txs.push(tx);
    }

    if (!this.mutable) {
      this._raw = br.endData();
      this._size = this._raw.length;
    }

    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  /**
   * Instantiate a block from a serialized Buffer.
   * @param {Buffer} data
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Block}
   */

  static fromReader(data) {
    return new this().fromReader(data);
  }

  /**
   * Instantiate a block from a serialized Buffer.
   * @param {Buffer} data
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Block}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new this().fromRaw(data);
  }

  /**
   * Convert the Block to a MerkleBlock.
   * @param {Bloom} filter - Bloom filter for transactions
   * to match. The merkle block will contain only the
   * matched transactions.
   * @returns {MerkleBlock}
   */

  toMerkle(filter) {
    return MerkleBlock.fromBlock(this, filter);
  }

  /**
   * Serialze block
   * @private
   * @param {BufferWriter?} writer
   * @returns {Buffer}
   */

  writeNormal(bw) {
    this.writeHead(bw);

    bw.writeVarint(this.txs.length);

    for (const tx of this.txs)
      tx.toNormalWriter(bw);

    // bw.writeHash(this.vchBlockSig)
    return bw;
  }


  /**
   * Serialze block
   * @private
   * @param {BufferWriter?} writer
   * @returns {Buffer}
   */

  frameNormal() {
    const raw = this.getNormalSizes();
    const bw = bio.write(raw.size);
    this.writeNormal(bw);
    raw.data = bw.render();
    return raw;
  }


  /**
   * Convert the block to a headers object.
   * @returns {Headers}
   */

  toHeaders() {
    return Headers.fromBlock(this);
  }

  /**
   * Get real block size
   * @returns {RawBlock}
   */

  getNormalSizes() {
    /*
    this.writeHead(bw);

    bw.writeVarint(this.txs.length);

    for (const tx of this.txs)
      tx.toNormalWriter(bw);

    bw.writeHash(this.vchBlockSig)
    */
    let size = 0;

    size += 80; //size of heads
    size += encoding.sizeVarint(this.txs.length); //transaction vector length
    for (const tx of this.txs) //transaction vector
      size += tx.getBaseSize();

    // size += 32 //vchBlockSig
    return new RawBlock(size, 0);
  }


  /**
   * Test whether an object is a Block.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isBlock(obj) {
    return obj instanceof Block;
  }

  /*
   * Get block filter (BIP 158)
   * @see https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki
   * @param {CoinView} view
   * @returns {Object} See {@link Golomb}
   */

  toFilter(view) {
    const hash = this.hash();
    const key = hash.slice(0, 16);
    const items = new BufferSet();

    for (let i = 0; i < this.txs.length; i++) {
      const tx = this.txs[i];

      for (const output of tx.outputs) {
        if (output.script.length === 0)
          continue;

        // In order to allow the filters to later be committed
        // to within an OP_RETURN output, we ignore all
        // OP_RETURNs to avoid a circular dependency.
        if (output.script.raw[0] === opcodes.OP_RETURN)
          continue;

        items.add(output.script.raw);
      }
    }

    for (const [, coins] of view.map) {
      for (const [, coin] of coins.outputs) {
        if (coin.output.script.length === 0)
          continue;

        items.add(coin.output.script.raw);
      }
    }

    return GCSFilter.fromItems(19, key, items);
  }
}

/*
 * Helpers
 */

class RawBlock {
  constructor(size) {
    this.data = null;
    this.size = size;
  }
}

/*
 * Expose
 */

module.exports = Block;
