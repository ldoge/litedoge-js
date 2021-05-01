/*!
 * chain.js - blockchain management for ldogejs
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const path = require('path');
const AsyncEmitter = require('bevent');
const Logger = require('blgr');
const {Lock} = require('bmutex');
const LRU = require('blru');
const {BufferMap} = require('buffer-map');
const Network = require('../protocol/network');
const ChainDB = require('./chaindb');
const common = require('./common');
const consensus = require('../protocol/consensus');
const util = require('../utils/util');
const {BN} = require('bcrypto/lib/bcrypto')
const ChainEntry = require('./chainentry');
const hash256 = require('bcrypto/lib/hash256');
const bio = require("bufio")
const CoinView = require('../coins/coinview');
const Script = require('../script/script');
const {VerifyError} = require('../protocol/errors');
const thresholdStates = common.thresholdStates;
const ZERO = new BN(0);
const Block = require('../primitives/block')

/**
 * Blockchain
 * @alias module:blockchain.Chain
 * @property {ChainDB} db
 * @property {ChainEntry?} tip
 * @property {Network} network
 * @property {Kernel} kernel
 * @property {Number} height
 * @property {DeploymentState} state
 */

class Chain extends AsyncEmitter {

  /**
   * Create a blockchain.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.opened = false;
    this.options = new ChainOptions(options);

    this.network = this.options.network;
    this.pos = this.network.pos;
    this.logger = this.options.logger.context('chain');
    this.blocks = this.options.blocks;
    this.workers = this.options.workers;
    this.kernel = this.options.kernel;
    this.db = new ChainDB(this.options);

    this.locker = new Lock(true, BufferMap);
    this.invalid = new LRU(100, null, BufferMap);
    this.state = new DeploymentState();

    this.tip = new ChainEntry();
    this.height = -1;
    this.synced = false;

    this.orphanMap = new BufferMap();
    this.orphanPrev = new BufferMap();
  }

  /**
   * Open the chain, wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'Chain is already open.');
    this.opened = true;

    this.logger.info('Chain is loading.');

    if (this.options.checkpoints)
      this.logger.info('Checkpoints are enabled.');


    await this.db.open();

    const tip = await this.db.getTip();

    assert(tip);

    this.tip = tip;
    this.height = tip.height;

    this.logger.info('Chain Height: %d', tip.height);

    this.logger.memory();

    const state = await this.getDeploymentState();

    this.setDeploymentState(state);

    this.logger.memory();

    this.emit('tip', tip);

    this.maybeSync();
  }

  /**
   * Close the chain, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'Chain is not open.');
    this.opened = false;
    return this.db.close();
  }

  /**
   * Perform all necessary contextual verification on a block.
   * @private
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise} - Returns {@link ContextResult}.
   */

  async verifyContext(block, prev, flags) {
    // Initial non-contextual verification.
    const state = await this.verify(block, prev, flags);

    // Skip everything if we're in SPV mode.
    if (this.options.spv) {
      const view = new CoinView();
      return [view, state];
    }

    // Skip everything if we're using checkpoints.
    if (this.isHistorical(prev)) {
      const view = await this.updateInputs(block, prev);
      return [view, state];
    }


    await this.verifyDuplicates(block, prev);

    // Verify scripts, spend and add coins.
    const view = await this.verifyInputs(block, prev, state);

    return [view, state];
  }

  /**
   * Perform all necessary contextual verification
   * on a block, without POW check or POS check.
   * @param {Block} block
   * @returns {Promise}
   */

  async verifyBlock(block) {
    const unlock = await this.locker.lock();
    try {
      return await this._verifyBlock(block);
    } finally {
      unlock();
    }
  }

  /**
   * Perform all necessary contextual verification
   * on a block, without POW check or POS check (no lock).
   * @private
   * @param {Block} block
   * @returns {Promise}
   */

  async _verifyBlock(block) {
    const flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW & ~common.flags.VERIFY_POS;
    return this.verifyContext(block, this.tip, flags);
  }

  /**
   * Test whether the hash is in the main chain.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  isMainHash(hash) {
    return this.db.isMainHash(hash);
  }

  /**
   * Test whether the entry is in the main chain.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns Boolean.
   */

  isMainChain(entry) {
    return this.db.isMainChain(entry);
  }

  /**
   * Get ancestor by `height`.
   * @param {ChainEntry} entry
   * @param {Number} height
   * @returns {Promise} - Returns ChainEntry.
   */

  getAncestor(entry, height) {
    return this.db.getAncestor(entry, height);
  }

  /**
   * Get previous entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getPrevious(entry) {

    return this.db.getPrevious(entry);
  }


  /**
   * Get previous cached entry.
   * @param {ChainEntry} entry
   * @returns {ChainEntry|null}
   */

