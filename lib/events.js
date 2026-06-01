/**
 * lib/events.js — Barramento interno de eventos (F1-01)
 * Bom Beef Sistema de Gestão — AR Boutique de Carnes LTDA
 *
 * Centraliza a publicação de eventos via SSE.
 * Substitui as 5 definições locais de publish() espalhadas pelas rotas.
 * NÃO altera a infraestrutura SSE existente no server.js — apenas a encapsula.
 *
 * Uso:
 *   const events = require('../lib/events');
 *   events.emit(app, 'PERDA_REGISTRADA', { produto_id: 1, quantidade: 2 });
 */

'use strict';

// Mapeamento evento → canal SSE
// Cada canal agrupa eventos relacionados — o frontend escuta por canal
const CANAL_MAP = {
  // Estoque
  ESTOQUE_ATUALIZADO:       'estoque',
  VENDA_IMPORTADA:          'estoque',
  PERDA_REGISTRADA:         'estoque',
  VALIDADE_DESCARTADA:      'estoque',
  KIT_RESERVADO:            'estoque',
  KIT_CANCELADO:            'estoque',
  RETIRADA_FUNCIONARIO:     'estoque',
  MOVIMENTO_ESTOQUE:        'estoque',
  // Financeiro
  BOLETO_PAGO:              'boletos',
  FATURAMENTO_ATUALIZADO:   'faturamento',
  DRE_ATUALIZADO:           'dre',
  // Cadastros
  PRODUTO_ATUALIZADO:       'produtos',
  FORNECEDOR_ATUALIZADO:    'produtos',
  FUNCIONARIO_ATUALIZADO:   'rh',
  // Hub
  HUB_STATUS_ATUALIZADO:    'hub',
};

/**
 * Emite um evento no barramento SSE.
 * @param {object} app - Express app (para acessar app.locals.ssePublish)
 * @param {string} evento - Nome do evento (ver CANAL_MAP acima)
 * @param {object} dados - Dados do evento (qualquer objeto serializável)
 */
function emit(app, evento, dados = {}) {
  try {
    const canal = CANAL_MAP[evento] || 'geral';
    const payload = {
      type:      evento,
      canal,
      data:      dados,
      timestamp: Date.now(),
    };
    if (typeof app?.locals?.ssePublish === 'function') {
      app.locals.ssePublish(canal, payload);
    }
  } catch (e) {
    // Nunca lança exceção — barramento não pode quebrar o fluxo de negócio
    console.warn('[events] emit falhou silenciosamente:', evento, e.message);
  }
}

/**
 * Cria um emitter vinculado a um app Express específico.
 * Útil para injetar nas rotas sem precisar passar app a cada chamada.
 * @param {object} app - Express app
 */
function createEmitter(app) {
  return {
    emit: (evento, dados) => emit(app, evento, dados),
    EVENTOS: Object.freeze({ ...CANAL_MAP }),
  };
}

module.exports = { emit, createEmitter, CANAL_MAP };
