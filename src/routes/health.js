const { Router } = require('express');
const config = require('../config');

const router = Router();

router.get('/health', async (_req, res) => {
  const checks = {
    bot: 'ok',
    claude: config.claude.apiKey ? 'configured' : 'missing_api_key',
  };

  const healthy = checks.bot === 'ok' && checks.claude === 'configured';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    models: {
      customer: config.claude.customerModel,
      admin: config.claude.adminModel,
    },
    uptime: process.uptime(),
  });
});

module.exports = router;
