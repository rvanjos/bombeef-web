'use strict';
const jwt = require('jsonwebtoken');

function verificarToken(token, { ignoreExpiration = false } = {}) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration });
  const ids = ['id', 'lojaId', 'vinculoLojaId', 'sessaoId'];
  if (!payload || typeof payload !== 'object' || ids.some(k => !Number.isSafeInteger(Number(payload[k])) || Number(payload[k]) <= 0)
      || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.exp <= payload.iat
      || payload.iat > Math.floor(Date.now() / 1000) + 30) {
    throw new Error('Sessão inválida. Entre novamente.');
  }
  return payload;
}
module.exports = { verificarToken };
