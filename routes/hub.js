/**
 * routes/hub.js — Hub Operacional (F1-09 revisado)
 * GET /api/hub/resumo — tudo que o gestor precisa em uma chamada
 */
'use strict';

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  r.get('/resumo', async (req, res) => {
    try {
      const agora = new Date();
      const hoje  = agora.toISOString().slice(0,10);
      const mesAtual = `${String(agora.getMonth()+1).padStart(2,'0')}/${agora.getFullYear()}`;

      const q = sql => pool.query(sql).catch(() => ({ rows: [] }));

      const [
        estoque, vendas, validade, boletos, pMin,
        mov24h, perdas, retiradas, dreRes,
        boletoProx, valorAberto, dre_pend
      ] = await Promise.all([
        // Estoque — última atualização
        q(`SELECT MAX(atualizado_em) AS u FROM produtos WHERE estoque > 0`),
        // Vendas — último registro diário
        q(`SELECT MAX(data_fim) AS u, COALESCE(SUM(fat_bruto),0) AS fat_hoje
           FROM faturamento_periodos WHERE tipo_periodo='dia' AND data_inicio >= CURRENT_DATE`),
        // Validade
        q(`SELECT
            COUNT(*) FILTER (WHERE data_validade < CURRENT_DATE) AS vencidos,
            COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE+3) AS criticos,
            COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE+4 AND CURRENT_DATE+7) AS alertas
           FROM validade_items WHERE status NOT IN ('descartado','vendido')`),
        // Boletos vencidos
        q(`SELECT COUNT(*) AS n, COALESCE(SUM(ABS(valor)),0) AS total
           FROM boletos WHERE status='avencer' AND vencimento < CURRENT_DATE`),
        // Produtos abaixo do mínimo
        q(`SELECT COUNT(*) AS n FROM produtos WHERE ativo=true AND estoque_minimo>0 AND estoque<estoque_minimo`),
        // Movimentos 24h
        q(`SELECT COUNT(*) AS n FROM movimentos_estoque WHERE data_movimento >= NOW()-INTERVAL '24 hours'`),
        // Perdas do mês
        q(`SELECT COALESCE(SUM(valor_perda),0) AS total, COUNT(*) AS n FROM perdas WHERE mes=$1`),
        // Retiradas do mês
        q(`SELECT COALESCE(SUM(valor_total),0) AS total, COUNT(*) AS n FROM retiradas WHERE mes=$1`),
        // DRE resultado mês
        q(`SELECT
            COALESCE(SUM(valor) FILTER (WHERE tipo_lancamento IN ('RECEITA','RECEITA_EXTRA')),0) AS receitas,
            COALESCE(SUM(ABS(valor)) FILTER (WHERE tipo_lancamento NOT IN ('RECEITA','RECEITA_EXTRA')),0) AS despesas
           FROM dre_lancamentos dl JOIN dre_sessoes ds ON ds.id=dl.sessao_id WHERE ds.mes_ref=$1`),
        // Boletos próximos 7 dias
        q(`SELECT COUNT(*) AS n, COALESCE(SUM(ABS(valor)),0) AS total
           FROM boletos WHERE status='avencer' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7`),
        // Total aberto em boletos
        q(`SELECT COALESCE(SUM(ABS(valor)),0) AS total FROM boletos WHERE status='avencer'`),
        // DRE lançamentos sem categoria
        q(`SELECT COUNT(*) AS n FROM dre_lancamentos WHERE (categoria IS NULL OR categoria='') AND mes=$1`),
      ].map((p,i) => i>=6 ? p : p) // já são promises
       .map((p,i) => {
         // Adicionar parâmetros onde necessário
         if (i === 6) return pool.query(`SELECT COALESCE(SUM(valor_perda),0) AS total, COUNT(*) AS n FROM perdas WHERE mes=$1`, [mesAtual]).catch(()=>({rows:[{total:0,n:0}]}));
         if (i === 7) return pool.query(`SELECT COALESCE(SUM(valor_total),0) AS total, COUNT(*) AS n FROM retiradas WHERE mes=$1`, [mesAtual]).catch(()=>({rows:[{total:0,n:0}]}));
         if (i === 8) return pool.query(`SELECT COALESCE(SUM(valor) FILTER (WHERE tipo_lancamento IN ('RECEITA','RECEITA_EXTRA')),0) AS receitas, COALESCE(SUM(ABS(valor)) FILTER (WHERE tipo_lancamento NOT IN ('RECEITA','RECEITA_EXTRA')),0) AS despesas FROM dre_lancamentos dl JOIN dre_sessoes ds ON ds.id=dl.sessao_id WHERE ds.mes_ref=$1`, [mesAtual]).catch(()=>({rows:[{receitas:0,despesas:0}]}));
         if (i === 11) return pool.query(`SELECT COUNT(*) AS n FROM dre_lancamentos WHERE (categoria IS NULL OR categoria='') AND mes=$1`, [mesAtual]).catch(()=>({rows:[{n:0}]}));
         return p;
       }));

      const dias = d => d ? Math.floor((agora - new Date(d)) / 86400000) : 999;
      const brl  = v => parseFloat(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

      const dEst = dias(estoque.rows[0]?.u);
      const dFat = dias(vendas.rows[0]?.u);
      const v    = validade.rows[0] || {};
      const nVenc = parseInt(v.vencidos||0);
      const nCrit = parseInt(v.criticos||0);
      const nAlrt = parseInt(v.alertas||0);
      const nBol  = parseInt(boletos.rows[0]?.n||0);
      const totBol = parseFloat(boletos.rows[0]?.total||0);
      const nMin  = parseInt(pMin.rows[0]?.n||0);
      const nMov  = parseInt(mov24h.rows[0]?.n||0);
      const totPerd = parseFloat(perdas.rows[0]?.total||0);
      const totRet  = parseFloat(retiradas.rows[0]?.total||0);
      const rec     = parseFloat(dre_pend ? 0 : (dreRes.rows[0]?.receitas||0)); // Will be resolved below
      const desp    = parseFloat(dreRes.rows[0]?.despesas||0);
      const receitas = parseFloat(dreRes.rows[0]?.receitas||0);
      const nBolProx = parseInt(boletoProx.rows[0]?.n||0);
      const totAberto = parseFloat(valorAberto.rows[0]?.total||0);
      const nDrePend = parseInt(dre_pend.rows[0]?.n||0);
      const resultado = receitas - desp;

      res.json({ ok: true, data: {
        timestamp: agora,
        mes: mesAtual,
        status: {
          estoque:  { ok: dEst<=1, alerta: dEst>1&&dEst<=3, critico: dEst>3,
                      msg: dEst===0?'Atualizado hoje':`Há ${dEst} dia(s)`, dias: dEst },
          vendas:   { ok: dFat<=1, alerta: dFat>1&&dFat<=3, critico: dFat>3,
                      msg: dFat<=1?'Importadas hoje/ontem':`Há ${dFat} dia(s)`, dias: dFat },
          validade: { ok: nVenc===0&&nCrit===0, alerta: nVenc===0&&nCrit>0, critico: nVenc>0,
                      msg: nVenc>0?`${nVenc} vencido(s) — urgente!`:nCrit>0?`${nCrit} vencem em 3 dias`:'OK',
                      vencidos: nVenc, criticos: nCrit, alertas: nAlrt },
          boletos:  { ok: nBol===0, alerta: nBol>0&&nBol<=3, critico: nBol>3,
                      msg: nBol>0?`${nBol} vencido(s) — R$ ${brl(totBol)}`:'Em dia',
                      vencidos: nBol, total_vencido: totBol, prox7d: nBolProx, total_aberto: totAberto },
          estoque_minimo: { ok: nMin===0, alerta: nMin>0&&nMin<=5, critico: nMin>5,
                            msg: nMin>0?`${nMin} abaixo do mínimo`:'Adequado', count: nMin },
        },
        financeiro: {
          receitas, despesas: desp, resultado,
          resultado_fmt: `R$ ${brl(Math.abs(resultado))}`,
          resultado_tipo: resultado >= 0 ? 'positivo' : 'negativo',
          boletos_vencidos: nBol, boletos_vencidos_valor: totBol,
          boletos_prox7d: nBolProx, total_aberto: totAberto,
          dre_pendencias: nDrePend,
        },
        operacional: {
          perdas_mes: totPerd, perdas_count: parseInt(perdas.rows[0]?.n||0),
          retiradas_mes: totRet, retiradas_count: parseInt(retiradas.rows[0]?.n||0),
          movimentos_24h: nMov,
          validade_vencidos: nVenc, validade_criticos: nCrit, validade_alertas: nAlrt,
          estoque_minimo_count: nMin,
        },
      }});
    } catch(e) {
      console.error('[hub/resumo]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Manter /status e /pendencias para compatibilidade
  r.get('/status',    async (req, res) => { res.redirect('/api/hub/resumo'); });
  r.get('/pendencias',async (req, res) => { res.json({ ok: true, data: [] }); });

  return r;
};
