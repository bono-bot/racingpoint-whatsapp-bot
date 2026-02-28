const config = require('./config');
const app = require('./server');
const { close: closeDb } = require('./db/database');
const emailMonitor = require('./services/emailMonitor');
const logger = require('./utils/logger');

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'RacingPoint WhatsApp Bot started');

  // Start email monitor if Google credentials are configured
  if (config.google.refreshToken) {
    emailMonitor.start();
  }
});

// Graceful shutdown
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  emailMonitor.stop();
  server.close(() => {
    closeDb();
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => {
    logger.warn('Forced shutdown');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
