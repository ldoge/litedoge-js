const assert = require('bsert');
const path = require('path');
const Logger = require('blgr');
const Network = require('../protocol/network');
const common = require('../blockchain/common');
const consensus = require('../protocol/consensus');
const {BN} = require('bcrypto/lib/bcrypto')
const ChainEntry = require('../blockchain/chainentry');
const hash256 = require('bcrypto/lib/hash256');
const bio = require("bufio")
const {VerifyError} = require('../protocol/errors');
const ZERO = new BN(0);

class Kernel {

  constructor(options) {
    this.options = options;
    this.network = this.options.network;
    this.pos = this.network.pos;
    this.logger = this.options.logger.context('kernel');
    this.node = this.options.node;
  }

  /**
   * Get last stake modifier chain entry
   * @param {ChainEntry}  entry
   * @returns {Promise<ChainEntry>}
   */
  async getLastStakeModifierEntry(entry) {
    const chain = this.node.chain;
    assert(entry);
    while (entry && !consensus.ZERO_HASH.equals(entry.prevBlock) && !entry.generatedStakeModifier()) {
      entry = chain.getPrevCache(entry) || await chain.getPrevious(entry);
    }
    assert(entry);
    if (!entry.generatedStakeModifier()) {
      throw new Error("getLastStakeModifierEntry: no generation at genesis block.")
    }
    return entry;
  }

  /**
   * @param {ChainEntry} prev
   * @returns {{stakeModifier:BN, generated: boolean}}
   */
  async computeNextStakeModifier(prev) {
    const chain = this.node.chain;
    if (!prev) {
      return {stakeModifier: ZERO, generated: true};
    }
    // First find current stake modifier and its generation block time
    // if it's not old enough, return the same stake modifier
    let lastModifierEntry = await this.getLastStakeModifierEntry(prev);
    assert(lastModifierEntry);

    const logger = this.logger.context("stakemodifier");
    logger.spam("computeNextStakeModifier: prev modifier=%h time=%d", lastModifierEntry.stakeModifier, lastModifierEntry.time);
    if (Math.floor(lastModifierEntry.time / this.pos.modifierInterval) >= Math.floor(prev.time / this.pos.modifierInterval)) {
      return {stakeModifier: lastModifierEntry.stakeModifier, generated: false}
    }

    // const candidateBlocksLength = 64 * this.pos.modifierInterval / this.network.getTargetSpacing(prev.height);
    // Sort candidate blocks by timestamp
    let selectionInterval = this.network.getStakeModifierSelectionInterval();
    let selectionIntervalStart = Math.floor(prev.time / this.pos.modifierInterval) * this.pos.modifierInterval - selectionInterval;

    const blockCandidates = [];
    let entry = prev;
    while (entry && entry.time >= selectionIntervalStart) {
      blockCandidates.push({time: entry.time, entry: entry});
      entry = chain.getPrevCache(entry) || await chain.getPrevious(entry);
    }
    const sortedBlockCandidates = blockCandidates.sort(function (x, y) {
      return x.time - y.time;
    })
    // Select 64 blocks from candidate blocks to generate stake modifier
    let selectionIntervalStop = selectionIntervalStart;

    const selectedBlocks = new Map();
    let modifier = ZERO;
    for (let round = 0; round < Math.min(64, sortedBlockCandidates.length); round++) {
      // add an interval section to the current selection round
      selectionIntervalStop += this.network.getStakeModifierSelectionIntervalSection(round);
      // select a block from the candidates of current round
      const selectedBlock = await this.selectBlockFromCandidates(sortedBlockCandidates, selectedBlocks, selectionIntervalStop, lastModifierEntry.stakeModifier);
      selectedBlocks.set(selectedBlock.hash.toString(), selectedBlock);

      if (!selectedBlock)
        throw new Error("ComputeNextStakeModifier: unable to select block at round " + round);

      this.logger.context("stakemodifier")
        .spam("ComputeNextStakeModifier: selected round %d stop=%s height=%d bit=%d", round, selectionIntervalStop, selectedBlock.height, selectedBlock.getStakeEntropyBit());

      const entropyBit = selectedBlock.getStakeEntropyBit();
      modifier = modifier.uor(new BN(entropyBit).ushln(round));

    }

    return {stakeModifier: modifier, generated: true};
  }


  /**
   *
   * @param {Map<Number, ChainEntry>} sortedBlockCandidates
   * @param selectedBlocks
   * @param selectionIntervalStop
   * @param {BN} prevStakeModifier
   * @returns {Promise<ChainEntry>}
   */
  async selectBlockFromCandidates(sortedBlockCandidates, selectedBlocks, selectionIntervalStop, prevStakeModifier) {
    let selected = false;
    let hashBest = consensus.ZERO_HASH;
    let entrySelected;
    for (const {time, entry} of sortedBlockCandidates) {

      if (selected && time > selectionIntervalStop)
        break;

      if (selectedBlocks.has(entry.hash.toString()))
        continue;

      let selectionHash = entry.getSelectionHash(prevStakeModifier);

      if (selected && rcmp(selectionHash, hashBest) < 0) {
        hashBest = selectionHash;
        entrySelected = entry;
      } else if (!selected) {
        selected = true;
        hashBest = selectionHash;
        entrySelected = entry;
      }
    }
    this.logger.context("stakemodifier").spam("SelectBlockFromCandidates: selectionHash=%h", hashBest)
    return entrySelected;
  }

