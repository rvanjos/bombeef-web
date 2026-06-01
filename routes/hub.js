/**
 * routes/hub.js — Hub Operacional
 * GET /api/hub/resumo — todos os dados que o gestor precisa ao abrir o sistema
 * F2-01: vendas do dia + meta + % + comparativo semana anterior
 * F2-02: estoque completo (mínimo, críticos, vencidos, 7d)
 * F2-03: importações com última atualização por tipo
 */
'use strict';

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  r.get('/resumo', async (req, res) => {
    try {
      const agora   = new Date();
      const hoje    = agora.toISOString().slice(0,10);           // YYYY-MM-DD
      const diaSem  = agora.getDay();                            // 0=dom…6=sab
      const semAnt  = new Date(agora);
      semAnt.setDate(agora.getDate() - 7);
      const semAntStr = semAnt.toISOString().slice(0,10);
      const mes     = `${String(agora.getMonth()+1).padStart(2,'0')}/${agora.getFullYear()}`;
      const mesAnt  = (() => {
        const d = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
        return `${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      })();

      const q  = (sql, p=[]) => pool.query(sql, p).catch(() => ({ rows: [] }));
      const n  = v => parseFloat(v || 0);
      const i  = v => parseInt(v || 0);

      // ── Paralelo: todas as queries de uma vez ─────────────────────────────
      const [
        vendaHoje,
        vendaSemAnt,
        vendaMes,
        vendaMesAnt,
        meta,
        validade,
        boletoVenc,
        boletoProx,
        boletoAberto,
        estMin,
        estAtual,
        mov24h,
        perdasMes,
        retiradasMes,
        drePend,
        impEstoque,
        impVendas,
        impProdutos,
        impBoletos,
      ] = await Promise.all([

        // F2-01: venda de hoje (tipo_periodo='dia' na data de hoje)
        q(`SELECT COALESCE(SUM(fat_bruto),0) AS fat,
                  COALESCE(SUM(total_pessoas),0) AS pessoas,
                  COALESCE(ROUND(CASE WHEN SUM(total_pessoas)>0
                    THEN SUM(fat_bruto)/SUM(total_pessoas) ELSE 0 END,2),0) AS ticket
           FROM faturamento_periodos
           WHERE tipo_periodo='dia' AND data_inicio=$1`, [hoje]),

        // F2-01: mesmo dia da semana anterior
        q(`SELECT COALESCE(SUM(fat_bruto),0) AS fat
           FROM faturamento_periodos
           WHERE tipo_periodo='dia' AND data_inicio=$1`, [semAntStr]),

        // F2-01: faturamento acumulado do mês (dias já importados)
        q(`SELECT COALESCE(SUM(fat_bruto),0) AS fat,
                  COUNT(*) AS dias_importados,
                  COALESCE(SUM(total_pessoas),0) AS pessoas,
                  COALESCE(ROUND(CASE WHEN SUM(total_pessoas)>0
                    THEN SUM(fat_bruto)/SUM(total_pessoas) ELSE 0 END,2),0) AS ticket
           FROM faturamento_periodos
           WHERE tipo_periodo='dia'
             AND TO_CHAR(data_inicio,'MM/YYYY')=$1`, [mes]),

        // F2-01: faturamento do mesmo mês do ano anterior para comparativo
        q(`SELECT COALESCE(SUM(fat_bruto),0) AS fat
           FROM faturamento_periodos
           WHERE tipo_periodo='dia'
             AND TO_CHAR(data_inicio,'MM/YYYY')=$1`, [mesAnt]),

        // F2-01: meta do mês (fonte única: tabela metas)
        q(`SELECT faturamento_meta, meta_perda_pct, meta_retiradas
           FROM metas WHERE mes=$1 LIMIT 1`, [mes]),

        // F2-02: validade
        q(`SELECT
             COUNT(*) FILTER (WHERE data_validade < CURRENT_DATE) AS vencidos,
             COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE+3) AS criticos,
             COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE+4 AND CURRENT_DATE+7) AS alertas7
           FROM validade_items WHERE status NOT IN ('descartado','vendido')`),

        // F2-02: boletos vencidos
        q(`SELECT COUNT(*) AS n, COALESCE(SUM(ABS(valor)),0) AS total
           FROM boletos WHERE status='avencer' AND vencimento < CURRENT_DATE`),

        // F2-02: boletos vencendo em 7 dias
        q(`SELECT COUNT(*) AS n, COALESCE(SUM(ABS(valor)),0) AS total
           FROM boletos WHERE status='avencer'
             AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7`),

        // F2-02: total aberto em boletos
        q(`SELECT COALESCE(SUM(ABS(valor)),0) AS total
           FROM boletos WHERE status='avencer'`),

        // F2-02: produtos abaixo do mínimo
        q(`SELECT COUNT(*) AS n FROM produtos
           WHERE ativo=true AND estoque_minimo>0 AND estoque<estoque_minimo`),

        // F2-02: produtos com estoque zero mas ativos
        q(`SELECT COUNT(*) AS n FROM produtos WHERE ativo=true AND estoque<=0`),

        // F2-02: movimentos nas últimas 24h
        q(`SELECT COUNT(*) AS n FROM movimentos_estoque
           WHERE data_movimento >= NOW()-INTERVAL '24 hours'`),

        // operacional: perdas do mês
        q(`SELECT COALESCE(SUM(valor_perda),0) AS total, COUNT(*) AS n
           FROM perdas WHERE mes=$1`, [mes]),

        // operacional: retiradas do mês
        q(`SELECT COALESCE(SUM(valor_total),0) AS total, COUNT(*) AS n
           FROM retiradas WHERE mes=$1`, [mes]),

        // operacional: lançamentos DRE sem categoria
        q(`SELECT COUNT(*) AS n FROM dre_lancamentos
           WHERE (categoria IS NULL OR categoria='') AND mes=$1`, [mes]),

        // F2-03: última importação de estoque (Rel. 302)
        q(`SELECT MAX(atualizado_em) AS u FROM produtos WHERE estoque > 0`),

        // F2-03: última importação de vendas
        q(`SELECT MAX(criado_em) AS u FROM faturamento_periodos WHERE tipo_periodo='dia'`),

        // F2-03: última importação de produtos (cadastro)
        q(`SELECT MAX(criado_em) AS u FROM produtos`),

        // F2-03: último boleto importado
        q(`SELECT MAX(criado_em) AS u FROM boletos`),
      ]);

      // ── Extrair valores ────────────────────────────────────────────────────
      const fatHoje     = n(vendaHoje.rows[0]?.fat);
      const fatSemAnt   = n(vendaSemAnt.rows[0]?.fat);
      const fatMes      = n(vendaMes.rows[0]?.fat);
      const fatMesAnt   = n(vendaMesAnt.rows[0]?.fat);
      const diasImp     = i(vendaMes.rows[0]?.dias_importados);
      const pessoasHoje = i(vendaHoje.rows[0]?.pessoas);
      const ticketHoje  = n(vendaHoje.rows[0]?.ticket);
      const ticketMes   = n(vendaMes.rows[0]?.ticket);
      const pessoasMes  = i(vendaMes.rows[0]?.pessoas);

      const fatMeta     = n(meta.rows[0]?.faturamento_meta);
      const metaPerdaPct= n(meta.rows[0]?.meta_perda_pct) || 2;
      const metaRet     = n(meta.rows[0]?.meta_retiradas);

      // Meta do dia = meta mensal ÷ 26 dias úteis (estimativa)
      const metaDia     = fatMeta > 0 ? fatMeta / 26 : 0;
      const pctDia      = metaDia > 0 ? Math.round(fatHoje / metaDia * 100) : null;
      const pctMes      = fatMeta > 0 ? Math.round(fatMes / fatMeta * 100) : null;

      // Comparativo semana anterior
      const varSemR     = fatHoje - fatSemAnt;
      const varSemPct   = fatSemAnt > 0
        ? parseFloat(((fatHoje - fatSemAnt) / fatSemAnt * 100).toFixed(1))
        : null;

      // Comparativo mês anterior
      const varMesR     = fatMes - fatMesAnt;
      const varMesPct   = fatMesAnt > 0
        ? parseFloat(((fatMes - fatMesAnt) / fatMesAnt * 100).toFixed(1))
        : null;

      const val       = validade.rows[0] || {};
      const nVenc     = i(val.vencidos);
      const nCrit     = i(val.criticos);
      const nAlrt     = i(val.alertas7);
      const nBolVenc  = i(boletoVenc.rows[0]?.n);
      const vlBolVenc = n(boletoVenc.rows[0]?.total);
      const nBolProx  = i(boletoProx.rows[0]?.n);
      const vlBolProx = n(boletoProx.rows[0]?.total);
      const vlAberto  = n(boletoAberto.rows[0]?.total);
      const nMin      = i(estMin.rows[0]?.n);
      const nZero     = i(estAtual.rows[0]?.n);
      const nMov24    = i(mov24h.rows[0]?.n);
      const totPerd   = n(perdasMes.rows[0]?.total);
      const nPerd     = i(perdasMes.rows[0]?.n);
      const totRet    = n(retiradasMes.rows[0]?.total);
      const nRet      = i(retiradasMes.rows[0]?.n);
      const nDrePend  = i(drePend.rows[0]?.n);

      // ── Dias desde a última importação ────────────────────────────────────
      const diasDes = dt => dt ? Math.floor((agora - new Date(dt)) / 86400000) : 999;
      const dEst    = diasDes(impEstoque.rows[0]?.u);
      const dVend   = diasDes(impVendas.rows[0]?.u);
      const dProd   = diasDes(impProdutos.rows[0]?.u);
      const dBol    = diasDes(impBoletos.rows[0]?.u);

      const semMsg = d => d === 0 ? 'Hoje' : d === 1 ? 'Ontem' : `${d} dias atrás`;

      // ── Semáforos ──────────────────────────────────────────────────────────
      const semaforo = {
        estoque:  { ok:dEst<=1, alerta:dEst>1&&dEst<=3, critico:dEst>3,
                    msg: semMsg(dEst), dias: dEst },
        vendas:   { ok:dVend<=1, alerta:dVend>1&&dVend<=3, critico:dVend>3,
                    msg: semMsg(dVend), dias: dVend },
        validade: { ok:nVenc===0&&nCrit===0, alerta:nVenc===0&&nCrit>0, critico:nVenc>0,
                    msg: nVenc>0 ? `${nVenc} vencido(s)` : nCrit>0 ? `${nCrit} crítico(s)` : 'OK',
                    vencidos:nVenc, criticos:nCrit, alertas:nAlrt },
        boletos:  { ok:nBolVenc===0, alerta:nBolVenc>0&&nBolVenc<=3, critico:nBolVenc>3,
                    msg: nBolVenc>0 ? `${nBolVenc} vencido(s)` : 'Em dia',
                    vencidos:nBolVenc, total_vencido:vlBolVenc,
                    prox7d:nBolProx, total_prox7d:vlBolProx, total_aberto:vlAberto },
        estoque_minimo: { ok:nMin===0, alerta:nMin>0&&nMin<=5, critico:nMin>5,
                          msg: nMin>0 ? `${nMin} abaixo do mínimo` : 'Adequado', count:nMin },
      };

      res.json({ ok: true, data: {
        timestamp: agora,
        mes,

        // ── F2-01: VENDAS ──────────────────────────────────────────────────
        vendas: {
          fat_hoje:       fatHoje,
          fat_semana_ant: fatSemAnt,
          var_sem_r:      varSemR,
          var_sem_pct:    varSemPct,
          fat_mes:        fatMes,
          fat_mes_ant:    fatMesAnt,
          var_mes_r:      varMesR,
          var_mes_pct:    varMesPct,
          dias_importados: diasImp,
          pessoas_hoje:   pessoasHoje,
          ticket_hoje:    ticketHoje,
          ticket_mes:     ticketMes,
          pessoas_mes:    pessoasMes,
          meta_dia:       metaDia,
          meta_mes:       fatMeta,
          pct_dia:        pctDia,
          pct_mes:        pctMes,
          dia_semana:     diaSem,
          data_hoje:      hoje,
          data_sem_ant:   semAntStr,
        },

        // ── F2-02: ESTOQUE ─────────────────────────────────────────────────
        estoque: {
          abaixo_minimo:   nMin,
          zerados:         nZero,
          vencidos:        nVenc,
          criticos_3d:     nCrit,
          alertas_7d:      nAlrt,
          movimentos_24h:  nMov24,
        },

        // ── FINANCEIRO ────────────────────────────────────────────────────
        financeiro: {
          boletos_vencidos:       nBolVenc,
          boletos_vencidos_valor: vlBolVenc,
          boletos_prox7d:         nBolProx,
          boletos_prox7d_valor:   vlBolProx,
          total_aberto:           vlAberto,
          perdas_mes:             totPerd,
          perdas_count:           nPerd,
          retiradas_mes:          totRet,
          retiradas_count:        nRet,
          dre_pendencias:         nDrePend,
          meta_perda_pct:         metaPerdaPct,
          meta_retiradas:         metaRet,
        },

        // ── F2-03: IMPORTAÇÕES ────────────────────────────────────────────
        importacoes: {
          estoque: { dias: dEst, msg: semMsg(dEst),
                     ok:dEst<=1, alerta:dEst>1&&dEst<=3, critico:dEst>3 },
          vendas:  { dias: dVend, msg: semMsg(dVend),
                     ok:dVend<=1, alerta:dVend>1&&dVend<=3, critico:dVend>3 },
          produtos:{ dias: dProd, msg: semMsg(dProd),
                     ok:dProd<=1, alerta:dProd>1&&dProd<=7, critico:dProd>7 },
          boletos: { dias: dBol, msg: semMsg(dBol),
                     ok:dBol<=1, alerta:dBol>1&&dBol<=7, critico:dBol>7 },
        },

        // ── SEMÁFORO (compatibilidade com hub.html existente) ─────────────
        status: semaforo,

        // ── OPERACIONAL (compatibilidade) ─────────────────────────────────
        operacional: {
          perdas_mes: totPerd, perdas_count: nPerd,
          retiradas_mes: totRet, retiradas_count: nRet,
          movimentos_24h: nMov24,
          validade_vencidos: nVenc, validade_criticos: nCrit, validade_alertas: nAlrt,
          estoque_minimo_count: nMin,
        },
      }});

    } catch(e) {
      console.error('[hub/resumo]', e.message, e.stack?.split('\n')[1]);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── Aliases de compatibilidade ────────────────────────────────────────────
  r.get('/status',     async (req, res) => res.redirect('/api/hub/resumo'));
  r.get('/pendencias', async (req, res) => res.json({ ok: true, data: [] }));

  return r;
};
