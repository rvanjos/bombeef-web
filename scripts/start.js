// Inicializador do servidor com extensões opcionais sem alterar server.js.
// Injeta a rota do Agente Financeiro/Drive logo após /api/dashboard,
// antes de handlers finais/404 que possam existir no servidor principal.
const express = require('express');
const originalUse = express.application.use;
let mounted = false;

express.application.use = function (...args) {
  const result = originalUse.apply(this, args);
  if (!mounted && args[0] === '/api/dashboard') {
    mounted = true;
    try {
      originalUse.call(this, '/api/agente-financeiro/drive', require('../routes/agente_financeiro_drive'));
      console.log('[agente-financeiro/drive] rota registrada');
    } catch (e) {
      console.warn('[agente-financeiro/drive] não foi possível registrar rota:', e.message);
    }
  }
  return result;
};

require('../server');
