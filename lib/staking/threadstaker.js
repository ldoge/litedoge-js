/*!
 * threadstaker.js - staking implmentation
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const {Lock} = require('bmutex');
const util = require('../utils/util');
const TX = require('../primitives/tx')
const consensus = require('../protocol/consensus')
const Output = require('../primitives/output')

/**
 * Thread Staker
 * @alias module:staking.ThreadStaker
 */

class ThreadStaker extends EventEmitter {


  /**
   * Create a Thread staker.
   * @constructor
   * @param {Staker} staker
   */

  constructor(staker) {
    super();

    this.opened = false;
    this.staker = staker;
    this.network = this.staker.network;
    this.logger = this.staker.logger.context('staking');
    this.workers = this.staker.workers;
    this.chain = this.staker.chain;
    this.pool = this.staker.pool;
    this.locker = new Lock();
    this.running = false;
    this.stopping = false;
    this.job = null;
    this.stopJob = null;
    this.activeDelay = null;

    this.init();
  }

  /**
   * Initialize the miner.
   * @private
   */

  init() {
    this.chain.on('tip', (tip) => {
      if (!this.job)
        return;

      if (this.job.attempt.prevBlock.equals(tip.prevBlock))
        this.job.destroy();
    });
  }

  /**
   * Open the miner.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'ThreadStakeMiner is already open.');
    this.opened = true;
    this.start();
  }

  /**
   * Close the miner.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'ThreadStakeMiner is not open.');
    this.opened = false;
    return this.stop();
  }

  /**
   * Start mining.
   * @method
   */

  start() {
    assert(!this.running, 'ThreadStakeMiner is already running.');
    this._start().catch(() => {
    });
  }


  /**
   * Start mining.
   * @method
   * @private
   * @returns {Promise}
   */

  async _start() {
    assert(!this.running, 'ThreadStakeMiner is already running.');
    this.wallet = this.staker.wallet;

    this.running = true;
    this.stopping = false;
    for (; ;) {
      this.job = null;

      if (this.stopping)
        break;


      if (this.wallet.master.encrypted) {
        this.activeDelay = this.delay(1000);
        await this.activeDelay.promise;
        continue;
      }

      if (this.stopping)
        break;

      if (this.pool.peers.size() === 0 || !this.chain.isFull()) {
        this.tryToSync = true;

        this.activeDelay = this.delay(10000);
        await this.activeDelay.promise;
        continue;
      }

      if (this.stopping)
        break;

      if (this.tryToSync) {
        this.tryToSync = false;
        const tip = this.chain.tip;
        if (this.pool.peers.size() < 3 || tip.time < util.now() - 10 * 60) {
          this.activeDelay = this.delay(30000);
          await this.activeDelay.promise;
          continue;
        }
      }

      if (this.stopping)
        break;


      try {
        const receiveAddress = await this.wallet.receiveAddress();
        this.job = await this.createJob(this.chain.tip, receiveAddress)
      } catch (e) {
        if (this.stopping)
          break;
        this.emit('error', e);
        break;
      }

      if (this.stopping)
        break;

      let block;
      try {
        block = await this.attemptStakeAsync(this.job);
      } catch (e) {
        if (this.stopping)
          break;
        this.emit('error', e);
        break;
      }

      this.activeDelay = this.delay(500);
      await this.activeDelay.promise;
      // Log the block hex as a failsafe (in case we can't send it).
      // this.logger.info('Found block: %d (%h).', entry.height, entry.hash);
      //
      // this.emit('block', block, entry);
    }
    const job = this.stopJob;

    if (job) {
      this.stopJob = null;
      job.resolve();
    }

  }


  /**
   * Create a mining job.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns {@link Job}.
   */

  async createJob(tip, address) {
    const attempt = await this.staker.createBlock(tip, address);
    return new ThreadStakeJob(this, attempt);
  }


  /**
   * litedogecoin: attempt to generate suitable proof-of-stake
   * @method
   * @param {ThreadStakeJob} job
   * @returns {Promise} - Returns {@link Block}.
   */

