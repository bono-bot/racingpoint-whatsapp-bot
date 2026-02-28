const logger = require('./logger');

// Per-user message queue to serialize processing
const queues = new Map();

async function enqueue(userId, fn) {
  if (!queues.has(userId)) {
    queues.set(userId, Promise.resolve());
  }

  const prev = queues.get(userId);
  const next = prev.then(() => fn()).catch(err => {
    logger.error({ err, userId }, 'Queue task failed');
  });

  queues.set(userId, next);

  // Clean up idle queues after 5 minutes
  next.then(() => {
    setTimeout(() => {
      if (queues.get(userId) === next) {
        queues.delete(userId);
      }
    }, 5 * 60 * 1000);
  });

  return next;
}

module.exports = { enqueue };
