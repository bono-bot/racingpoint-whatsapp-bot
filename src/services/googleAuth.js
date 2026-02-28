const { getAuthClient } = require('@racingpoint/google');
const config = require('../config');

let auth = null;

function getGoogleAuth() {
  if (!auth) {
    auth = getAuthClient({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      refreshToken: config.google.refreshToken,
    });
  }
  return auth;
}

module.exports = { getGoogleAuth };
