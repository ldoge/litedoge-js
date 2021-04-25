const assert = require('bsert');
const EventEmitter = require('events');
const ThreadStaker = require('./threadstaker');
const BlockTemplate = require('../mining/template');
const Amount = require('../btc/amount')
const consensus = require('../protocol/consensus')
require('bcrypto/lib/hash256');

/**
 * Staker
 * A miner that
 * @Property {Wallet} wallet
 */
class Staker extends EventEmitter {

  /**
   *  To decrease granularity of timestamp
   *  Supposed to be 2^n-1
   * @type {number}
   */
  STAKE_TIMESTAMP_MASK = 15;


  /**
   *
   * @param options
   */
  constructor(options) {
    super();
    this.options = options;
    this.staking = options.staking;
    this.opened = false;
    this.network = this.options.network;
    this.logger = this.options.logger.context('staking');
    this.workers = this.options.workers;
    this.chain = this.options.chain;
    this.locker = this.chain.locker;
    this.pool = this.options.pool;
    this.threadStaker = new ThreadStaker(this);
    this.wallet = null;
    this.pos = this.network.pos;

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
    assert(!this.opened, 'Staker is already open.');
    this.opened = true;

    await this.threadStaker.open();

    // this.logger.info('Staker loaded (flags=%s).',
    // this.options.coinbaseFlags.toString('utf8'));


    // if (this.addresses.length === 0)
    //   this.logger.warning('No reward address is set for miner!');
  }


  /**
   * Close the miner.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'Staker is not open.');
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
    let version = this.options.version || -1;

    if (!tip)
      tip = this.chain.tip;

    if (!address)
      address = this.getAddress();

    if (version === -1)
      version = await this.chain.computeBlockVersion(tip);

    const mtp = await this.chain.getMedianTime(tip);
    const time = Math.max(this.network.now(), mtp + 1);

    const state = await this.chain.getDeployments(time, tip);

    const target = await this.chain.getTarget(time, tip, true);

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
      sigops: this.options.reservedSigops,
      pos: true
    });

    this.assemble(attempt);
    this.logger.debug(
      'Created block tmpl (height=%d, weight=%d, fees=%d, txs=%s, diff=%d).',
      attempt.height,
      attempt.weight,
      Amount.btc(attempt.fees),
      attempt.items.length + 1,
      attempt.getDifficulty());

    // if (this.options.preverify) {
    // TODO:: fix this because i think it would be nice.
    // const block = attempt.toBlock();
    // try {
    //   await this.chain._verifyBlock(block);
    // } catch (e) {
    //   if (e.type === 'VerifyError') {
    //     this.logger.warning('Miner created invalid block!');
    //     this.logger.error(e);
    //     throw new Error('BUG: Miner created invalid block.');
    //   }
    //   throw e;
    // }
    //
    // this.logger.debug(
    //   'Preverified block %d successfully!',
    //   attempt.height);
    //}

    return attempt;
  }

  /**
   * Get mempool entries, sort by dependency order.
   * Prioritize by priority and fee rates.
   * @param {BlockTemplate} attempt
   * @returns {MempoolEntry[]}
   */

  assemble(attempt) {
    if (!this.mempool) {
      attempt.refresh();
      return;
    }

    assert(this.mempool.tip.equals(this.chain.tip.hash),
      'Mempool/chain tip mismatch! Unsafe to create block.');

    const depMap = new BufferMap();
    const queue = new Heap(cmpRate);

    let priority = this.options.priorityWeight > 0;

    if (priority)
      queue.set(cmpPriority);

    for (const entry of this.mempool.map.values()) {
      const item = BlockEntry.fromEntry(entry, attempt);
      const tx = item.tx;

      if (tx.isCoinbase())
        throw new Error('Cannot add coinbase to block.');

      if (tx.isCoinstake())
        throw new Error('Cannot add coinstake to block.');

      for (const {prevout} of tx.inputs) {
        const hash = prevout.hash;

        if (!this.mempool.hasEntry(hash))
          continue;

        item.depCount += 1;

        if (!depMap.has(hash))
          depMap.set(hash, []);

        depMap.get(hash).push(item);
      }

      if (item.depCount > 0)
        continue;

      queue.insert(item);
    }

    while (queue.size() > 0) {
      const item = queue.shift();
      const tx = item.tx;
      const hash = item.hash;

      let weight = attempt.weight;
      let sigops = attempt.sigops;

      if (!tx.isFinal(attempt.height, attempt.locktime))
        continue;

      weight += tx.getWeight();

      if (weight > this.options.maxWeight)
        continue;

      sigops += item.sigops;

      if (sigops > this.options.maxSigops)
        continue;

      if (priority) {
        if (weight > this.options.priorityWeight
          || item.priority < this.options.priorityThreshold) {
          priority = false;
          queue.set(cmpRate);
          queue.init();
          queue.insert(item);
          continue;
        }
      } else {
        if (item.free && weight >= this.options.minWeight)
          continue;
      }

      attempt.weight = weight;
      attempt.sigops = sigops;
      attempt.fees += item.fee;
      attempt.items.push(item);

      const deps = depMap.get(hash);

      if (!deps)
        continue;

      for (const item of deps) {
        if (--item.depCount === 0)
          queue.insert(item);
      }
    }

    attempt.refresh();

    assert(attempt.weight <= consensus.MAX_BLOCK_WEIGHT,
      'Block exceeds reserved weight!');

    if (this.options.preverify) {
      const block = attempt.toBlock();

      assert(block.getWeight() <= attempt.weight,
        'Block exceeds reserved weight!');

      assert(block.getBaseSize() <= consensus.MAX_BLOCK_SIZE,
        'Block exceeds max block size.');
    }
  }


}

/*
 * Expose
 */

module.exports = Staker;