  async attemptStakeAsync(job) {

    job.start = util.now();

    const tip = this.chain.tip;
    const block = job.attempt.toBlock();

    // if we are trying to sign
    //    something except proof-of-stake block template
    if (!block.txs[0].outputs[0].isEmpty())
      return null;

    // It's already been signed go away.
    if (block.isProofOfStake())
      return block;

    const isProtocolV2 = this.network.isProtocolV2(this.wallet.wdb.height + 1);

    // startup timestamp
    job.lastSearchTime ||= util.now();

    let coinStakeTime = util.now();
    if (isProtocolV2)
      coinStakeTime &= ~this.staker.STAKE_TIMESTAMP_MASK;

    const searchTime = coinStakeTime;
    if (searchTime > job.lastSearchTime) {
      let searchInterval = isProtocolV2 ? 1 : coinStakeTime - job.lastSearchTime;

      const coinStake = await this.wallet.createCoinStake(job.attempt.bits, coinStakeTime, searchInterval);
      if (coinStake != null) {

      }
      job.lastSearchInterval = searchTime - job.lastSearchTime;
      job.lastSearchTime = searchTime;
      this.sendStatus(job, searchTime);
    }

    if (job.destroyed)
      return null;


    //nMinerSleep
    this.activeDelay = this.delay(500);
    await this.activeDelay.promise;


    return job.commit();
  }

  /**
   * Send a progress report (emits `status`).
   * @param {ThreadStakeJob} job
   * @param {Number} searchTime
   */

  sendStatus(job, searchTime) {
    const attempt = job.attempt;
    this.logger.info("hi");
    // const tip = attempt.prevBlock;
    // this.logger.info(
    //   'Status: hashrate=%dkhs hashes=%d target=%d height=%d tip=%h',
    //   Math.floor(hashrate / 1000),
    //   hashes,
    //   attempt.bits,
    //   attempt.height,
    //   );

    // this.emit('status', job, hashes, hashrate);
  }


  /**
   * Stop mining.
   * @method
   * @returns {Promise}
   */

  async stop() {
    const unlock = await this.locker.lock();
    try {
      return await this._stop();
    } finally {
      unlock();
    }
  }

  /**
   * Stop mining (without a lock).
   * @method
   * @returns {Promise}
   */

  async _stop() {
    if (!this.running)
      return;

    assert(this.running, 'Miner is not running.');
    assert(!this.stopping, 'Miner is already stopping.');

    this.stopping = true;
    if (this.activeDelay) {
      this.activeDelay.cancel()
    }

    if (this.job) {
      this.job.destroy();
      this.job = null;
    }

    await this.wait();

    this.running = false;
    this.stopping = false;
    this.job = null;
  }

  /**
   * Wait for `done` event.
   * @private
   * @returns {Promise}
   */

  wait() {
    return new Promise((resolve, reject) => {
      assert(!this.stopJob);
      this.stopJob = {resolve, reject};
    });
  }

  delay(ms) {
    let timeout;
    let resolver;
    return {
      promise: new Promise((resolve) => {
        resolver = resolve;
        timeout = setTimeout(resolve, ms);
      }),
      cancel: () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (resolver) {
          resolver();
        }
      }
    };
  }
}

/**
 * Staking Job
 * @ignore
 */

class ThreadStakeJob {
  /**
   * Create a mining job.
   * @constructor
   * @param {ThreadStaker} staker
   * @param {BlockTemplate} attempt
   */

  constructor(staker, attempt) {
    this.staker = staker;
    this.attempt = attempt;
    this.destroyed = false;
    this.committed = false;
    this.start = util.now();
    this.lastSearchTime = 0;
    this.lastSearchInterval = 0;
    this.refresh();
  }

  /**
   * Get the raw block header.
   * @param {Number} nonce
   * @returns {Buffer}
   */

  getHeader() {
    const attempt = this.attempt;
    const time = attempt.time;
    const root = attempt.getRoot(n1, n2);
    const data = attempt.getHeader(root, time, 0);
    return data;
  }

  /**
   * Commit job and return a block.
   * @param {Number} nonce
   * @returns {Block}
   */

  commit(nonce) {
    const attempt = this.attempt;
    const n1 = this.nonce1;
    const n2 = this.nonce2;
    const time = attempt.time;

    assert(!this.committed, 'Job already committed.');
    this.committed = true;

    const proof = attempt.getProof(n1, n2, time, nonce);

    return attempt.commit(proof);
  }

  /**
   * Refresh the block template.
   */

  refresh() {
    return this.attempt.refresh();
  }

  /**
   * Destroy the job.
   */

  destroy() {
    assert(!this.destroyed, 'Job already destroyed.');
    this.destroyed = true;
  }


  /**
   * Add a transaction to the block.
   * @param {TX} tx
   * @param {CoinView} view
   */

  addTX(tx, view) {
    return this.attempt.addTX(tx, view);
  }

  /**
   * Add a transaction to the block
   * (less verification than addTX).
   * @param {TX} tx
   * @param {CoinView?} view
   */

  pushTX(tx, view) {
    return this.attempt.pushTX(tx, view);
  }
}

/*
 * Expose
 */

module.exports = ThreadStaker;
