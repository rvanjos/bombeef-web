/**
 * public/js/bb-events.js — Barramento de eventos no frontend (F1-01)
 * Bom Beef Sistema de Gestão — AR Boutique de Carnes LTDA
 *
 * Escuta eventos SSE do servidor e os distribui para os iframes
 * via postMessage com tipo padronizado.
 *
 * Carregado pelo index.html após o login.
 * Os iframes que quiserem escutar um evento adicionam:
 *   window.addEventListener('message', e => {
 *     if (e.data?.bbEvent === 'PERDA_REGISTRADA') { ... }
 *   });
 */

(function(w) {
  'use strict';

  // Catálogo de eventos — espelho do lib/events.js
  const BB_EVENTOS = Object.freeze({
    ESTOQUE_ATUALIZADO:     'estoque',
    VENDA_IMPORTADA:        'estoque',
    PERDA_REGISTRADA:       'estoque',
    VALIDADE_DESCARTADA:    'estoque',
    KIT_RESERVADO:          'estoque',
    KIT_CANCELADO:          'estoque',
    RETIRADA_FUNCIONARIO:   'estoque',
    MOVIMENTO_ESTOQUE:      'estoque',
    BOLETO_PAGO:            'boletos',
    FATURAMENTO_ATUALIZADO: 'faturamento',
    DRE_ATUALIZADO:         'dre',
    PRODUTO_ATUALIZADO:     'produtos',
    FORNECEDOR_ATUALIZADO:  'produtos',
    FUNCIONARIO_ATUALIZADO: 'rh',
    HUB_STATUS_ATUALIZADO:  'hub',
  });

  /**
   * Distribui um evento SSE para todos os iframes abertos.
   * @param {object} payload - { type, canal, data, timestamp }
   */
  function distribuirParaIframes(payload) {
    try {
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          iframe.contentWindow?.postMessage({
            bbEvent:   payload.type,
            canal:     payload.canal,
            data:      payload.data,
            timestamp: payload.timestamp,
          }, '*');
        } catch(_) {}
      });
    } catch(_) {}
  }

  // Expõe globalmente para uso pelo index.html
  w.BB_EVENTOS = BB_EVENTOS;
  w.bbDistribuirEvento = distribuirParaIframes;

})(window);
