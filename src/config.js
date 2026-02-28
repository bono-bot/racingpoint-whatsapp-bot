require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:32776',
    model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
  },
  evolution: {
    url: process.env.EVOLUTION_API_URL || 'http://localhost:53622',
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE || 'Racing Point Reception',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    adminNumbers: (process.env.GOOGLE_ADMIN_NUMBERS || '').split(',').filter(Boolean),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
