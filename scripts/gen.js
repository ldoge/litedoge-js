'use strict';

const consensus = require('../lib/protocol/consensus');
const TX = require('../lib/primitives/tx');
const Block = require('../lib/primitives/block');
const Script = require('../lib/script/script');

function createGenesisBlock(options) {
  let flags = options.flags;

  if (!flags) {
    flags = Buffer.from(
      'plz time stamp. stahp',
      'ascii');
  }


  const tx = new TX({
    version: 1,
    time: options.time,
    inputs: [{
      prevout: {
        hash: consensus.ZERO_HASH,
        index: 0xffffffff
      },
      script: new Script()
        .pushInt(0)
        .pushPush(Buffer.from([42]))
        .pushData(flags)
        .compile(),
      sequence: 0xffffffff
    }],
    outputs: [{value: 0n, script: new Script()}],
    locktime: 0
  });

  const block = new Block({
    version: options.version,
    prevBlock: consensus.ZERO_HASH,
    merkleRoot: tx.hash(),
    time: options.time,
    bits: options.bits,
    nonce: options.nonce,
    height: 0,
    vchBlockSig:  consensus.ZERO_HASH,
  });

  block.txs.push(tx);
  return block;
}

//hash: 0000032101032f27e7cdddb1196353f7fc9e1b6294717432135add95534f67c6
//merkleRoot: 6e8089863e3811437cca6029c8eb113e0ddec4cb553e7cfdf8944c964cf86832
//size: 171
const main = createGenesisBlock({
  version: 1,
  time: 1426450258,
  bits: 504365055,
  nonce: 925125
});
//
// const testnet = createGenesisBlock({
//   version: 1,
//   time: 1296688602,
//   bits: 486604799,
//   nonce: 414098458
// });
//
// const regtest = createGenesisBlock({
//   version: 1,
//   time: 1296688602,
//   bits: 545259519,
//   nonce: 2
// });
//
// const btcd = createGenesisBlock({
//   version: 1,
//   time: 1401292357,
//   bits: 545259519,
//   nonce: 2
// });

console.log(main);
console.log('');
// console.log(testnet);
// console.log('');
// console.log(regtest);
// console.log('');
// console.log('');
console.log('main hash: %s', main.rhash());
console.log('main raw: %s', main.toRaw().toString('hex'));
console.log('');
// console.log('testnet hash: %s', testnet.rhash());
// console.log('testnet raw: %s', testnet.toRaw().toString('hex'));
// console.log('');
// console.log('regtest hash: %s', regtest.rhash());
// console.log('regtest raw: %s', regtest.toRaw().toString('hex'));
// console.log('');
// console.log('btcd simnet hash: %s', btcd.rhash());
// console.log('btcd simnet raw: %s', btcd.toRaw().toString('hex'));
