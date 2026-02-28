const { Router } = require('express');
const config = require('../config');

const router = Router();

router.get('/health', async (_req, res) => {
  const checks = { bot: 'ok', ollama: 'unknown' };

  try {
    const resp = await fetch(`${config.ollama.url}/api/tags`);
    if (resp.ok) {
      const data = await resp.json();
      const hasModel = data.models?.some(m => m.name === config.ollama.model);
      checks.ollama = hasModel ? 'ok' : 'model_missing';
    } else {
      checks.ollama = 'error';
    }
  } catch {
    checks.ollama = 'unreachable';
  }

  const healthy = checks.bot === 'ok' && checks.ollama === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    uptime: process.uptime(),
  });
});

module.exports = router;
