/*!
 * common.js - blockstore constants for ldogejs
 * Copyright (c) 2019, Braydon Fuller (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/**
 * @module blockstore/common
 */

/**
 * Block data types.
 * @enum {Number}
 */

exports.types = {
  BLOCK: 1,
  UNDO: 2,
  FILTER: 3,
  MERKLE: 4
};

/**
 * File prefixes for block data types.
 * @enum {String}
 */

exports.prefixes = {
  1: 'blk',
  2: 'blu',
  3: 'blf',
  4: 'blm'
};
