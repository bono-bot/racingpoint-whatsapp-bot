require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  claude: {
    customerModel: process.env.CLAUDE_MODEL_CUSTOMER || 'haiku',
    adminModel: process.env.CLAUDE_MODEL_ADMIN || 'sonnet',
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
  racecontrol: {
    apiUrl: process.env.RC_API_URL || 'https://app.racingpoint.cloud/api/v1',
    terminalSecret: process.env.RC_TERMINAL_SECRET,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
