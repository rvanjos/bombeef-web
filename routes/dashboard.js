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
        // M2: DRE
        safeQuery(
          `SELECT dados_json FROM dre_sessoes WHERE mes_ref=$1 ORDER BY atualizado_em DESC LIMIT 1`, [mes]
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

      // Calcula receitas/despesas do DRE — filtra mês e ignora boletos/previsões
      let dreReceitas=0, dreDespesas=0;
      if (dreRow.dados_json) {
        const txs = dreRow.dados_json.transactions || [];
        for (const t of txs) {
          if (t.ignorar) continue;
          // Ignorar fontes que não são lançamentos reais classificados
          if (!t.categoria) continue; // apenas classificados
          if (t.fonte === 'PREV_RECEITA') continue;
          if (t.fonte === 'BOLETO_PREV') continue; // boletos a vencer não são receita/despesa realizada
          // Filtra pelo mês DRE (competência)
          const tMes = t.mes;
          if (tMes && tMes !== mes) continue;
          const v=parseFloat(t.valor||0);
          if (v>0) dreReceitas+=v; else dreDespesas+=Math.abs(v);
        }
      }

      const faturamentoMeta = parseFloat(metaRow.faturamento_meta||0);
      // Prioridade: Faturamento real (módulo Faturamento) > DRE receitas
      // Não usa mais metas.faturamento_real (campo manual desatualizado)
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
          dreResultado: dreReceitas - dreDespesas,
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

  return r;
};
