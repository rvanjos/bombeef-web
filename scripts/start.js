// Inicializador do servidor com extensões opcionais sem alterar server.js.
// Injeta as rotas do Agente Financeiro/Drive logo após /api/dashboard,
// antes de handlers finais/404 que possam existir no servidor principal.
const express = require('express');
const originalUse = express.application.use;
let mounted = false;

express.application.use = function (...args) {
  const result = originalUse.apply(this, args);
  if (!mounted && args[0] === '/api/dashboard') {
    mounted = true;
    try {
      // Parser v2 vem primeiro: trata /interpretar e /importar com leitura por layout visual.
      // Demais endpoints caem normalmente na rota original logo abaixo.
      originalUse.call(this, '/api/agente-financeiro/drive', require('../routes/agente_financeiro_drive_parser_v2'));
      originalUse.call(this, '/api/agente-financeiro/drive', require('../routes/agente_financeiro_drive'));
      console.log('[agente-financeiro/drive] rotas registradas (parser v2 + base)');
    } catch (e) {
      console.warn('[agente-financeiro/drive] não foi possível registrar rota:', e.message);
    }
  }
  return result;
};

require('../server');
