

const assert = require('bsert');
const EventEmitter = require('events');
const ThreadStaker = require('./threadstaker');

/**
 * Staking Kernel
 * A miner that
 * @Property {Wallet} wallet
 */
class StakingKernel extends EventEmitter {


  constructor(options) {
    super();
    this.options = options;
    this.staking = options.staking;
    this.opened = false;
    this.network = this.options.network;
    this.logger = this.options.logger.context('staking');
    this.workers = this.options.workers;
    this.chain = this.options.chain;
    this.pool = this.options.pool;
    this.threadStaker = new ThreadStaker(this);
    this.wallet = null;

    this.init();
  }

  /**
   * Initialize the staking kernel.
   */

  init() {
    this.threadStaker.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Open the staking kernel, wait for the chain and mempool to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'StakingKernel is already open.');
    this.opened = true;

    await this.threadStaker.open();

    // this.logger.info('StakingKernel loaded (flags=%s).',
      // this.options.coinbaseFlags.toString('utf8'));


    // if (this.addresses.length === 0)
    //   this.logger.warning('No reward address is set for miner!');
  }


  /**
   * Close the miner.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'StakingKernel is not open.');
    this.opened = false;
    return this.threadStaker.close();
  }
}

/*
 * Expose
 */

module.exports = StakingKernel;