  getPrevCache(entry) {
    return this.db.getPrevCache(entry);
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getNext(entry) {
    return this.db.getNext(entry);
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getNextEntry(entry) {
    return this.db.getNextEntry(entry);
  }

  /**
   *
   * @param entry
   * @param proofOfStake
   * @returns {Promise<ChainEntry>} returns the entry if it matches the proof of Stake flag or the first ancestor that does.
   */
  async getLastEntry(entry, proofOfStake) {
    while (entry && !consensus.ZERO_HASH.equals(entry.prevBlock) && entry.isProofOfStake() !== proofOfStake)
      entry = this.getPrevCache(entry) || await this.getPrevious(entry);
    return entry;
  }

  /**
   *
   * @param {module:protocol.Network} network
   * @param entry
   * @returns {number|*}
   */
  getPastTimeLimit(network, entry) {
    if (network.isProtocolV2(this.height))
      return entry.time;
    else
      return this.getMedianTime(entry);
  }

  /**
   * Calculate median time past.
   * @param {ChainEntry} prev
   * @param {Number?} time
   * @returns {Promise} - Returns Number.
   */

  async getMedianTime(prev, time) {
    let timespan = consensus.MEDIAN_TIMESPAN;

    const median = [];

    // In case we ever want to check
    // the MTP of the _current_ block
    // (necessary for BIP148).
    if (time != null) {
      median.push(time);
      timespan -= 1;
    }

    let entry = prev;

    for (let i = 0; i < timespan && entry; i++) {
      median.push(entry.time);

      const cache = this.getPrevCache(entry);

      if (cache)
        entry = cache;
      else
        entry = await this.getPrevious(entry);
    }

    median.sort(cmp);

    return median[median.length >>> 1];
  }

  /**
   * Test whether the entry is potentially
   * an ancestor of a checkpoint.
   * @param {ChainEntry} prev
   * @returns {Boolean}
   */

  isHistorical(prev) {
    if (this.options.checkpoints) {
      if (prev.height + 1 <= this.network.lastCheckpoint)
        return true;
    }
    return false;
  }

  /**
   * Contextual verification for a block, including
   * version deployments (IsSuperMajority), versionbits,
   * coinbase height, finality checks.
   * @private
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async verify(block, prev, flags) {
    assert(typeof flags === 'number');

    // Extra sanity check.
    if (!block.prevBlock.equals(prev.hash))
      throw new VerifyError(block, 'invalid', 'bad-prevblk', 0);

    // Verify a checkpoint if there is one.
    const hash = block.hash();
    if (!this.verifyCheckpoint(prev, hash)) {
      throw new VerifyError(block,
        'checkpoint',
        'checkpoint mismatch',
        100);
    }

    // Skip everything when using checkpoints.
    // We can do this safely because every
    // block in between each checkpoint was
    // validated outside in the header chain.
    if (this.isHistorical(prev)) {
      if (this.options.spv)
        return this.state;

      // Check merkle root.
      if (flags & common.flags.VERIFY_BODY) {
        assert(typeof block.createMerkleRoot === 'function');

        const root = block.createMerkleRoot();

        if (!root || !block.merkleRoot.equals(root)) {
          throw new VerifyError(block,
            'invalid',
            'bad-txnmrklroot',
            100,
            true);
        }

        flags &= ~common.flags.VERIFY_BODY;
      }

    }

    // Non-contextual checks.
    if (flags & common.flags.VERIFY_BODY) {
      const [valid, reason, score] = block.checkBody();

      if (!valid)
        throw new VerifyError(block, 'invalid', reason, score, true);
    }

    // Check proof-of-work or proof-of-stake
    const bits = await this.getTarget(block.time, prev, block.isProofOfStake());

    if (block.bits !== bits) {
      throw new VerifyError(block,
        'invalid',
        'bad-diffbits',
        100);
    }

    // Skip all blocks in spv mode once
    // we've verified the network target.
    if (this.options.spv)
      return this.state;

    // Ensure the timestamp is correct.
    const mtp = await this.getMedianTime(prev);

    if (block.time <= mtp) {
      throw new VerifyError(block,
        'invalid',
        'time-too-old',
        0);
    }

    // Check timestamp against adj-time+2hours.
    // If this fails we may be able to accept
    // the block later.
    if (block.time > this.network.now() + 2 * 60 * 60) {
      throw new VerifyError(block,
        'invalid',
        'time-too-new',
        0,
        true);
    }

    // Calculate height of current block.
    const height = prev.height + 1;


    // Get the new deployment state.
    const state = await this.getDeployments(block.time, prev);

    // Get timestamp for tx.isFinal().
    const time = state.hasMTP() ? mtp : block.time;

    // Transactions must be finalized with
    // regards to nSequence and nLockTime.
    for (const tx of block.txs) {
      if (!tx.isFinal(height, time)) {
        throw new VerifyError(block,
          'invalid',
          'bad-txns-nonfinal',
          10);
      }
    }

    // Check block weight (different from block size
    // check in non-contextual verification).
    if (block.getWeight() > consensus.MAX_BLOCK_WEIGHT) {
      throw new VerifyError(block,
        'invalid',
        'bad-blk-weight',
        100);
    }


    return state;
  }

  /**
   * Check all deployments on a chain, ranging from p2sh to segwit.
   * @param {Number} time
   * @param {ChainEntry} prev
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async getDeployments(time, prev) {
    const deployments = this.network.deployments;
    const height = prev.height + 1;
    const state = new DeploymentState();

    // For some reason bitcoind has p2sh in the
    // mandatory flags by default, when in reality
    // it wasn't activated until march 30th 2012.
    // The first p2sh output and redeem script
    // appeared on march 7th 2012, only it did
    // not have a signature. See:
    // 6a26d2ecb67f27d1fa5524763b49029d7106e91e3cc05743073461a719776192
    // 9c08a4d78931342b37fd5f72900fb9983087e6f46c4a097d8a1f52c74e28eaf6
    if (time >= consensus.BIP16_TIME)
      state.flags |= Script.flags.VERIFY_P2SH;


    return state;
  }

  /**
   * Set a new deployment state.
   * @param {DeploymentState} state
   */

  setDeploymentState(state) {
    if (this.options.checkpoints && this.height < this.network.lastCheckpoint) {
      this.state = state;
      return;
    }

    if (!this.state.hasP2SH() && state.hasP2SH())
      this.logger.warning('P2SH has been activated.');

    if (!this.state.hasCSV() && state.hasCSV())
      this.logger.warning('CSV has been activated.');


    this.state = state;
  }

  /**
   * Determine whether to check block for duplicate txids in blockchain
   * history (BIP30). If we're on a chain that has bip34 activated, we
   * can skip this.
   * @private
   * @see https://github.com/bitcoin/bips/blob/master/bip-0030.mediawiki
   * @param {Block} block
   * @param {ChainEntry} prev
   * @returns {Promise}
   */

  async verifyDuplicates(block, prev) {
    for (const tx of block.txs) {
      if (!await this.hasCoins(tx))
        continue;

      const height = prev.height + 1;
      const hash = this.network.bip30[height];

      // Blocks 91842 and 91880 created duplicate
      // txids by using the same exact output script
      // and extraNonce.
      if (!hash || !block.hash().equals(hash))
        throw new VerifyError(block, 'invalid', 'bad-txns-BIP30', 100);
    }
  }

  /**
   * Spend and update inputs (checkpoints only).
   * @private
   * @param {Block} block
   * @param {ChainEntry} prev
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async updateInputs(block, prev) {
    const view = new CoinView();
    const height = prev.height + 1;
    const cb = block.txs[0];

    view.addTX(cb, height);

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];

      assert(await view.spendInputs(this.db, tx),
        'BUG: Spent inputs in historical data!');

      view.addTX(tx, height);
    }

    return view;
  }

  /**
   * Check block transactions for all things pertaining
   * to inputs. This function is important because it is
   * what actually fills the coins into the block. This
   * function will check the block reward, the sigops,
   * the tx values, and execute and verify the scripts (it
   * will attempt to do this on the worker pool). If
   * `checkpoints` is enabled, it will skip verification
   * for historical data.
   * @private
   * @see TX#verifyInputs
   * @see TX#verify
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {DeploymentState} state
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async verifyInputs(block, prev, state) {
    const view = new CoinView();
    const height = prev.height + 1;
    const interval = this.network.halvingInterval;

    let sigops = 0;
    let reward = 0n;

    // Check all transactions
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      // Ensure tx is not double spending an output.
      if (i > 0) {
        if (!await view.spendInputs(this.db, tx)) {
          throw new VerifyError(block,
            'invalid',
            'bad-txns-inputs-missingorspent',
            100);
        }
      }

      // Verify sequence locks.
      if (i > 0 && tx.version >= 2) {
        const valid = await this.verifyLocks(prev, tx, view, state.lockFlags);

        if (!valid) {
          throw new VerifyError(block,
            'invalid',
            'bad-txns-nonfinal',
            100);
        }
      }

      // Count sigops (legacy + scripthash?)
      sigops += tx.getSigopsCost(view, state.flags);

      if (sigops > consensus.MAX_BLOCK_SIGOPS_COST) {
        throw new VerifyError(block,
          'invalid',
          'bad-blk-sigops',
          100);
      }

      // Contextual sanity checks.
      if (i > 0) {
        const [fee, reason, score] = tx.checkInputs(view, height);

        if (fee === -1) {
          throw new VerifyError(block,
            'invalid',
            reason,
            score);
        }

        reward += fee;

        if (reward > consensus.MAX_MONEY) {
          throw new VerifyError(block,
            'invalid',
            'bad-txns-accumulated-fee-outofrange',
            100);
        }
      }

      // Add new coins.
      view.addTX(tx, height);
    }

    // Make sure the miner isn't trying to conjure more coins.
    reward += consensus.getProofOfWorkReward(height, interval);

    if (block.getClaimed() > reward) {
      throw new VerifyError(block,
        'invalid',
        'bad-cb-amount',
        100);
    }

    // Push onto verification queue.
    const jobs = [];
    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      jobs.push(tx.verifyAsync(view, state.flags, this.workers));
    }

    // Verify all txs in parallel.
    const results = await Promise.all(jobs);

    for (const result of results) {
      if (!result) {
        throw new VerifyError(block,
          'invalid',
          'mandatory-script-verify-flag-failed',
          100);
      }
    }

    return view;
  }

  /**
   * Find the block at which a fork occurred.
   * @private
   * @param {ChainEntry} fork - The current chain.
   * @param {ChainEntry} longer - The competing chain.
   * @returns {Promise}
   */

  async findFork(fork, longer) {
    while (!fork.hash.equals(longer.hash)) {
      while (longer.height > fork.height) {
        longer = await this.getPrevious(longer);
        if (!longer)
          throw new Error('No previous entry for new tip.');
      }

      if (fork.hash.equals(longer.hash))
        return fork;

      fork = await this.getPrevious(fork);

      if (!fork)
        throw new Error('No previous entry for old tip.');
    }

    return fork;
  }

  /**
   * Reorganize the blockchain (connect and disconnect inputs).
   * Called when a competing chain with a higher chaintrust
   * is received.
   * @private
   * @param {ChainEntry} competitor - The competing chain's tip.
   * @returns {Promise}
   */

  async reorganize(competitor) {
    const tip = this.tip;
    const fork = await this.findFork(tip, competitor);

    assert(fork, 'No free space or data corruption.');

    // Blocks to disconnect.
    const disconnect = [];
    let entry = tip;
    while (!entry.hash.equals(fork.hash)) {
      disconnect.push(entry);
      entry = await this.getPrevious(entry);
      assert(entry);
    }

    // Blocks to connect.
    const connect = [];
    entry = competitor;
    while (!entry.hash.equals(fork.hash)) {
      connect.push(entry);
      entry = await this.getPrevious(entry);
      assert(entry);
    }

    // Disconnect blocks/txs.
    for (let i = 0; i < disconnect.length; i++) {
      const entry = disconnect[i];
      await this.disconnect(entry);
    }

    // Connect blocks/txs.
    // We don't want to connect the new tip here.
    // That will be done outside in setBestChain.
    for (let i = connect.length - 1; i >= 1; i--) {
      const entry = connect[i];
      await this.reconnect(entry);
    }

    this.logger.warning(
      'Chain reorganization: old=%h(%d) new=%h(%d)',
      tip.hash,
      tip.height,
      competitor.hash,
      competitor.height
    );

    await this.emitAsync('reorganize', tip, competitor);
  }

  /**
   * Reorganize the blockchain for SPV. This
   * will reset the chain to the fork block.
   * @private
   * @param {ChainEntry} competitor - The competing chain's tip.
   * @returns {Promise}
   */

  async reorganizeSPV(competitor) {
    const tip = this.tip;
    const fork = await this.findFork(tip, competitor);

    assert(fork, 'No free space or data corruption.');

    // Buffer disconnected blocks.
    const disconnect = [];
    let entry = tip;
    while (!entry.hash.equals(fork.hash)) {
      disconnect.push(entry);
      entry = await this.getPrevious(entry);
      assert(entry);
    }

    // Reset the main chain back
    // to the fork block, causing
    // us to redownload the blocks
    // on the new main chain.
    await this._reset(fork.hash, true);

    // Emit disconnection events now that
    // the chain has successfully reset.
    for (const entry of disconnect) {
      const headers = entry.toHeaders();
      const view = new CoinView();
      await this.emitAsync('disconnect', entry, headers, view);
    }

    this.logger.warning(
      'SPV reorganization: old=%h(%d) new=%h(%d)',
      tip.hash,
      tip.height,
      competitor.hash,
      competitor.height
    );

    this.logger.warning(
      'Chain replay from height %d necessary.',
      fork.height);

    return this.emitAsync('reorganize', tip, competitor);
  }

  /**
   * Disconnect an entry from the chain (updates the tip).
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async disconnect(entry) {
    let block = await this.getBlock(entry.hash);

    if (!block) {
      if (!this.options.spv)
        throw new Error('Block not found.');
      block = entry.toHeaders();
    }

    const prev = await this.getPrevious(entry);
    const view = await this.db.disconnect(entry, block);

    assert(prev);

    this.tip = prev;
    this.height = prev.height;

    this.emit('tip', prev);

    return this.emitAsync('disconnect', entry, block, view);
  }

  /**
   * Reconnect an entry to the chain (updates the tip).
   * This will do contextual-verification on the block
   * (necessary because we cannot validate the inputs
   * in alternate chains when they come in).
   * @param {ChainEntry} entry
   * @param {Number} flags
   * @returns {Promise}
   */

  async reconnect(entry) {
    const flags = common.flags.VERIFY_NONE;

    let block = await this.getBlock(entry.hash);

    if (!block) {
      if (!this.options.spv)
        throw new Error('Block not found.');
      block = entry.toHeaders();
    }

    const prev = await this.getPrevious(entry);
    assert(prev);

    let view, state;
    try {
      [view, state] = await this.verifyContext(block, prev, flags);
    } catch (err) {
      if (err.type === 'VerifyError') {
        if (!err.malleated)
          this.setInvalid(entry.hash);
        this.logger.warning(
          'Tried to reconnect invalid block: %h (%d).',
          entry.hash, entry.height);
      }
      throw err;
    }

    await this.db.reconnect(entry, block, view);

    this.tip = entry;
    this.height = entry.height;
    this.setDeploymentState(state);

    this.emit('tip', entry);
    this.emit('reconnect', entry, block);

    return this.emitAsync('connect', entry, block, view);
  }

  /**
   * Set the best chain. This is called on every valid block
   * that comes in. It may add and connect the block (main chain),
   * save the block without connection (alternate chain), or
   * reorganize the chain (a higher fork).
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise}
   */

  async setBestChain(entry, block, prev, flags) {
    // A higher fork has arrived.
    // Time to reorganize the chain.
    if (!entry.prevBlock.equals(this.tip.hash)) {
      this.logger.warning('WARNING: Reorganizing chain.');

      // In spv-mode, we reset the
      // chain and redownload the blocks.
      if (this.options.spv)
        return this.reorganizeSPV(entry);

      await this.reorganize(entry);
    }

    // Warn of unknown versionbits.
    if (entry.hasUnknown(this.network)) {
      this.logger.warning(
        'Unknown version bits in block %d: %s.',
        entry.height, entry.version.toString(16));
    }

    // Otherwise, everything is in order.
    // Do "contextual" verification on our block
    // now that we're certain its previous
    // block is in the chain.
    let view, state;
    try {
      [view, state] = await this.verifyContext(block, prev, flags);
    } catch (err) {
      if (err.type === 'VerifyError') {
        if (!err.malleated)
          this.setInvalid(entry.hash);
        this.logger.warning(
          'Tried to connect invalid block: %h (%d).',
          entry.hash, entry.height);
      }
      throw err;
    }

    try {

    } catch (err) {

    }


    // Save block and connect inputs.
    await this.db.save(entry, block, view);

    // Expose the new state.
    this.tip = entry;
    this.height = entry.height;
    this.setDeploymentState(state);

    this.emit('tip', entry);
    this.emit('block', block, entry);

    return this.emitAsync('connect', entry, block, view);
  }

  /**
   * Save block on an alternate chain.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise}
   */

  async saveAlternate(entry, block, prev, flags) {
    // Do not accept forked chain older than the
    // last checkpoint.
    if (this.options.checkpoints) {
      if (prev.height + 1 < this.network.lastCheckpoint)
        throw new VerifyError(block,
          'checkpoint',
          'bad-fork-prior-to-checkpoint',
          100);
    }

    try {
      // Do as much verification
      // as we can before saving.
      await this.verify(block, prev, flags);
    } catch (err) {
      if (err.type === 'VerifyError') {
        if (!err.malleated)
          this.setInvalid(entry.hash);
        this.logger.warning(
          'Invalid block on alternate chain: %h (%d).',
          entry.hash, entry.height);
      }
      throw err;
    }

    // Warn of unknown versionbits.
    if (entry.hasUnknown(this.network)) {
      this.logger.warning(
        'Unknown version bits in block %d: %s.',
        entry.height, entry.version.toString(16));
    }

    await this.db.save(entry, block);

    this.logger.warning('Heads up: Competing chain at height %d:'
      + ' tip-height=%d competitor-height=%d'
      + ' tip-hash=%h competitor-hash=%h'
      + ' tip-chaintrust=%s competitor-chaintrust=%s'
      + ' chaintrust-diff=%s',
      entry.height,
      this.tip.height,
      entry.height,
      this.tip.hash,
      entry.hash,
      this.tip.chaintrust.toString(),
      entry.chaintrust.toString(),
      this.tip.chaintrust.sub(entry.chaintrust).toString());

    // Emit as a "competitor" block.
    this.emit('competitor', block, entry);
  }

  /**
   * Reset the chain to the desired block. This
   * is useful for replaying the blockchain download
   * for SPV.
   * @param {Hash|Number} block
   * @returns {Promise}
   */

  async reset(block) {
    const unlock = await this.locker.lock();
    try {
      return await this._reset(block, false);
    } finally {
      unlock();
    }
  }

  /**
   * Reset the chain to the desired block without a lock.
   * @private
   * @param {Hash|Number} block
   * @returns {Promise}
   */

  async _reset(block, silent) {
    const tip = await this.db.reset(block);

    // Reset state.
    this.tip = tip;
    this.height = tip.height;
    this.synced = false;

    const state = await this.getDeploymentState();

    this.setDeploymentState(state);

    this.emit('tip', tip);

    if (!silent)
      await this.emitAsync('reset', tip);

    // Reset the orphan map completely. There may
    // have been some orphans on a forked chain we
    // no longer need.
    this.purgeOrphans();

    this.maybeSync();
  }

  /**
   * Reset the chain to a height or hash. Useful for replaying
   * the blockchain download for SPV.
   * @param {Hash|Number} block - hash/height
   * @returns {Promise}
   */

  async replay(block) {
    const unlock = await this.locker.lock();
    try {
      return await this._replay(block, true);
    } finally {
      unlock();
    }
  }

  /**
   * Reset the chain without a lock.
   * @private
   * @param {Hash|Number} block - hash/height
   * @param {Boolean?} silent
   * @returns {Promise}
   */

  async _replay(block, silent) {
    const entry = await this.getEntry(block);

    if (!entry)
      throw new Error('Block not found.');

    if (!await this.isMainChain(entry))
      throw new Error('Cannot reset on alternate chain.');

    if (entry.isGenesis()) {
      await this._reset(entry.hash, silent);
      return;
    }

    await this._reset(entry.prevBlock, silent);
  }

  /**
   * Invalidate block.
   * @param {Hash} hash
   * @returns {Promise}
   */

  async invalidate(hash) {
    const unlock = await this.locker.lock();
    try {
      return await this._invalidate(hash);
    } finally {
      unlock();
    }
  }

  /**
   * Invalidate block (no lock).
   * @param {Hash} hash
   * @returns {Promise}
   */

  async _invalidate(hash) {
    await this._replay(hash, false);
    this.setInvalid(hash);
  }

  /**
   * Retroactively prune the database.
   * @returns {Promise}
   */

  async prune() {
    const unlock = await this.locker.lock();
    try {
      return await this.db.prune();
    } finally {
      unlock();
    }
  }

  /**
   * Scan the blockchain for transactions containing specified address hashes.
   * @param {Hash} start - Block hash to start at.
   * @param {Bloom} filter - Bloom filter containing tx and address hashes.
   * @param {Function} iter - Iterator.
   * @returns {Promise}
   */

  async scan(start, filter, iter) {
    const unlock = await this.locker.lock();
    try {
      return await this.db.scan(start, filter, iter);
    } finally {
      unlock();
    }
  }

  /**
   * Add a block to the chain, perform all necessary verification.
   * @param {Block} block
   * @param {Number?} flags
   * @param {Number?} id
   * @returns {Promise}
   */

  async add(block, flags, id) {
    const hash = block.hash();
    const unlock = await this.locker.lock(hash);
    try {
      return await this._add(block, flags, id);
    } finally {
      unlock();
    }
  }

  /**
   * Add a block to the chain without a lock.
   * @private
   * @param {Block} block
   * @param {Number?} flags
   * @param {Number?} id
   * @returns {Promise}
   */

  async _add(block, flags, id) {
    const hash = block.hash();

    if (flags == null)
      flags = common.flags.DEFAULT_FLAGS;

    if (id == null)
      id = -1;

    // Special case for genesis block.
    if (hash.equals(this.network.genesis.hash)) {
      this.logger.debug('Saw genesis block: %h.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // Do we already have this block in the queue?
    if (this.hasPending(hash)) {
      this.logger.debug('Already have pending block: %h.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // If the block is already known to be
    // an orphan, ignore it.
    if (this.hasOrphan(hash)) {
      this.logger.debug('Already have orphan block: %h.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // Do not revalidate known invalid blocks.
    // if (this.hasInvalid(block)) {
    //   this.logger.debug('Invalid ancestors for block: %h.', block.hash());
    //   throw new VerifyError(block, 'duplicate', 'duplicate', 100);
    // }


    if (block.isMemory()) {
      block = block.toBlock();
    }
    // Check the POW before doing anything.
    if (flags & common.flags.VERIFY_POW) {
      if (block.isProofOfWork() && !block.verifyPOW())
        throw new VerifyError(block, 'invalid', 'high-hash', 50);
    }

    if (flags & common.flags.VERIFY_POS) {
      if (block.isProofOfStake() && !block.verifyPOS())
        throw new VerifyError(block, 'invalid', 'bad-pos', 50)
    }

    // Do we already have this block?
    if (await this.hasEntry(hash)) {
      this.logger.debug('Already have block: %h.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // Find the previous block entry.
    const prev = await this.getEntry(block.prevBlock);

    // If previous block wasn't ever seen,
    // add it current to orphans and return.
    if (!prev) {
      this.storeOrphan(block, flags, id);
      return null;
    }

    // Connect the block.
    const entry = await this.connect(prev, block, flags);

    // Handle any orphans.
    if (this.hasNextOrphan(hash))
      await this.handleOrphans(entry);

    return entry;
  }

  /**
   * Connect block to chain.
   * @private
   * @param {ChainEntry} prev
   * @param {Block} block
   * @param {Number} flags
   * @returns {Promise}
   */

  async connect(prev, block, flags) {
    const start = util.bench();

    // Sanity check.
    assert(block.prevBlock.equals(prev.hash));

    // Explanation: we try to keep as much data
    // off the javascript heap as possible. Blocks
    // in the future may be 8mb or 20mb, who knows.
    // In fullnode-mode we store the blocks in
    // "compact" form (the headers plus the raw
    // Buffer object) until they're ready to be
    // fully validated here. They are deserialized,
    // validated, and connected. Hopefully the
    // deserialized blocks get cleaned up by the
    // GC quickly.
    if (block.isMemory()) {
      try {
        block = block.toBlock();
      } catch (e) {
        this.logger.error(e);
        throw new VerifyError(block,
          'malformed',
          'error parsing message',
          10,
          true);
      }
    }

    // Create a new chain entry.
    const entry = ChainEntry.fromBlock(block, prev);


    //ppcoin compute stake modifier
    try {
      const {stakeModifier, generated} = await this.kernel.computeNextStakeModifier(prev);
      entry.setStakeModifier(stakeModifier, generated)
    } catch (e) {
      this.logger.error(e);
      throw new VerifyError(block, 'malformed', 'compute-next-stake-modifier', 10, true);
    }

    //ppcoin proof hash
    if (entry.isProofOfStake()) {
      try {
        let {proofHash} = await this.kernel.checkProofOfStake(prev, block.txs[1], entry.bits);
        entry.proofHash = proofHash;
      } catch (e) {
        this.logger.error(e);
        throw new VerifyError(block, 'malformed', 'compute-stake-proof-hash', 1, true);
      }
    }

    // The block is on a alternate chain if the
    // chaintrust is less than or equal to
    // our tip's. Add the block but do _not_
    // connect the inputs.
    if (entry.chaintrust.lte(this.tip.chaintrust)) {
      // Save block to an alternate chain.
      await this.saveAlternate(entry, block, prev, flags);
    } else {
      // Attempt to add block to the chain index.
      await this.setBestChain(entry, block, prev, flags);
    }

    // Keep track of stats.
    this.logStatus(start, block, entry);

    // Check sync state.
    this.maybeSync();

    return entry;
  }

  /**
   * Handle orphans.
   * @private
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async handleOrphans(entry) {
    let orphan = this.resolveOrphan(entry.hash);

    while (orphan) {
      const {block, flags, id} = orphan;

      try {
        entry = await this.connect(entry, block, flags);
      } catch (err) {
        if (err.type === 'VerifyError') {
          this.logger.warning(
            'Could not resolve orphan block %h: %s.',
            block.hash(), err.message);

          this.emit('bad orphan', err, id);

          break;
        }
        throw err;
      }

      this.logger.debug(
        'Orphan block was resolved: %h (%d).',
        block.hash(), entry.height);

      this.emit('resolved', block, entry);

      orphan = this.resolveOrphan(entry.hash);
    }
  }

  /**
   * Test whether the chain has reached its slow height.
   * @private
   * @returns {Boolean}
   */

  isSlow() {
    if (this.options.spv)
      return false;

    if (this.synced)
      return true;

    if (this.height === 1 || this.height % 20 === 0)
      return true;

    if (this.height >= this.network.block.slowHeight)
      return true;

    return false;
  }

  /**
   * Calculate the time difference from
   * start time and log block.
   * @private
   * @param {Array} start
   * @param {Block} block
   * @param {ChainEntry} entry
   */

  logStatus(start, block, entry) {
    if (!this.isSlow())
      return;

    // Report memory for debugging.
    this.logger.memory();

    const elapsed = util.bench(start);

    this.logger.info(
      'Block %h (%d) added to chain (size=%d txs=%d time=%d).',
      entry.hash,
      entry.height,
      block.getSize(),
      block.txs.length,
      elapsed);
  }

  /**
   * Verify a block hash and height against the checkpoints.
   * @private
   * @param {ChainEntry} prev
   * @param {Hash} hash
   * @returns {Boolean}
   */

  verifyCheckpoint(prev, hash) {
    if (!this.options.checkpoints)
      return true;

    const height = prev.height + 1;
    const checkpoint = this.network.checkpointMap[height];

    if (!checkpoint)
      return true;

    if (hash.equals(checkpoint)) {
      this.logger.debug('Hit checkpoint block %h (%d).',
        hash, height);
      this.emit('checkpoint', hash, height);
      return true;
    }

    // Someone is either mining on top of
    // an old block for no reason, or the
    // consensus protocol is broken and
    // there was a 20k+ block reorg.
    this.logger.warning(
      'Checkpoint mismatch at height %d: expected=%h received=%h',
      height,
      checkpoint,
      hash
    );

    this.purgeOrphans();

    return false;
  }

  /**
   * Store an orphan.
   * @private
   * @param {Block} block
   * @param {Number?} flags
   * @param {Number?} id
   */

  storeOrphan(block, flags, id) {
    const height = block.getCoinbaseHeight();
    const orphan = this.orphanPrev.get(block.prevBlock);

    // The orphan chain forked.
    if (orphan) {
      assert(!orphan.block.hash().equals(block.hash()));
      assert(orphan.block.prevBlock.equals(block.prevBlock));

      this.logger.warning(
        'Removing forked orphan block: %h (%d).',
        orphan.block.hash(), height);

      this.removeOrphan(orphan);
    }

    this.limitOrphans();
    this.addOrphan(new Orphan(block, flags, id));

    this.logger.debug(
      'Storing orphan block: %h (%d).',
      block.hash(), height);

    this.emit('orphan', block);
  }

  /**
   * Add an orphan.
   * @private
   * @param {Orphan} orphan
   * @returns {Orphan}
   */

  addOrphan(orphan) {
    const block = orphan.block;
    const hash = block.hash();

    assert(!this.orphanMap.has(hash));
    assert(!this.orphanPrev.has(block.prevBlock));
    assert(this.orphanMap.size >= 0);

    this.orphanMap.set(hash, orphan);
    this.orphanPrev.set(block.prevBlock, orphan);

    return orphan;
  }

  /**
   * Remove an orphan.
   * @private
   * @param {Orphan} orphan
   * @returns {Orphan}
   */

  removeOrphan(orphan) {
    const block = orphan.block;
    const hash = block.hash();

    assert(this.orphanMap.has(hash));
    assert(this.orphanPrev.has(block.prevBlock));
    assert(this.orphanMap.size > 0);

    this.orphanMap.delete(hash);
    this.orphanPrev.delete(block.prevBlock);

    return orphan;
  }

  /**
   * Test whether a hash would resolve the next orphan.
   * @private
   * @param {Hash} hash - Previous block hash.
   * @returns {Boolean}
   */

  hasNextOrphan(hash) {
    return this.orphanPrev.has(hash);
  }

  /**
   * Resolve an orphan.
   * @private
   * @param {Hash} hash - Previous block hash.
   * @returns {Orphan}
   */

  resolveOrphan(hash) {
    const orphan = this.orphanPrev.get(hash);

    if (!orphan)
      return null;

    return this.removeOrphan(orphan);
  }

  /**
   * Purge any waiting orphans.
   */

  purgeOrphans() {
    const count = this.orphanMap.size;

    if (count === 0)
      return;

    this.orphanMap.clear();
    this.orphanPrev.clear();

    this.logger.debug('Purged %d orphans.', count);
  }

  /**
   * Prune orphans, only keep the orphan with the highest
   * coinbase height (likely to be the peer's tip).
   */

  limitOrphans() {
    const now = util.now();

    let oldest = null;
    for (const orphan of this.orphanMap.values()) {
      if (now < orphan.time + 60 * 60) {
        if (!oldest || orphan.time < oldest.time)
          oldest = orphan;
        continue;
      }

      this.removeOrphan(orphan);
    }

    if (this.orphanMap.size < this.options.maxOrphans)
      return;

    if (!oldest)
      return;

    this.removeOrphan(oldest);
  }

  /**
   * Test whether an invalid block hash has been seen.
   * @private
   * @param {Block} block
   * @returns {Boolean}
   */

  hasInvalid(block) {
    const hash = block.hash();

    if (this.invalid.has(hash))
      return true;

    if (this.invalid.has(block.prevBlock)) {
      this.setInvalid(hash);
      return true;
    }

    return false;
  }

  /**
   * Mark a block as invalid.
   * @private
   * @param {Hash} hash
   */

  setInvalid(hash) {
    this.invalid.set(hash, true);
  }

  /**
   * Forget an invalid block hash.
   * @private
   * @param {Hash} hash
   */

  removeInvalid(hash) {
    this.invalid.remove(hash);
  }

  /**
   * Test the chain to see if it contains
   * a block, or has recently seen a block.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async has(hash) {
    if (this.hasOrphan(hash))
      return true;

    if (this.locker.has(hash))
      return true;

    if (this.invalid.has(hash))
      return true;

    return this.hasEntry(hash);
  }

  /**
   * Find the corresponding block entry by hash or height.
   * @param {Hash|Number} hash/height
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntry(hash) {
    return this.db.getEntry(hash);
  }

  /**
   * Retrieve a chain entry by height.
   * @param {Number} height
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntryByHeight(height) {
    return this.db.getEntryByHeight(height);
  }

  /**
   * Retrieve a chain entry by hash.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntryByHash(hash) {
    return this.db.getEntryByHash(hash);
  }

  /**
   * Get the hash of a block by height. Note that this
   * will only return hashes in the main chain.
   * @param {Number} height
   * @returns {Promise} - Returns {@link Hash}.
   */

  getHash(height) {
    return this.db.getHash(height);
  }

  /**
   * Get the height of a block by hash.
   * @param {Hash} hash
   * @returns {Promise} - Returns Number.
   */

  getHeight(hash) {
    return this.db.getHeight(hash);
  }

  /**
   * Test the chain to see if it contains a block.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasEntry(hash) {
    return this.db.hasEntry(hash);
  }

  /**
   * Get the _next_ block hash (does not work by height).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Hash}.
   */

  getNextHash(hash) {
    return this.db.getNextHash(hash);
  }

  /**
   * Check whether coins are still unspent. Necessary for bip30.
   * @see https://bitcointalk.org/index.php?topic=67738.0
   * @param {TX} tx
   * @returns {Promise} - Returns Boolean.
   */

  hasCoins(tx) {
    return this.db.hasCoins(tx);
  }

  /**
   * Get all tip hashes.
   * @returns {Promise} - Returns {@link Hash}[].
   */

  getTips() {
    return this.db.getTips();
  }

  /**
   * Get range of hashes.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise}
   */

  getHashes(start = -1, end = -1) {
    return this.db.getHashes(start, end);
  }

  /**
   * Get a coin (unspents only).
   * @private
   * @param {Outpoint} prevout
   * @returns {Promise} - Returns {@link CoinEntry}.
   */

  readCoin(prevout) {
    return this.db.readCoin(prevout);
  }

  /**
   * Get a coin (unspents only).
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {@link Coin}.
   */

  getCoin(hash, index) {
    return this.db.getCoin(hash, index);
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  getBlock(hash) {
    return this.db.getBlock(hash);
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  getRawBlock(block) {
    return this.db.getRawBlock(block);
  }

  /**
   * Get a historical block coin viewpoint.
   * @param {Block} hash
   * @returns {Promise} - Returns {@link CoinView}.
   */

  getBlockView(block) {
    return this.db.getBlockView(block);
  }

  /**
   * Get an orphan block.
   * @param {Hash} hash
   * @returns {Block}
   */

  getOrphan(hash) {
    return this.orphanMap.get(hash) || null;
  }

  /**
   * Test the chain to see if it contains an orphan.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasOrphan(hash) {
    return this.orphanMap.has(hash);
  }

  /**
   * Test the chain to see if it contains a pending block in its queue.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasPending(hash) {
    return this.locker.pending(hash);
  }

  /**
   * Get coin viewpoint.
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  getCoinView(tx) {
    return this.db.getCoinView(tx);
  }

  /**
   * Test the chain to see if it is synced.
   * @returns {Boolean}
   */

  isFull() {
    return this.synced;
  }

  /**
   * Potentially emit a `full` event.
   * @private
   */

  maybeSync() {
    if (this.synced)
      return;

    if (this.options.checkpoints) {
      if (this.height < this.network.lastCheckpoint)
        return;
    }

    if (this.tip.time < util.now() - this.network.block.maxTipAge)
      return;

    // ToDO
    // if (!this.hasChaintrust())
    //    return;

    this.synced = true;
    this.emit('full');
  }

  /**
   * Test the chain to see if it has the
   * minimum required chaintrust for the
   * network.
   * @returns {Boolean}
   */

  hasChaintrust() {
    return this.tip.chaintrust.gte(this.network.pow.chaintrust);
  }

  /**
   * Get the fill percentage.
   * @returns {Number} percent - Ranges from 0.0 to 1.0.
   */

  getProgress() {
    const start = this.network.genesis.time;
    const current = this.tip.time - start;
    const end = util.now() - start - 40 * 60;
    return Math.min(1, current / end);
  }

  /**
   * Calculate chain locator (an array of hashes).
   * @param {Hash?} start - Height or hash to treat as the tip.
   * The current tip will be used if not present. Note that this can be a
   * non-existent hash, which is useful for headers-first locators.
   * @returns {Promise} - Returns {@link Hash}[].
   */

  async getLocator(start) {
    const unlock = await this.locker.lock();
    try {
      return await this._getLocator(start);
    } finally {
      unlock();
    }
  }

  /**
   * Calculate chain locator without a lock.
   * @private
   * @param {Hash?} start
   * @returns {Promise}
   */

  async _getLocator(start) {
    if (start == null)
      start = this.tip.hash;

    assert(Buffer.isBuffer(start));

    let entry = await this.getEntry(start);

    const hashes = [];

    if (!entry) {
      entry = this.tip;
      hashes.push(start);
    }

    let main = await this.isMainChain(entry);
    let hash = entry.hash;
    let height = entry.height;
    let step = 1;

    hashes.push(hash);

    while (height > 0) {
      height -= step;

      if (height < 0)
        height = 0;

      if (hashes.length > 10)
        step *= 2;

      if (main) {
        // If we're on the main chain, we can
        // do a fast lookup of the hash.
        hash = await this.getHash(height);
        assert(hash);
      } else {
        const ancestor = await this.getAncestor(entry, height);
        assert(ancestor);
        main = await this.isMainChain(ancestor);
        hash = ancestor.hash;
      }

      hashes.push(hash);
    }

    return hashes;
  }

  /**
   * Calculate the orphan root of the hash (if it is an orphan).
   * @param {Hash} hash
   * @returns {Hash}
   */

  getOrphanRoot(hash) {
    let root = null;

    assert(hash);

    for (; ;) {
      const orphan = this.orphanMap.get(hash);

      if (!orphan)
        break;

      root = hash;
      hash = orphan.block.prevBlock;
    }

    return root;
  }

  /**
   * Calculate the time difference (in seconds)
   * between two blocks by examining chaintrusts.
   * @param {ChainEntry} to
   * @param {ChainEntry} from
   * @returns {Number}
   */

  getProofTime(to, from) {
    const pow = this.network.pow;
    let sign, work;

    if (to.chaintrust.gt(from.chaintrust)) {
      work = to.chaintrust.sub(from.chaintrust);
      sign = 1;
    } else {
      work = from.chaintrust.sub(to.chaintrust);
      sign = -1;
    }

    work = work.imuln(pow.targetSpacing);
    work = work.div(this.tip.getProof());

    if (work.bitLength() > 53)
      return sign * Number.MAX_SAFE_INTEGER;

    return sign * work.toNumber();
  }

  /**
   * Calculate the next target.
   * @param {ChainEntry} prev - Previous entry.
   * @param {Boolean} isProofOfStake - if the block is proof of stake
   * @returns {Promise} - returns Number
   * (target is in compact/mantissa form).
   */

  async getTarget(_, prev, isProofOfStake) {
    const pow = this.network.pow;
    const pos = this.network.pos;

    const targetLimit = isProofOfStake ? pos.limit : pow.limit;
    const targetBits = isProofOfStake ? pos.bits : pow.bits;

    if (!prev) {
      return targetBits;    // Genesis
    }

    const last = await this.getLastEntry(prev, isProofOfStake);
    if (consensus.ZERO_HASH.equals(last.prevBlock)) {
      return targetBits; //first block;
    }
    assert(last);
    const lastParent = this.getPrevCache(last) || await this.getPrevious(last);
    const prevLast = await this.getLastEntry(lastParent, isProofOfStake);
    if (consensus.ZERO_HASH.equals(prevLast.prevBlock)) {
      return targetBits; //first block;
    }
    assert(prevLast);

    const targetSpacing = this.network.getTargetSpacing(prev.height)

    let actualSpacing = last.time - prevLast.time;

    if (this.network.isProtocolV1RetargetingFixed(prev.height) && actualSpacing < 0)
      actualSpacing = targetSpacing


    let newTarget = consensus.fromCompact(last.bits);
    let interval = pow.targetTimespan / targetSpacing;
    newTarget = newTarget.muln((interval - 1) * targetSpacing + actualSpacing + actualSpacing);
    newTarget = newTarget.divn((interval + 1) * targetSpacing);

    if (newTarget <= 0 || newTarget > targetLimit)
      newTarget = targetLimit;

    return consensus.toCompact(newTarget);
  }

  /**
   * Find a locator. Analagous to bitcoind's `FindForkInGlobalIndex()`.
   * @param {Hash[]} locator - Hashes.
   * @returns {Promise} - Returns {@link Hash} (the
   * hash of the latest known block).
   */

  async findLocator(locator) {
    for (const hash of locator) {
      if (await this.isMainHash(hash))
        return hash;
    }

    return this.network.genesis.hash;
  }

  /**
   * Check whether a versionbits deployment is active (BIP9: versionbits).
   * @example
   * await chain.isActive(tip, deployments.segwit);
   * @see https://github.com/bitcoin/bips/blob/master/bip-0009.mediawiki
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {String} id - Deployment id.
   * @returns {Promise} - Returns Number.
   */

  async isActive(prev, deployment) {
    const state = await this.getState(prev, deployment);
    return state === thresholdStates.ACTIVE;
  }

  /**
   * Get chain entry state for a deployment (BIP9: versionbits).
   * @example
   * await chain.getState(tip, deployments.segwit);
   * @see https://github.com/bitcoin/bips/blob/master/bip-0009.mediawiki
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {String} id - Deployment id.
   * @returns {Promise} - Returns Number.
   */

  async getState(prev, deployment) {
    const bit = deployment.bit;

    if (deployment.startTime === -1)
      return thresholdStates.ACTIVE;

    let window = this.network.minerWindow;
    let threshold = this.network.activationThreshold;

    if (deployment.threshold !== -1)
      threshold = deployment.threshold;

    if (deployment.window !== -1)
      window = deployment.window;

    if (((prev.height + 1) % window) !== 0) {
      const height = prev.height - ((prev.height + 1) % window);

      prev = await this.getAncestor(prev, height);

      if (!prev)
        return thresholdStates.DEFINED;

      assert(prev.height === height);
      assert(((prev.height + 1) % window) === 0);
    }

    let entry = prev;
    let state = thresholdStates.DEFINED;

    const compute = [];

    while (entry) {
      const cached = this.db.stateCache.get(bit, entry);

      if (cached !== -1) {
        state = cached;
        break;
      }

      const time = await this.getMedianTime(entry);

      if (time < deployment.startTime) {
        state = thresholdStates.DEFINED;
        this.db.stateCache.set(bit, entry, state);
        break;
      }

      compute.push(entry);

      const height = entry.height - window;

      entry = await this.getAncestor(entry, height);
    }

    while (compute.length) {
      const entry = compute.pop();

      switch (state) {
        case thresholdStates.DEFINED: {
          const time = await this.getMedianTime(entry);

          if (time >= deployment.timeout) {
            state = thresholdStates.FAILED;
            break;
          }

          if (time >= deployment.startTime) {
            state = thresholdStates.STARTED;
            break;
          }

          break;
        }
        case thresholdStates.STARTED: {
          const time = await this.getMedianTime(entry);

          if (time >= deployment.timeout) {
            state = thresholdStates.FAILED;
            break;
          }

          let block = entry;
          let count = 0;

          for (let i = 0; i < window; i++) {
            if (block.hasBit(bit))
              count++;

            if (count >= threshold) {
              state = thresholdStates.LOCKED_IN;
              break;
            }

            block = await this.getPrevious(block);
            assert(block);
          }

          break;
        }
        case thresholdStates.LOCKED_IN: {
          state = thresholdStates.ACTIVE;
          break;
        }
        case thresholdStates.FAILED:
        case thresholdStates.ACTIVE: {
          break;
        }
        default: {
          assert(false, 'Bad state.');
          break;
        }
      }

      this.db.stateCache.set(bit, entry, state);
    }

    return state;
  }

  /**
   * Compute the version for a new block (BIP9: versionbits).
   * @see https://github.com/bitcoin/bips/blob/master/bip-0009.mediawiki
   * @param {ChainEntry} prev - Previous chain entry (usually the tip).
   * @returns {Promise} - Returns Number.
   */

  async computeBlockVersion(prev) {
    let version = 0;

    for (const deployment of this.network.deploys) {
      const state = await this.getState(prev, deployment);

      if (state === thresholdStates.LOCKED_IN
        || state === thresholdStates.STARTED) {
        version |= 1 << deployment.bit;
      }
    }

    version |= consensus.VERSION_TOP_BITS;
    version >>>= 0;

    return version;
  }

  /**
   * Get the current deployment state of the chain. Called on load.
   * @private
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async getDeploymentState() {
    const prev = await this.getPrevious(this.tip);

    if (!prev) {
      assert(this.tip.isGenesis());
      return this.state;
    }

    if (this.options.spv)
      return this.state;

    return this.getDeployments(this.tip.time, prev);
  }

  /**
   * Check transaction finality, taking into account MEDIAN_TIME_PAST
   * if it is present in the lock flags.
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {TX} tx
   * @param {LockFlags} flags
   * @returns {Promise} - Returns Boolean.
   */

  async verifyFinal(prev, tx, flags) {
    const height = prev.height + 1;

    // We can skip MTP if the locktime is height.
    if (tx.locktime < consensus.LOCKTIME_THRESHOLD)
      return tx.isFinal(height, -1);

    if (flags & common.lockFlags.MEDIAN_TIME_PAST) {
      const time = await this.getMedianTime(prev);
      return tx.isFinal(height, time);
    }

    return tx.isFinal(height, this.network.now());
  }

  /**
   * Get the necessary minimum time and height sequence locks for a transaction.
   * @param {ChainEntry} prev
   * @param {TX} tx
   * @param {CoinView} view
   * @param {LockFlags} flags
   * @returns {Promise}
   */

  async getLocks(prev, tx, view, flags) {
    const GRANULARITY = consensus.SEQUENCE_GRANULARITY;
    const DISABLE_FLAG = consensus.SEQUENCE_DISABLE_FLAG;
    const TYPE_FLAG = consensus.SEQUENCE_TYPE_FLAG;
    const MASK = consensus.SEQUENCE_MASK;

    if (!(flags & common.lockFlags.VERIFY_SEQUENCE))
      return [-1, -1];

    if (tx.isCoinbase() || tx.version < 2)
      return [-1, -1];

    let minHeight = -1;
    let minTime = -1;

    for (const {prevout, sequence} of tx.inputs) {
      if (sequence & DISABLE_FLAG)
        continue;

      let height = view.getHeight(prevout);

      if (height === -1)
        height = this.height + 1;

      if (!(sequence & TYPE_FLAG)) {
        height += (sequence & MASK) - 1;
        minHeight = Math.max(minHeight, height);
        continue;
      }

      height = Math.max(height - 1, 0);

      const entry = await this.getAncestor(prev, height);
      assert(entry, 'Database is corrupt.');

      let time = await this.getMedianTime(entry);
      time += ((sequence & MASK) << GRANULARITY) - 1;
      minTime = Math.max(minTime, time);
    }

    return [minHeight, minTime];
  }

  /**
   * Verify sequence locks.
   * @param {ChainEntry} prev
   * @param {TX} tx
   * @param {CoinView} view
   * @param {LockFlags} flags
   * @returns {Promise} - Returns Boolean.
   */

  async verifyLocks(prev, tx, view, flags) {
    const [height, time] = await this.getLocks(prev, tx, view, flags);

    if (height !== -1) {
      if (height >= prev.height + 1)
        return false;
    }

    if (time !== -1) {
      const mtp = await this.getMedianTime(prev);

      if (time >= mtp)
        return false;
    }

    return true;
  }


}

/**
 * ChainOptions
 * @alias module:blockchain.ChainOptions
 */

class ChainOptions {
  /**
   * Create chain options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;
    this.blocks = null;
    this.workers = null;
    this.kernel = null;

    this.prefix = null;
    this.location = null;
    this.memory = true;
    this.maxFiles = 64;
    this.cacheSize = 32 << 20;
    this.compression = true;

    this.spv = false;
    this.prune = false;
    this.forceFlags = false;

    this.entryCache = 5000;
    this.maxOrphans = 20;
    this.checkpoints = true;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {ChainOptions}
   */

  fromOptions(options) {
    if (!options.spv) {
      assert(options.blocks && typeof options.blocks === 'object',
        'Chain requires a blockstore.');
    }

    this.blocks = options.blocks;

    if (options.network != null)
      this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.workers != null) {
      assert(typeof options.workers === 'object');
      this.workers = options.workers;
    }

    if (options.kernel != null) {
      assert(typeof options.kernel === 'object');
      this.kernel = options.kernel;
    }

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.location = this.spv
        ? path.join(this.prefix, 'spvchain')
        : path.join(this.prefix, 'chain');
    }

    if (options.location != null) {
      assert(typeof options.location === 'string');
      this.location = options.location;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean');
      this.memory = options.memory;
    }

    if (options.maxFiles != null) {
      assert((options.maxFiles >>> 0) === options.maxFiles);
      this.maxFiles = options.maxFiles;
    }

    if (options.cacheSize != null) {
      assert(Number.isSafeInteger(options.cacheSize));
      assert(options.cacheSize >= 0);
      this.cacheSize = options.cacheSize;
    }

    if (options.compression != null) {
      assert(typeof options.compression === 'boolean');
      this.compression = options.compression;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }

    if (options.forceFlags != null) {
      assert(typeof options.forceFlags === 'boolean');
      this.forceFlags = options.forceFlags;
    }


    if (options.entryCache != null) {
      assert((options.entryCache >>> 0) === options.entryCache);
      this.entryCache = options.entryCache;
    }

    if (options.maxOrphans != null) {
      assert((options.maxOrphans >>> 0) === options.maxOrphans);
      this.maxOrphans = options.maxOrphans;
    }

    if (options.checkpoints != null) {
      assert(typeof options.checkpoints === 'boolean');
      this.checkpoints = options.checkpoints;
    }

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {ChainOptions}
   */

  static fromOptions(options) {
    return new ChainOptions().fromOptions(options);
  }
}

/**
 * Deployment State
 * @alias module:blockchain.DeploymentState
 * @property {VerifyFlags} flags
 * @property {LockFlags} lockFlags
 * @property {Boolean} bip34
 */

class DeploymentState {
  /**
   * Create a deployment state.
   * @constructor
   */

  constructor() {
    this.flags = Script.flags.MANDATORY_VERIFY_FLAGS;
    this.flags &= ~Script.flags.VERIFY_P2SH;
    this.lockFlags = common.lockFlags.MANDATORY_LOCKTIME_FLAGS;
  }

  /**
   * Test whether p2sh is active.
   * @returns {Boolean}
   */

  hasP2SH() {
    return (this.flags & Script.flags.VERIFY_P2SH) !== 0;
  }

  /**
   * Test whether cltv is active.
   * @returns {Boolean}
   */

  hasCLTV() {
    return (this.flags & Script.flags.VERIFY_CHECKLOCKTIMEVERIFY) !== 0;
  }

  /**
   * Test whether median time past locktime is active.
   * @returns {Boolean}
   */

  hasMTP() {
    return (this.lockFlags & common.lockFlags.MEDIAN_TIME_PAST) !== 0;
  }

  /**
   * Test whether csv is active.
   * @returns {Boolean}
   */

  hasCSV() {
    return (this.flags & Script.flags.VERIFY_CHECKSEQUENCEVERIFY) !== 0;
  }

}

/**
 * Orphan
 * @ignore
 */

class Orphan {
  /**
   * Create an orphan.
   * @constructor
   */

  constructor(block, flags, id) {
    this.block = block;
    this.flags = flags;
    this.id = id;
    this.time = util.now();
  }
}

/*
 * Helpers
 */

function cmp(a, b) {
  return a - b;
}

/*
 * Expose
 */

module.exports = Chain;


