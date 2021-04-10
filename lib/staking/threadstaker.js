/*!
 * threadstaker.js - staking implmentation
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const {Lock} = require('bmutex');
const util = require('../utils/util');

/**
 * Thread Staker
 * @alias module:staking.ThreadStaker
 */

class ThreadStaker extends EventEmitter {
  /**
   * Create a CPU miner.
   * @constructor
   * @param {StakingKernel} stakingKernel
   */

  constructor(stakingKernel) {
    super();

    this.opened = false;
    this.kernel = stakingKernel;
    this.network = this.kernel.network;
    this.logger = this.kernel.logger.context('staking');
    this.workers = this.kernel.workers;
    this.chain = this.kernel.chain;
    this.pool = this.kernel.pool;

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
    const wallet = this.kernel.wallet;

    this.running = true;
    this.stopping = false;
    for (;;) {

      if (this.stopping)
        break;


      if (wallet.master.encrypted) {
        this.lastCoinStakeSearchInterval = 0;
        this.activeDelay = this.delay(1000);
        await this.activeDelay.promise;
        continue;
      }

      if (this.stopping)
        break;

      if (this.pool.peers.size() === 0 || !this.chain.isFull()) {
        this.lastCoinStakeSearchInterval = 0;
        this.tryToSync = true;

        this.activeDelay =this.delay(10000);
        await this.activeDelay.promise;
        continue;
      }

      if (this.stopping)
        break;

      if (this.tryToSync) {
        this.tryToSync = false;
        const tip = this.chain.tip;
        if (this.pool.peers.size() < 3 || tip.time < util.now() - 10 * 60) {
          this.activeDelay =this.delay(10000);
          await this.activeDelay.promise;

          continue;
        }
      }

      if (this.stopping)
        break;

      const receiveAddress = await  wallet.receiveAddress();

      this.job = await this.createJob(this.chain.tip, receiveAddress)
      this.activeDelay =this.delay(10000);
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
    const attempt = await this.kernel.createBlock(tip, address);
    return new ThreadStakeJob(this, attempt);
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
        if (timeout)
        {
          clearTimeout(timeout);
        }
        if (resolver) {
          resolver();
        }
      }
    };
  }


  /**
   * Mine synchronously until the block is found.
   * @param {CPUJob} job
   * @returns {Block}
   */

  mine(job) {
    job.start = util.now();

    let nonce;
    for (; ;) {
      nonce = this.findNonce(job);

      if (nonce !== -1)
        break;

      job.updateNonce();

      this.sendStatus(job, 0);
    }

    return job.commit(nonce);
  }

  /**
   * Mine asynchronously until the block is found.
   * @method
   * @param {CPUJob} job
   * @returns {Promise} - Returns {@link Block}.
   */

  async mineAsync(job) {
    let nonce;

    job.start = util.now();

    for (; ;) {
      nonce = await this.findNonceAsync(job);

      if (nonce !== -1)
        break;

      if (job.destroyed)
        return null;

      job.updateNonce();

      this.sendStatus(job, 0);
    }

    return job.commit(nonce);
  }

  /**
   * Send a progress report (emits `status`).
   * @param {CPUJob} job
   * @param {Number} nonce
   */

  sendStatus(job, nonce) {
    const attempt = job.attempt;
    const tip = attempt.prevBlock;
    const hashes = job.getHashes(nonce);
    const hashrate = job.getRate(nonce);

    this.logger.info(
      'Status: hashrate=%dkhs hashes=%d target=%d height=%d tip=%h',
      Math.floor(hashrate / 1000),
      hashes,
      attempt.bits,
      attempt.height,
      tip);

    this.emit('status', job, hashes, hashrate);
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
   * @param {ThreadStaker} miner
   * @param {BlockTemplate} attempt
   */

  constructor(staker, attempt) {
    this.staker = staker;
    this.attempt = attempt;
    this.destroyed = false;
    this.committed = false;
    this.start = util.now();
    this.nonce1 = 0;
    this.nonce2 = 0;
    this.refresh();
  }

  /**
   * Get the raw block header.
   * @param {Number} nonce
   * @returns {Buffer}
   */

  getHeader() {
    const attempt = this.attempt;
    const n1 = this.nonce1;
    const n2 = this.nonce2;
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
   * Mine block synchronously.
   * @returns {Block}
   */

  mine() {
    return this.miner.mine(this);
  }

  /**
   * Mine block asynchronously.
   * @returns {Promise}
   */

  mineAsync() {
    return this.miner.mineAsync(this);
  }

  /**
   * Refresh the block template.
   */

  refresh() {
    return this.attempt.refresh();
  }

  /**
   * Increment the extraNonce.
   */

  updateNonce() {
    if (++this.nonce2 === 0x100000000) {
      this.nonce2 = 0;
      this.nonce1++;
    }
  }

  /**
   * Destroy the job.
   */

  destroy() {
    assert(!this.destroyed, 'Job already destroyed.');
    this.destroyed = true;
  }

  /**
   * Calculate number of hashes computed.
   * @param {Number} nonce
   * @returns {Number}
   */

  getHashes(nonce) {
    const extra = this.nonce1 * 0x100000000 + this.nonce2;
    return extra * 0xffffffff + nonce;
  }

  /**
   * Calculate hashrate.
   * @param {Number} nonce
   * @returns {Number}
   */

  getRate(nonce) {
    const hashes = this.getHashes(nonce);
    const seconds = util.now() - this.start;
    return Math.floor(hashes / Math.max(1, seconds));
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