  /**
   *
   * @param prev {module.blockchain.ChainEntry}
   * @param {module:primitives.TX} coinstakeTx
   * @param bits {number}
   * @returns {Promise<{proofHash: Buffer, targetProofOfStake: Buffer}>}
   */
  async checkProofOfStake(prev, coinstakeTx, bits) {
    const chain = this.node.chain;
    if (!coinstakeTx.isCoinstake())
      throw new VerifyError(coinstakeTx, 'proofOfStake', 'called on non-coinstake', 0);


    // Kernel (input 0) must match the stake hash target per coin age (nBits)
    const input = coinstakeTx.inputs[0];

    //txPrev without inputs/outputs
    //First try finding the previous transaction in database
    const coin = await chain.getCoin(input.prevout.hash, input.prevout.index);
    if (!coin) {
      throw new VerifyError(coinstakeTx, 'proofOfStake', 'coin not found', 1);
    }

    const coinStakeEntry = await chain.getEntryByHeight(coin.height);
    if (!coinStakeEntry) {
      throw new VerifyError(coinStakeEntry, 'proofOfStake', 'coinstake input entry not found.', 1)
    }
    const coinStakeInputBlock = await chain.getBlock(coinStakeEntry.hash);


    // coinStakeInputBlock.txs
    //verify signature coin
    try {
      coinstakeTx.checkInput(0, coin, common.flags.VERIFY_NONE);
    } catch (e) {
      throw new VerifyError(coinstakeTx, 'proofOfStake', 'verify signature failed on coinstake  ' + coin.rhash(), 100);
    }

    const inputTransaction = coinStakeInputBlock.txs[coinStakeInputBlock.indexOf(coin.hash)];
    try {
      //Check stake kernel hash
      return this.checkStakeKernelHash(prev, bits, coinStakeInputBlock, inputTransaction, input.prevout, coinstakeTx.time);
    } catch (e) {
      // may occur during initial download or if behind on block chain sync
      throw new VerifyError(coinstakeTx, 'proofOfStake', 'stake kernel check failed', 1)
    }

  }

  /**

   * @param {ChainEntry} prev
   * @param {number} bits
   * @param {number} time
   * @param {AbstractBlock|ChainEntry} blockFrom
   * @param {Outpoint|Coin} prevout
   * @param {TX} txPrev
   * @returns {{proofHash: Buffer, targetProofOfStake: Buffer}}
   */
  // prev, bits, coinStakeInputBlock, inputTransaction, input prevout,coinstakeTx.time,  coin);
  checkStakeKernelHash(prev, bits, blockFrom, txPrev, prevout, time) {
    return this.network.isProtocolV1(prev.height) ?
      this.checkStakeKernelHashV1(prev, bits, time, txPrev, prevout) :
      this.checkStakeKernelHashV2(prev, bits, blockFrom.time, txPrev, prevout, time);
  }

  /**
   *
   * @param hashBlockFrom
   * @returns {{stakeModifier:BN, height: number, time: number }}
   */
  async getKernelStakeModifier(hashBlockFrom) {
    const chain = this.node.chain;
    const entryFrom = await chain.getEntryByHash(hashBlockFrom);
    if (!entryFrom)
      throw new Error("GetKernelStakeModifier() : block not indexed");

    let height = entryFrom.height;
    let time = entryFrom.time;
    let stakeModifierSelectionInterval = this.network.pos.getStakeModifierSelectionInterval();

    let entry = entryFrom;
    // loop to find the stake modifier later by a selection interval
    while (time < entry.time + stakeModifierSelectionInterval) {
      if (entry.height === chain.tip.height) {
        return null; // reached best block; may happen if node is behind on block chain
      }
      entry = await chain.getNext(entry);
      if (entry.generatedStakeModifier()) {
        height = entry.height;
        time = entry.time;
      }
    }
    return {stakeModifier: entry.stakeModifier, height: height, time: time};
  }

  /**
   *
   * @param prev
   * @param bits
   * @param time
   * @param txPrev
   * @param coin
   * @returns {{proofHash: Buffer, targetProofOfStake: Buffer}|null}
   */
  checkStakeKernelHashV1(prev, bits, time, txPrev, coin) {
    const chain = this.node.chain;
    if (time < txPrev.time)  // Transaction timestamp violation
      throw new Error("checkStakeKernelHash(): nTime violation")

    if (prev.time + this.pos.stakeMinAge > time)
      throw new Error("checkStakeKernelHash(): min age violation")

    const targetCoinPerDay = consensus.fromCompact(bits);
    const valueIn = txPrev.outputs[coin.index].value;

    const hashBlockFrom = prev.hash;

    const coinDayWeight = new BN(valueIn)
      .mul(this.getStakeWeight(txPrev.time, time))
      .div(new BN(consensus.COIN.toString()))
      .div(new BN(24 * 60 * 60));

    const weightedTarget = (coinDayWeight.mul(targetCoinPerDay))

    const {stakeModifier} = this.getKernelStakeModifier(hashBlockFrom);
    if (!stakeModifier)
      return null;

    const hashProofOfStake = this.getProofOfStakeHashV1(stakeModifier, prev.time, txPrev, coin, time);

    // Now check if proof-of-stake hash meets target protocol
    if (BN.fromBuffer(hashProofOfStake, 'le').gt(weightedTarget))
      return null;

    const targetProofOfStake = weightedTarget.toArrayLike(Buffer, 'le', 32);

    return {proofHash: hashProofOfStake, targetProofOfStake: targetProofOfStake};
  }

