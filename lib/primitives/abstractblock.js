/*!
 * abstractblock.js - abstract block object for ldogejs
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const hash256 = require('bcrypto/lib/hash256');
const scrypt = require('bcrypto/lib/scrypt')
const bio = require('bufio');
const util = require('../utils/util');
const InvItem = require('./invitem');
const consensus = require('../protocol/consensus');


/**
 * Abstract Block
 * The class which all block-like objects inherit from.
 * @alias module:primitives.AbstractBlock
 * @abstract
 * @property {Number} version
 * @property {Hash} prevBlock
 * @property {Hash} merkleRoot
 * @property {Number} time
 * @property {Number} bits
 * @property {Number} nonce
 * @property {Hash} vchBlockSig
 */

class AbstractBlock {
  /**
   * Create an abstract block.
   * @constructor
   */

  constructor() {
    this.version = 7;
    this.prevBlock = consensus.ZERO_HASH;
    this.merkleRoot = consensus.ZERO_HASH;
    this.time = 0;
    this.bits = 0;
    this.nonce = 0;
    this.vchBlockSig = consensus.ZERO_HASH;
    this.mutable = false;

    this._hash = null;
    this._hhash = null;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  parseOptions(options) {
    assert(options, 'Block data is required.');
    assert((options.version >>> 0) === options.version);
    assert(Buffer.isBuffer(options.prevBlock));
    assert(Buffer.isBuffer(options.merkleRoot));
    assert((options.time >>> 0) === options.time);
    assert((options.bits >>> 0) === options.bits);
    assert((options.nonce >>> 0) === options.nonce);
    this.version = options.version;
    this.prevBlock = options.prevBlock;
    this.merkleRoot = options.merkleRoot;
    this.time = options.time;
    this.bits = options.bits;
    this.nonce = options.nonce;
    if (options.mutable != null) {
      assert(typeof options.mutable === 'boolean');
      this.mutable = options.mutable;
    }
    this.vchBlockSig = options.vchBlockSig;
    return this;
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  parseJSON(json) {
    assert(json, 'Block data is required.');
    assert((json.version >>> 0) === json.version);
    assert(typeof json.prevBlock === 'string');
    assert(typeof json.merkleRoot === 'string');
    assert((json.time >>> 0) === json.time);
    assert((json.bits >>> 0) === json.bits);
    assert((json.nonce >>> 0) === json.nonce);

    this.version = json.version;
    this.prevBlock = util.fromRev(json.prevBlock);
    this.merkleRoot = util.fromRev(json.merkleRoot);
    this.time = json.time;
    this.bits = json.bits;
    this.nonce = json.nonce;
    return this;
  }

  /**
   * Test whether the block is a memblock.
   * @returns {Boolean}
   */

  isMemory() {
    return false;
  }

  /**
   * Clear any cached values (abstract).
   */

  _refresh() {
    this._hash = null;
    this._hhash = null;
  }

  /**
   * Clear any cached values.
   */

  refresh() {
    return this._refresh();
  }

  /**
   * Hash the block headers.
   * @param {String?} enc - Can be `'hex'` or `null`.
   * @returns {Hash|Buffer} hash
   */

  hash(enc) {

    let h = this._hash;

    if (!h) {
      h = this.version > 6 ?
        hash256.digest(this.toHead()) :
        this.getPoWHash();

      if (!this.mutable)
        this._hash = h;
    }

    if (enc === 'hex') {
      let hex = this._hhash;
      if (!hex) {
        hex = h.toString('hex');
        if (!this.mutable)
          this._hhash = hex;
      }
      h = hex;
    }

    return h;
  }

  /**
   * Serialize the block headers.
   * @returns {Buffer}
   */

  toHead() {
    return this.writeHead(bio.write(80)).render();
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromHead(data) {
    return this.readHead(bio.read(data));
  }

  /**
   * Serialize the block headers.
   * @param {BufferWriter} bw
   */

  writeHead(bw) {
    bw.writeU32(this.version);
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.merkleRoot);
    bw.writeU32(this.time);
    bw.writeU32(this.bits);
    bw.writeU32(this.nonce);
    return bw;
  }

  /**
   * Parse the block headers.
   * @param {BufferReader} br
   */

  readHead(br) {

    this.version = br.readU32();
    this.prevBlock = br.readHash();
    this.merkleRoot = br.readHash();
    this.time = br.readU32();
    this.bits = br.readU32();
    this.nonce = br.readU32();
    return this;
  }

  /**
   * Verify the block.
   * @returns {Boolean}
   */

  verify() {
    if (this.isProofOfWork() && !this.verifyPOW()) {
      return false;
    }

    if (this.isProofOfStake() && !this.verifyPOS()) {
      return false;
    }

    return this.verifyBody();


  }

  /**
   * Verify proof-of-work.
   * @returns {Boolean}
   */

  verifyPOW() {
    return consensus.verifyPOW(this.getPoWHash(), this.bits);
  }

  /**
   * Verifies Proof of stake using the transactions.. can't really do this here abstract block doesn't have transactions
   * @returns {Boolean}
   */
  verifyPOS() {
    return consensus.verifyPOS(this);
  }

  /**
   * Verify the block.
   * @returns {Boolean}
   */

  verifyBody() {
    throw new Error('Abstract method.');
  }

  /**
   * Get little-endian block hash.
   * @returns {Hash}
   */

  rhash() {
    return util.revHex(this.hash());
  }

  /**
   * Convert the block to an inv item.
   * @returns {InvItem}
   */

  toInv() {
    return new InvItem(InvItem.types.BLOCK, this.hash());
  }

  /**
   * Gets the proof of work hash
   * @returns {Hash}
   */
  getPoWHash() {
    const a = this.writeHead(bio.write(80)).render()
    return scrypt.derive(a, a, 1024, 1, 1, 32);
  }

  /**
   * Returns if the block is proof of work
   * @returns {boolean}
   */
  isProofOfWork() {
    throw new Error('Abstract method AbstractBlock.prototype.isProofOfWork()')
  }

  /**
   * Returns if the block is proof of stake
   * @returns {boolean}
   */
  isProofOfStake() {
    throw new Error('Abstract method AbstractBlock.prototype.isProofOfStake().');
  }
}

/*
 * Expose
 */

module.exports = AbstractBlock;
