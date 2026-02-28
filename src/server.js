const express = require('express');
const webhookRouter = require('./routes/webhook');
const healthRouter = require('./routes/health');
const logger = require('./utils/logger');

const app = express();

app.use(express.json({ limit: '1mb' }));

// Routes
app.use(webhookRouter);
app.use(healthRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled express error');
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
