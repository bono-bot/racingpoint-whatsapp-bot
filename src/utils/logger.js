const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.logLevel,
  transport: {
    target: 'pino/file',
    options: { destination: 1 } // stdout
  }
});

module.exports = logger;
