/*!
 * cpuminer.js - inefficient cpu miner for ldogejs (because we can)
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
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
      //todo:: maybe nothing.
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

        this.activeDelay =this.delay(60000);
        await this.activeDelay.promise;
        continue;
      }

      if (this.stopping)
        break;

      if (this.tryToSync) {
        this.tryToSync = false;
        // if (this.peers.length < 3 || pindexBest->GetBlockTime() < GetTime() - 10 * 60)
        if (this.pool.peers.size() < 3) {
          this.activeDelay =this.delay(60000);
          await this.activeDelay.promise;

          continue;
        }
      }

      if (this.stopping)
        break;

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


/*
 * Expose
 */

module.exports = ThreadStaker;
