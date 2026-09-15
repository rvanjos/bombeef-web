// Inicializador do servidor com extensões opcionais sem alterar server.js.
// Injeta rotas complementares antes dos handlers principais/404.
const express = require('express');
const originalUse = express.application.use;
let mounted = false;

express.application.use = function (...args) {
  const result = originalUse.apply(this, args);
  if (!mounted && args[0] === '/api/dashboard') {
    mounted = true;

    // Sobrescreve apenas os endpoints de leitura PDF de Boletos/NF-e.
    // Fica antes da rota antiga de boletos; assim o fluxo ativo usa OpenAI e nunca Anthropic.
    try {
      originalUse.call(this, '/api/boletos', require('../routes/boletos_ai_openai'));
      console.log('[boletos/ia] rotas PDF registradas com provedor OpenAI');
    } catch (e) {
      console.warn('[boletos/ia] não foi possível registrar rota OpenAI:', e.message);
    }

    try {
      // Parser v2 vem primeiro: trata /interpretar e /importar.
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
