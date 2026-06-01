/**
 * routes/hub.js — Hub Operacional (F1-09)
 * Bom Beef Sistema de Gestão — AR Boutique de Carnes LTDA
 *
 * GET /api/hub/status — status operacional de todos os módulos
 */
'use strict';

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  r.get('/status', async (req, res) => {
    try {
      const agora = new Date();
      const hoje  = agora.toISOString().slice(0,10);
      const ontem = new Date(agora - 86400000).toISOString().slice(0,10);
      const status = {};

      // Estoque — última importação PDV
      const est = await pool.query(`
        SELECT MAX(atualizado_em) AS ultima FROM produtos WHERE estoque > 0
      `).catch(() => ({rows:[{}]}));
      const ultEst = est.rows[0]?.ultima;
      const diasEst = ultEst ? Math.floor((agora - new Date(ultEst)) / 86400000) : 999;
      status.estoque = {
        label: 'Estoque',
        icone: '📦',
        ok: diasEst <= 1,
        alerta: diasEst > 1 && diasEst <= 3,
        critico: diasEst > 3,
        msg: ultEst ? (diasEst === 0 ? 'Atualizado hoje' : `Atualizado há ${diasEst} dia(s)`) : 'Nunca importado',
        ultima_atualizacao: ultEst || null,
        acao: 'sync-estoque',
      };

      // Vendas — último registro de faturamento
      const fat = await pool.query(`
        SELECT MAX(data_fim) AS ultima FROM faturamento_periodos WHERE tipo_periodo='dia'
      `).catch(() => ({rows:[{}]}));
      const ultFat = fat.rows[0]?.ultima;
      const diasFat = ultFat ? Math.floor((agora - new Date(ultFat + 'T23:59:59')) / 86400000) : 999;
      status.vendas = {
        label: 'Vendas',
        icone: '💰',
        ok: diasFat <= 1,
        alerta: diasFat > 1 && diasFat <= 3,
        critico: diasFat > 3,
        msg: ultFat ? (diasFat <= 1 ? 'Importadas hoje/ontem' : `Última importação há ${diasFat} dia(s)`) : 'Nunca importado',
        ultima_atualizacao: ultFat || null,
        acao: 'importar-vendas',
      };

      // Validade — itens vencidos / críticos
      const val = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE data_validade < CURRENT_DATE) AS vencidos,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE + 3) AS criticos,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE + 4 AND CURRENT_DATE + 7) AS alertas
        FROM validade_items WHERE status NOT IN ('descartado','vendido')
      `).catch(() => ({rows:[{vencidos:0,criticos:0,alertas:0}]}));
      const v = val.rows[0];
      const nVenc = parseInt(v.vencidos||0), nCrit = parseInt(v.criticos||0);
      status.validade = {
        label: 'Validade',
        icone: '🗓',
        ok: nVenc === 0 && nCrit === 0,
        alerta: nVenc === 0 && nCrit > 0,
        critico: nVenc > 0,
        msg: nVenc > 0 ? `${nVenc} vencido(s) — retirar imediatamente` :
             nCrit > 0 ? `${nCrit} crítico(s) — vencem em 3 dias` : 'Sem alertas',
        vencidos: nVenc, criticos: nCrit, alertas: parseInt(v.alertas||0),
        acao: 'validade',
      };

      // Boletos — vencidos sem baixa
      const bol = await pool.query(`
        SELECT COUNT(*) AS vencidos, COALESCE(SUM(ABS(valor)),0) AS total
        FROM boletos WHERE status='avencer' AND vencimento < CURRENT_DATE
      `).catch(() => ({rows:[{vencidos:0,total:0}]}));
      const nBol = parseInt(bol.rows[0]?.vencidos||0);
      status.boletos = {
        label: 'Boletos',
        icone: '📄',
        ok: nBol === 0,
        alerta: nBol > 0 && nBol <= 3,
        critico: nBol > 3,
        msg: nBol > 0 ? `${nBol} vencido(s) sem baixa` : 'Em dia',
        vencidos: nBol,
        total_vencido: parseFloat(bol.rows[0]?.total||0),
        acao: 'boletos',
      };

      // Produtos — abaixo do estoque mínimo
      const pMin = await pool.query(`
        SELECT COUNT(*) AS total FROM produtos
        WHERE ativo=true AND estoque_minimo > 0 AND estoque < estoque_minimo
      `).catch(() => ({rows:[{total:0}]}));
      const nMin = parseInt(pMin.rows[0]?.total||0);
      status.estoque_minimo = {
        label: 'Estoque Mínimo',
        icone: '⚠️',
        ok: nMin === 0,
        alerta: nMin > 0 && nMin <= 5,
        critico: nMin > 5,
        msg: nMin > 0 ? `${nMin} produto(s) abaixo do mínimo` : 'Estoque adequado',
        produtos_criticos: nMin,
        acao: 'produtos',
      };

      // Movimentos — atividade recente
      const mov = await pool.query(`
        SELECT COUNT(*) AS total FROM movimentos_estoque
        WHERE data_movimento >= NOW() - INTERVAL '24 hours'
      `).catch(() => ({rows:[{total:0}]}));
      status.movimentos = {
        label: 'Movimentos Hoje',
        icone: '📊',
        ok: true,
        alerta: false,
        critico: false,
        msg: `${parseInt(mov.rows[0]?.total||0)} movimento(s) nas últimas 24h`,
        total_24h: parseInt(mov.rows[0]?.total||0),
      };

      res.json({ ok: true, data: status, gerado_em: agora });
    } catch(e) {
      console.error('[hub/status]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // GET /api/hub/pendencias — lista importações pendentes
  r.get('/pendencias', async (req, res) => {
    try {
      const agora = new Date();
      const pendencias = [];

      const est = await pool.query(`SELECT MAX(atualizado_em) AS u FROM produtos WHERE estoque > 0`).catch(()=>({rows:[{}]}));
      const fat = await pool.query(`SELECT MAX(data_fim) AS u FROM faturamento_periodos WHERE tipo_periodo='dia'`).catch(()=>({rows:[{}]}));

      const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : 'Nunca';
      const dias = d => d ? Math.floor((agora - new Date(d)) / 86400000) : 999;

      pendencias.push({ arquivo:'Relatório 302 — Estoque', origem:'XMenu/ChefWeb', ultima: fmt(est.rows[0]?.u), dias_atraso: dias(est.rows[0]?.u), status: dias(est.rows[0]?.u) <= 1 ? 'ok' : dias(est.rows[0]?.u) <= 3 ? 'alerta' : 'critico' });
      pendencias.push({ arquivo:'Relatório de Vendas', origem:'XMenu/ChefWeb', ultima: fmt(fat.rows[0]?.u), dias_atraso: dias(fat.rows[0]?.u), status: dias(fat.rows[0]?.u) <= 1 ? 'ok' : dias(fat.rows[0]?.u) <= 3 ? 'alerta' : 'critico' });

      res.json({ ok: true, data: pendencias });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
