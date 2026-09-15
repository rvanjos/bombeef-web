// Inicializador do servidor com extensões opcionais sem alterar server.js.
// Injeta rotas complementares antes dos handlers principais/404.
const express = require('express');
const originalUse = express.application.use;
let boletosIaMounted = false;
let agenteMounted = false;

express.application.use = function (...args) {
  const result = originalUse.apply(this, args);

  // server.js registra /auth imediatamente antes de /api/boletos.
  // Montamos aqui a sobrescrita dos dois endpoints PDF para que o fluxo ativo use OpenAI.
  if (!boletosIaMounted && args[0] === '/auth') {
    boletosIaMounted = true;
    try {
      originalUse.call(this, '/api/boletos', require('../routes/boletos_ai_openai'));
      console.log('[boletos/ia] rotas PDF registradas com provedor OpenAI');
    } catch (e) {
      console.warn('[boletos/ia] não foi possível registrar rota OpenAI:', e.message);
    }
  }

  // O Agente Financeiro é montado após /api/dashboard, antes dos handlers finais/404.
  // v3 assume interpretar/importar. v2 e base ficam como fallback/status/listagem.
  if (!agenteMounted && args[0] === '/api/dashboard') {
    agenteMounted = true;
    try {
      originalUse.call(this, '/api/agente-financeiro/drive', require('../routes/agente_financeiro_cartao_v3'));
      originalUse.call(this, '/api/agente-financeiro/drive', require('../routes/agente_financeiro_drive_parser_v2'));
      originalUse.call(this, '/api/agente-financeiro/drive', require('../routes/agente_financeiro_drive'));
      console.log('[agente-financeiro/drive] rotas registradas (cartão v3 + parser v2 + base)');
    } catch (e) {
      console.warn('[agente-financeiro/drive] não foi possível registrar rota:', e.message);
    }
  }
  return result;
};

require('../server');
