/*!
 * common.js - p2p constants for ldogejs
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/**
 * @module net/common
 */

const random = require('bcrypto/lib/random');
const pkg = require('../pkg');

/**
 * Default protocol version.
 * @const {Number}
 * @default
 */

exports.PROTOCOL_VERSION = 60066;

/**
 * Minimum protocol version we're willing to talk to.
 * @const {Number}
 * @default
 */

exports.MIN_VERSION = 60065;

/**
 * Minimum version for getheaders.
 * @const {Number}
 * @default
 */

exports.HEADERS_VERSION = 31800;

/**
 * Minimum version for pong.
 * @const {Number}
 * @default
 */

exports.PONG_VERSION = 60000;

/**
 * Minimum version for bip37.
 * @const {Number}
 * @default
 */

exports.BLOOM_VERSION = 9999999;

/**
 * Minimum version for bip152.
 * @const {Number}
 * @default
 */

exports.SENDHEADERS_VERSION = 99999999;

/**
 * Minimum version for bip152.
 * @const {Number}
 * @default
 */

exports.COMPACT_VERSION = 99999999;

/**
 * Service bits.
 * @enum {Number}
 * @default
 */

exports.services = {
  /**
   * Whether network services are enabled.
   */

  NETWORK: 1 << 0,

  /**
   * Whether the peer supports the getutxos packet.
   */

  GETUTXO: 1 << 1,

  /**
   * Whether the peer supports BIP37.
   */

  BLOOM: 1 << 2,

};

/**
 * Bcoin's services (we support everything).
 * @const {Number}
 * @default
 */

exports.LOCAL_SERVICES = 0
  | exports.services.NETWORK;

/**
 * Required services (network and segwit).
 * @const {Number}
 * @default
 */

exports.REQUIRED_SERVICES = 0
  | exports.services.NETWORK;

/**
 * Default user agent: `/ldogejs:[version]/`.
 * @const {String}
 * @default
 */
exports.USER_AGENT = `/LDOGE.JS:${pkg.version}/`;

/**
 * Max message size (~4mb with segwit, formerly 2mb)
 * @const {Number}
 * @default
 */

exports.MAX_MESSAGE = 4 * 1000 * 1000;

/**
 * Amount of time to ban misbheaving peers.
 * @const {Number}
 * @default
 */

exports.BAN_TIME = 24 * 60 * 60;

/**
 * Ban score threshold before ban is placed in effect.
 * @const {Number}
 * @default
 */

exports.BAN_SCORE = 100;

/**
 * Create a nonce.
 * @returns {Buffer}
 */

exports.nonce = function nonce() {
  return random.randomBytes(8);
};

/**
 * A compressed pubkey of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_KEY = Buffer.alloc(33, 0x00);

/**
 * A 64 byte signature of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_SIG = Buffer.alloc(64, 0x00);

/**
 * 8 zero bytes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_NONCE = Buffer.alloc(8, 0x00);

/**
 * Maximum inv/getdata size.
 * @const {Number}
 * @default
 */

exports.MAX_INV = 50000;

/**
 * Maximum number of requests.
 * @const {Number}
 * @default
 */

exports.MAX_REQUEST = 5000;

/**
 * Maximum number of block requests per peer.
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_REQUEST = 50000 + 10000;

/**
 * Maximum number of tx requests.
 * @const {Number}
 * @default
 */

exports.MAX_TX_REQUEST = 10000;
