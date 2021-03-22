/*!
 * worker.js - worker thread/process for ldogejs
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const Master = require('./master');
const server = new Master();

process.title = 'ldogejs-worker';

server.listen();
