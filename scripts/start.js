// Inicializador do servidor com extensões opcionais sem alterar server.js.
// Injeta rotas complementares antes dos handlers principais/404.
const express = require('express');
const originalUse = express.application.use;
let boletosIaMounted = false;
let agenteMounted = false;
let dreConferenciaV2Mounted = false;
let drePlanejamentoMounted = false;

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

  // Extensão da Central de Conferência do DRE. É montada no mesmo prefixo,
  // depois do router principal; endpoints não conflitantes seguem normalmente.
  if (!dreConferenciaV2Mounted && args[0] === '/api/dre') {
    dreConferenciaV2Mounted = true;
    try {
      originalUse.call(this, '/api/dre/conferencia-v2', require('../routes/dre_conferencia_v2'));
      console.log('[dre/conferencia-v2] rotas de decisões persistentes registradas');
    } catch (e) {
      console.warn('[dre/conferencia-v2] não foi possível registrar rota:', e.message);
    }
  }

  if (!drePlanejamentoMounted && args[0] === '/api/dre') {
    drePlanejamentoMounted = true;
    try {
      originalUse.call(this, '/api/dre/planejamento', require('../routes/dre_planejamento'));
      console.log('[dre/planejamento] rotas de planejamento anual registradas');
    } catch (e) {
      console.warn('[dre/planejamento] não foi possível registrar rota:', e.message);
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
