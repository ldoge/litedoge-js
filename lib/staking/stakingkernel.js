

const assert = require('bsert');
const EventEmitter = require('events');
const ThreadStaker = require('./threadstaker');
const BlockTemplate = require('./template');
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

  /**
   * Create a block template.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns {@link BlockTemplate}.
   */

  async createBlock(tip, address) {
    const unlock = await this.locker.lock();
    try {
      return await this._createBlock(tip, address);
    } finally {
      unlock();
    }
  }

  /**
   * Create a block template (without a lock).
   * @method
   * @private
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns {@link BlockTemplate}.
   */

  async _createBlock(tip, address) {
    let version = this.options.version;

    if (!tip)
      tip = this.chain.tip;

    if (!address)
      address = this.getAddress();

    if (version === -1)
      version = await this.chain.computeBlockVersion(tip);

    const mtp = await this.chain.getMedianTime(tip);
    const time = Math.max(this.network.now(), mtp + 1);

    const state = await this.chain.getDeployments(time, tip);
    //TODO:: correct this get Target
    const target = await this.chain.getTarget(tip, true);

    const locktime = state.hasMTP() ? mtp : time;

    const attempt = new BlockTemplate({
      prevBlock: tip.hash,
      height: tip.height + 1,
      version: version,
      time: time,
      bits: target,
      locktime: locktime,
      mtp: mtp,
      flags: state.flags,
      address: address,
      coinbaseFlags: this.options.coinbaseFlags,
      interval: this.network.halvingInterval,
      weight: this.options.reservedWeight,
      sigops: this.options.reservedSigops
    });

    this.assemble(attempt);

    this.logger.debug(
      'Created block tmpl (height=%d, weight=%d, fees=%d, txs=%s, diff=%d).',
      attempt.height,
      attempt.weight,
      Amount.btc(attempt.fees),
      attempt.items.length + 1,
      attempt.getDifficulty());

    if (this.options.preverify) {
      const block = attempt.toBlock();

      try {
        await this.chain._verifyBlock(block);
      } catch (e) {
        if (e.type === 'VerifyError') {
          this.logger.warning('Miner created invalid block!');
          this.logger.error(e);
          throw new Error('BUG: Miner created invalid block.');
        }
        throw e;
      }

      this.logger.debug(
        'Preverified block %d successfully!',
        attempt.height);
    }

    return attempt;
  }
}

/*
 * Expose
 */

module.exports = StakingKernel;