  /**
   *    * LiteDoge kernel protocol
   * coinstake must meet hash target according to the protocol:
   * kernel (input 0) must meet the formula
   *     hash(nStakeModifier + txPrev.block.nTime + txPrev.nTime + txPrev.vout.hash + txPrev.vout.n + nTime) < bnTarget * nWeight
   * this ensures that the chance of getting a coinstake is proportional to the
   * amount of coins one owns.
   * The reason this hash is chosen is the following:
   *   nStakeModifier: scrambles computation to make it very difficult to precompute
   *                   future proof-of-stake
   *   txPrev.block.nTime: prevent nodes from guessing a good timestamp to
   *                       generate transaction for future advantage
   *   txPrev.nTime: slightly scrambles computation
   *   txPrev.vout.hash: hash of txPrev, to reduce the chance of nodes
   *                     generating coinstake at the same time
   *   txPrev.vout.n: output number of txPrev, to reduce the chance of nodes
   *                  generating coinstake at the same time
   *   nTime: current timestamp
   *   block/tx hash should not be used here as they can be generated in vast
   *   quantities so as to generate blocks faster, degrading the system back into
   *   a proof-of-work situation.
   * @param {ChainEntry} prev
   * @param {*} bits
   * @param {number} blockFromTime
   * @param {number} time
   * @param {TX} txPrev
   * @param {Outpoint|Coin} prevout
   */
  checkStakeKernelHashV2(prev, bits, blockFromTime, txPrev, prevout, time) {
    if (time < txPrev.time)
      throw new Error("checkStakeKernelHash(): nTime violation")

    if (blockFromTime + this.pos.stakeMinAge > time)
      throw new Error("checkStakeKernelHash(): min age violation")

    // Base target
    const target = consensus.fromCompact(bits);
    const valueIn = txPrev.outputs[prevout.index].value
    // weighted target;
    const weightedTarget = target.mul(new BN(valueIn));

    const stakeModifier = prev.stakeModifier;
    const hashProofOfStake = this.getProofOfStakeHashV2(stakeModifier, blockFromTime, txPrev.time, prevout, time);

    if (BN.fromBuffer(hashProofOfStake, 'le').gt(weightedTarget)) {
      return null;
    }

    const targetProofOfStake = weightedTarget.toString('hex')
    return {proofHash: hashProofOfStake, targetProofOfStake: targetProofOfStake}
  }


  /**
   *
   * @param {BN} modifier
   * @param {Number} blockFromTime
   * @param {Number} coinTxTime
   * @param {Coin|Outpoint} coin
   * @param {Number} time for new proof of stake transaction
   */
  getProofOfStakeHashV2(modifier, blockFromTime, coinTxTime, coin, time) {
    const bw = bio.write(56);
    bw.writeU64BI(modifier.toBigInt());
    bw.writeU32(blockFromTime);
    bw.writeU32(coinTxTime);
    bw.writeHash(coin.hash);
    bw.writeU32(coin.index);
    bw.writeU32(time);
    return hash256.digest(bw.render());
  }

  /**
   *
   * @param {BN} modifier
   * @param {Number} blockFromTime
   * @param {primitives.TX} txPrev
   * @param {Coin} coin
   * @param {Number} time for new proof of stake transaction
   */
  getProofOfStakeHashV1(modifier, blockFromTime, txPrev, coin, time) {
    const position = txPrev.getPosition();
    const bw = bio.write(56);
    bw.writeBytes(modifier.toArrayLike(Buffer, 'le', 16));
    bw.writeU32(blockFromTime);
    bw.writeU32(position.offset); //ntxPrevOffset
    bw.writeU32(coin.index);
    bw.writeU32(time);
    return hash256.digest(bw.render());
  }

  /**
   *
   * @param intervalEnd
   * @param intervalBeginning
   */
  getStakeWeight(intervalEnd, intervalBeginning) {
    return intervalEnd - intervalBeginning - this.network.pos.stakeMinAge;
  }
}

/**
 * "Reverse" comparison so we don't have
 * to waste time reversing the block hash.
 * @ignore
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Number}
 */

function rcmp(a, b) {
  assert(a.length === b.length);

  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] < b[i])
      return -1;
    if (a[i] > b[i])
      return 1;
  }

  return 0;
}

/*
 * Expose
 */

module.exports = Kernel;
