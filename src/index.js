const config = require('./config');
const app = require('./server');
const { close: closeDb } = require('./db/database');
const emailMonitor = require('./services/emailMonitor');
const { startAutoResumeTimer, stopAutoResumeTimer } = require('./services/handoffService');
const logger = require('./utils/logger');

// Fail fast if critical env vars are missing
const requiredEnvVars = ['ANTHROPIC_API_KEY', 'EVOLUTION_API_KEY'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  logger.fatal({ missing }, 'Missing required environment variables — refusing to start');
  process.exit(1);
}

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'RacingPoint WhatsApp Bot started');

  // Start email monitor if Google credentials are configured
  if (config.google.refreshToken) {
    emailMonitor.start();
  }

  // Start auto-resume timer for stale handoffs (checks every 5 min)
  startAutoResumeTimer();
});

// Graceful shutdown
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down...');
  stopAutoResumeTimer();
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
