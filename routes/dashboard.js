/**
 * routes/dashboard.js — KPIs consolidados
 *
 * Rotas:
 *   GET /api/dashboard/kpis  → todos os KPIs do dashboard principal
 */

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  r.get('/kpis', async (req, res) => {
    // Aceita mes como MM/YYYY ou MM-YYYY (query string encode converte / em %2F)
    const mesRaw = req.query.mes || '';
    const mes = mesRaw.replace(/-(\d{4})$/, '/$1') || (() => {
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    })();

    try {
      // Atualiza status de validade antes de consultar
      await pool.query(`
        UPDATE validade_items SET
          status = CASE
            WHEN data_validade < CURRENT_DATE THEN 'vencido'
            WHEN data_validade <= CURRENT_DATE + (COALESCE(dias_alerta,7) || ' days')::INTERVAL THEN 'alerta'
            ELSE 'ok'
          END
        WHERE status NOT IN ('descartado','vendido') AND data_validade IS NOT NULL
      `).catch(() => {}); // silencia erro se tabela não existir ainda

      // Cada query isolada — se uma falhar, retorna zero sem quebrar o dashboard
      const safeQuery = async (sql, params=[]) => {
        try { return (await pool.query(sql, params)).rows[0] || {}; }
        catch (e) { console.warn('[dashboard] query falhou:', e.message); return {}; }
      };

      const [bRow, vRow, pRow, rRow, dreRow, metaRow, fatRow] = await Promise.all([
        // M1: Boletos
        safeQuery(`
          SELECT
            COALESCE(COUNT(*) FILTER (WHERE status='avencer' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7),0) AS vence_7d,
            COALESCE(COUNT(*) FILTER (WHERE status='vencido' OR (status='avencer' AND vencimento<CURRENT_DATE)),0)       AS vencidos,
            COALESCE(SUM(valor) FILTER (WHERE status='avencer' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7),0) AS valor_vence_7d,
            COALESCE(SUM(valor) FILTER (WHERE status!='pago' AND status!='cancelado'),0) AS total_aberto
          FROM boletos WHERE status!='cancelado'
        `),
        // M4: Validade
        safeQuery(`
          SELECT
            COALESCE(COUNT(*) FILTER (WHERE status='alerta'),0)  AS alerta,
            COALESCE(COUNT(*) FILTER (WHERE status='vencido'),0) AS vencidos
          FROM validade_items WHERE status NOT IN ('descartado')
        `),
        // M4: Perdas — usa coluna mes se existir, senão TO_CHAR
        safeQuery(`
          SELECT COALESCE(SUM(valor_perda),0) AS total FROM perdas
          WHERE COALESCE(mes, TO_CHAR(dt_perda,'MM/YYYY')) = $1
        `, [mes]),
        // M5: Retiradas
        safeQuery(
          `SELECT COALESCE(SUM(valor_total),0) AS total FROM retiradas WHERE mes=$1`, [mes]
        ),
        // M2: DRE — lê resultado calculado e salvo (res_final) + transactions para fallback
        safeQuery(
          `SELECT dados_json, res_receitas, res_despesas, res_cmv, res_lucro_bruto, res_lucro_op, res_final
           FROM dre_sessoes WHERE mes_ref=$1 ORDER BY atualizado_em DESC LIMIT 1`, [mes]
        ),
        // M6: Meta
        safeQuery(`SELECT * FROM metas WHERE mes=$1 LIMIT 1`, [mes]),
        // M7: Faturamento real (módulo Faturamento — fonte da verdade)
        safeQuery(`
          SELECT COALESCE(SUM(fat_bruto),0) AS total
          FROM faturamento_periodos
          WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1 AND tipo_periodo = 'dia'
        `, [mes]),
      ]);

      // Usa resultado calculado e salvo pelo DRE quando disponível (opção 2)
      // Fallback: recalcula a partir das transactions (comportamento anterior)
      let dreReceitas=0, dreDespesas=0, dreResultado=0;
      const temResultadoSalvo = dreRow.res_final != null;

      if (temResultadoSalvo) {
        // Resultado exato do DRE — inclui CMV, estoque, DAS, retiradas
        dreReceitas  = parseFloat(dreRow.res_receitas  || 0);
        dreDespesas  = parseFloat(dreRow.res_despesas  || 0);
        dreResultado = parseFloat(dreRow.res_final     || 0);
      } else {
        // Fallback: calcula a partir das transactions (sem CMV/estoque/DAS)
        if (dreRow.dados_json) {
          const txs = dreRow.dados_json.transactions || [];
          for (const t of txs) {
            if (t.ignorar || !t.categoria) continue;
            if (t.fonte === 'PREV_RECEITA' || t.fonte === 'BOLETO_PREV') continue;
            const tMes = t.mes;
            if (tMes && tMes !== mes) continue;
            const v = parseFloat(t.valor||0);
            if (v>0) dreReceitas+=v; else dreDespesas+=Math.abs(v);
          }
          dreResultado = dreReceitas - dreDespesas;
        }
      }

      const faturamentoMeta = parseFloat(metaRow.faturamento_meta||0);
      const fatRealModulo = parseFloat(fatRow.total||0);
      const faturamentoReal = fatRealModulo > 0 ? fatRealModulo : dreReceitas;
      const metaPerdaPct    = parseFloat(metaRow.meta_perda_pct||0);
      const metaPerdasValor = faturamentoReal>0 ? (faturamentoReal*metaPerdaPct/100) : 0;
      const totalPerdas     = parseFloat(pRow.total||0);
      const totalRetiradas  = parseFloat(rRow.total||0);

      res.json({
        ok: true, mes,
        data: {
          boletosVence7d:      parseInt(bRow.vence_7d||0),
          boletosVencidos:     parseInt(bRow.vencidos||0),
          boletosValorVence7d: parseFloat(bRow.valor_vence_7d||0),
          boletosAberto:       parseFloat(bRow.total_aberto||0),
          dreReceitas, dreDespesas,
          dreResultado,
          dreResultadoFonte: temResultadoSalvo ? 'salvo' : 'calculado',
          validadeAlerta:      parseInt(vRow.alerta||0),
          validadeVencidos:    parseInt(vRow.vencidos||0),
          perdasMes:           totalPerdas,
          perdasMeta:          metaPerdasValor,
          perdasDentroMeta:    metaPerdasValor>0 ? totalPerdas<=metaPerdasValor : null,
          retiradasMes:        totalRetiradas,
          faturamentoMeta, faturamentoReal,
          faturamentoPct: faturamentoMeta>0
            ? parseFloat(((faturamentoReal/faturamentoMeta)*100).toFixed(1)) : 0,
        }
      });
    } catch (e) {
      console.error('[dashboard/kpis]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /gerencial — Dashboard Gerencial completo (F2-10) ─────────────────
  r.get('/gerencial', async (req, res) => {
    const mesRaw = req.query.mes || '';
    const mes = mesRaw.replace(/-(\d{4})$/, '/$1') || (() => {
      const d = new Date();
      return `${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    })();
    const [mm, yy] = mes.split('/');
    const mesAnt = mm === '01'
      ? `12/${parseInt(yy)-1}`
      : `${String(parseInt(mm)-1).padStart(2,'0')}/${yy}`;

    const safe = async (sql, p=[]) => {
      try { return (await pool.query(sql, p)).rows; }
      catch(e) { console.warn('[dashboard/gerencial]', e.message); return []; }
    };
    const r1 = async (sql, p=[]) => {
      try { return (await pool.query(sql, p)).rows[0] || {}; }
      catch(e) { return {}; }
    };

    try {
      const [
        fatMes, fatMesAnt, fatHoje, fat30d,
        metaRow,
        dreRow,
        bolRow,
        perdRow, perdMesAnt,
        valRow,
        movTop,
      ] = await Promise.all([
        // Faturamento acumulado do mês + dias importados
        r1(`SELECT COALESCE(SUM(fat_bruto),0) AS fat, COUNT(*) AS dias,
                   COALESCE(SUM(total_pessoas),0) AS pessoas,
                   COALESCE(ROUND(AVG(NULLIF(ticket_medio,0)),2),0) AS ticket
            FROM faturamento_periodos
            WHERE TO_CHAR(data_inicio,'MM/YYYY')=$1 AND tipo_periodo='dia'`, [mes]),
        // Faturamento mês anterior
        r1(`SELECT COALESCE(SUM(fat_bruto),0) AS fat FROM faturamento_periodos
            WHERE TO_CHAR(data_inicio,'MM/YYYY')=$1 AND tipo_periodo='dia'`, [mesAnt]),
        // Faturamento hoje
        r1(`SELECT COALESCE(SUM(fat_bruto),0) AS fat, COALESCE(SUM(total_pessoas),0) AS pessoas
            FROM faturamento_periodos WHERE data_inicio=CURRENT_DATE AND tipo_periodo='dia'`),
        // Últimos 30 dias (para gráfico)
        safe(`SELECT data_inicio::text AS data, fat_bruto AS fat
              FROM faturamento_periodos
              WHERE data_inicio >= CURRENT_DATE-29 AND tipo_periodo='dia'
              ORDER BY data_inicio ASC`),
        // Meta do mês
        r1(`SELECT faturamento_meta, meta_perda_pct, meta_retiradas FROM metas WHERE mes=$1`, [mes]),
        // DRE resultado salvo
        r1(`SELECT res_receitas, res_despesas, res_final FROM dre_sessoes
            WHERE mes_ref=$1 ORDER BY atualizado_em DESC LIMIT 1`, [mes]),
        // Boletos
        r1(`SELECT
              COALESCE(COUNT(*) FILTER (WHERE status='avencer' AND vencimento<CURRENT_DATE),0) AS vencidos,
              COALESCE(COUNT(*) FILTER (WHERE status='avencer' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7),0) AS vence_7d,
              COALESCE(SUM(ABS(valor)) FILTER (WHERE status='avencer'),0) AS total_aberto,
              COALESCE(SUM(ABS(valor)) FILTER (WHERE status='avencer' AND vencimento<CURRENT_DATE),0) AS total_vencido
            FROM boletos WHERE status!='cancelado'`),
        // Perdas mês atual
        r1(`SELECT COALESCE(SUM(valor_perda),0) AS total, COUNT(*) AS qtd
            FROM perdas WHERE COALESCE(mes,TO_CHAR(dt_perda,'MM/YYYY'))=$1`, [mes]),
        // Perdas mês anterior
        r1(`SELECT COALESCE(SUM(valor_perda),0) AS total
            FROM perdas WHERE COALESCE(mes,TO_CHAR(dt_perda,'MM/YYYY'))=$1`, [mesAnt]),
        // Validade em risco
        r1(`SELECT
              COUNT(*) FILTER (WHERE data_validade<CURRENT_DATE AND status NOT IN ('descartado','vendido')) AS vencidos,
              COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE+7 AND status NOT IN ('descartado','vendido')) AS alerta_7d,
              COALESCE(SUM(CASE WHEN data_validade<=CURRENT_DATE+7 AND status NOT IN ('descartado','vendido')
                THEN COALESCE(peso_total_kg,0)*COALESCE(preco_custo,0) ELSE 0 END),0) AS valor_risco
            FROM validade_items`),
        // Top 5 produtos com mais saída no mês (VENDA_ANALYTICS)
        safe(`SELECT produto_codigo AS codigo, observacao AS nome,
                     SUM(ABS(quantidade)) AS total_qtd
              FROM movimentos_estoque
              WHERE tipo_movimento='VENDA_ANALYTICS'
                AND TO_CHAR(data_movimento,'MM/YYYY')=$1
                AND produto_codigo IS NOT NULL
              GROUP BY produto_codigo, observacao
              ORDER BY SUM(ABS(quantidade)) DESC LIMIT 5`, [mes]),
      ]);

      const fatRealMes = parseFloat(fatMes.fat||0);
      const fatMeta    = parseFloat(metaRow.faturamento_meta||0);
      const diasImp    = parseInt(fatMes.dias||0);
      const hoje       = new Date();
      const diasMes    = new Date(parseInt(yy), parseInt(mm), 0).getDate();
      const diaAtual   = hoje.getMonth()+1 === parseInt(mm) && hoje.getFullYear() === parseInt(yy)
                         ? hoje.getDate() : diasMes;

      // Projeção: média diária × dias do mês
      const mediaDiaria   = diasImp > 0 ? fatRealMes / diasImp : 0;
      const projecao      = Math.round(mediaDiaria * diasMes);
      const pctMeta       = fatMeta > 0 ? Math.round(fatRealMes/fatMeta*100) : null;
      const pctProjecao   = fatMeta > 0 ? Math.round(projecao/fatMeta*100) : null;
      const varMesAnt     = parseFloat(fatMesAnt.fat||0) > 0
                            ? parseFloat(((fatRealMes - parseFloat(fatMesAnt.fat))/parseFloat(fatMesAnt.fat)*100).toFixed(1))
                            : null;

      // Curva ABC — top vendido (usando movimentos como proxy)
      const abcTop = movTop.map(r => ({
        codigo:   r.codigo,
        nome:     (r.nome||'').replace(/Venda XMenu: /,'').split(' — ')[0].trim(),
        total_qtd: parseFloat(r.total_qtd||0),
      }));

      res.json({ ok: true, data: {
        mes, mes_ant: mesAnt,
        faturamento: {
          realizado:   fatRealMes,
          meta:        fatMeta,
          pct_meta:    pctMeta,
          dias_importados: diasImp,
          media_diaria: parseFloat(mediaDiaria.toFixed(2)),
          projecao,
          pct_projecao: pctProjecao,
          var_mes_ant:  varMesAnt,
          hoje:        parseFloat(fatHoje.fat||0),
          pessoas_hoje: parseInt(fatHoje.pessoas||0),
          pessoas_mes:  parseInt(fatMes.pessoas||0),
          ticket_medio: parseFloat(fatMes.ticket||0),
          fat_mes_ant:  parseFloat(fatMesAnt.fat||0),
          grafico_30d:  fat30d,
        },
        dre: {
          receitas:  parseFloat(dreRow.res_receitas||0),
          despesas:  parseFloat(dreRow.res_despesas||0),
          resultado: parseFloat(dreRow.res_final||0),
          margem:    parseFloat(dreRow.res_receitas||0) > 0
            ? parseFloat(((parseFloat(dreRow.res_final||0)/parseFloat(dreRow.res_receitas||0))*100).toFixed(1))
            : 0,
        },
        boletos: {
          vencidos:     parseInt(bolRow.vencidos||0),
          vence_7d:     parseInt(bolRow.vence_7d||0),
          total_aberto: parseFloat(bolRow.total_aberto||0),
          total_vencido: parseFloat(bolRow.total_vencido||0),
        },
        perdas: {
          total_mes:  parseFloat(perdRow.total||0),
          qtd_mes:    parseInt(perdRow.qtd||0),
          total_ant:  parseFloat(perdMesAnt.total||0),
          pct_fat:    fatRealMes > 0
            ? parseFloat((parseFloat(perdRow.total||0)/fatRealMes*100).toFixed(2))
            : 0,
          meta_pct:   parseFloat(metaRow.meta_perda_pct||2),
        },
        validade: {
          vencidos:    parseInt(valRow.vencidos||0),
          alerta_7d:   parseInt(valRow.alerta_7d||0),
          valor_risco: parseFloat(valRow.valor_risco||0),
        },
        top_produtos: abcTop,
      }});
    } catch(e) {
      console.error('[dashboard/gerencial]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /curva-abc — Curva ABC por faturamento (F2-12) ───────────────────
  r.get('/curva-abc', async (req, res) => {
    const janela = parseInt(req.query.janela) || 90;
    const dim    = req.query.dim || 'faturamento'; // faturamento|quantidade|frequencia

    try {
      // Calcular por dimensão
      let sql;
      if (dim === 'quantidade') {
        sql = `SELECT codigo, nome AS descricao,
                      SUM(quantidade) AS valor_total, COUNT(DISTINCT data_venda) AS dias
               FROM vendas_produto
               WHERE data_venda >= CURRENT_DATE - ${janela}
               GROUP BY codigo, nome ORDER BY SUM(quantidade) DESC`;
      } else if (dim === 'frequencia') {
        sql = `SELECT codigo, nome AS descricao,
                      COUNT(DISTINCT data_venda) AS valor_total, SUM(quantidade) AS qtd
               FROM vendas_produto
               WHERE data_venda >= CURRENT_DATE - ${janela}
               GROUP BY codigo, nome ORDER BY COUNT(DISTINCT data_venda) DESC`;
      } else {
        sql = `SELECT codigo, nome AS descricao,
                      SUM(valor_total) AS valor_total, SUM(quantidade) AS qtd
               FROM vendas_produto
               WHERE data_venda >= CURRENT_DATE - ${janela}
               GROUP BY codigo, nome ORDER BY SUM(valor_total) DESC`;
      }

      const { rows } = await pool.query(sql);
      if (!rows.length) return res.json({ ok: true, data: [], janela, dim });

      // Calcular Pareto
      const total = rows.reduce((s,r) => s + parseFloat(r.valor_total||0), 0);
      let acum = 0;
      const resultado = rows.map(r => {
        const v   = parseFloat(r.valor_total||0);
        acum     += v;
        const pct = total > 0 ? parseFloat((acum/total*100).toFixed(1)) : 0;
        const cls = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
        return {
          codigo:     r.codigo,
          descricao:  r.descricao,
          valor:      parseFloat(v.toFixed(2)),
          pct_acum:   pct,
          classe:     cls,
          qtd:        parseFloat(r.qtd||0),
        };
      });

      // Atualizar produtos.curva_abc em background (sem bloquear resposta)
      if (dim === 'faturamento') {
        setImmediate(async () => {
          try {
            for (const it of resultado) {
              await pool.query(
                `UPDATE produtos SET curva_abc=$1, curva_abc_valor=$2, curva_abc_em=NOW()
                 WHERE codigo=$3`,
                [it.classe, it.valor, it.codigo]
              );
            }
          } catch(e) { console.warn('[curva-abc] update produtos:', e.message); }
        });
      }

      res.json({ ok: true, data: resultado, total, janela, dim });
    } catch(e) {
      console.error('[dashboard/curva-abc]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
