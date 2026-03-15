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
    const mes = req.query.mes || (() => {
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    })();

    try {
      const [boletos, validade, perdas, retiradas, dre, meta] = await Promise.all([
        // M1: Boletos
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status='avencer' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS vence_7d,
            COUNT(*) FILTER (WHERE status='vencido' OR (status='avencer' AND vencimento < CURRENT_DATE))     AS vencidos,
            COALESCE(SUM(valor) FILTER (WHERE status='avencer' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7), 0) AS valor_vence_7d,
            COALESCE(SUM(valor) FILTER (WHERE status != 'pago' AND status != 'cancelado'), 0) AS total_aberto
          FROM boletos WHERE status != 'cancelado'
        `),

        // M4: Validade
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status='alerta')  AS alerta,
            COUNT(*) FILTER (WHERE status='vencido') AS vencidos
          FROM validade_items WHERE status NOT IN ('descartado')
        `),

        // M4: Perdas do mês
        pool.query(
          `SELECT COALESCE(SUM(valor_perda), 0) AS total FROM perdas WHERE mes = $1`, [mes]
        ),

        // M5: Retiradas do mês
        pool.query(
          `SELECT COALESCE(SUM(valor_total), 0) AS total FROM retiradas WHERE mes = $1`, [mes]
        ),

        // M2: DRE do mês
        pool.query(
          `SELECT dados_json FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`, [mes]
        ),

        // M6: Meta do mês
        pool.query(
          `SELECT * FROM metas WHERE mes = $1 LIMIT 1`, [mes]
        ),
      ]);

      // Calcula receitas/despesas do DRE
      let dreReceitas = 0, dreDespesas = 0;
      if (dre.rows.length && dre.rows[0].dados_json) {
        const txs = dre.rows[0].dados_json.transactions || [];
        for (const t of txs) {
          if (t.ignorar) continue;
          const v = parseFloat(t.valor || 0);
          if (v > 0) dreReceitas += v;
          else dreDespesas += Math.abs(v);
        }
      }

      const metaRow          = meta.rows[0] || {};
      const faturamentoMeta  = parseFloat(metaRow.faturamento_meta || 0);
      const faturamentoReal  = parseFloat(metaRow.faturamento_real || dreReceitas || 0);
      const metaPerdaPct     = parseFloat(metaRow.meta_perda_pct || 0);
      const metaPerdasValor  = faturamentoReal > 0 ? (faturamentoReal * metaPerdaPct / 100) : 0;
      const totalPerdas      = parseFloat(perdas.rows[0].total);
      const totalRetiradas   = parseFloat(retiradas.rows[0].total);

      res.json({
        ok: true,
        mes,
        data: {
          // M1
          boletosVence7d:   parseInt(boletos.rows[0].vence_7d),
          boletosVencidos:  parseInt(boletos.rows[0].vencidos),
          boletosValorVence7d: parseFloat(boletos.rows[0].valor_vence_7d),
          boletosAberto:    parseFloat(boletos.rows[0].total_aberto),

          // M2
          dreReceitas, dreDespesas,
          dreResultado: dreReceitas - dreDespesas,

          // M4 validade
          validadeAlerta:   parseInt(validade.rows[0].alerta),
          validadeVencidos: parseInt(validade.rows[0].vencidos),

          // M4 perdas
          perdasMes:      totalPerdas,
          perdasMeta:     metaPerdasValor,
          perdasDentroMeta: metaPerdasValor > 0 ? totalPerdas <= metaPerdasValor : null,

          // M5
          retiradasMes: totalRetiradas,

          // M6
          faturamentoMeta, faturamentoReal,
          faturamentoPct: faturamentoMeta > 0
            ? parseFloat(((faturamentoReal / faturamentoMeta) * 100).toFixed(1))
            : 0,
        }
      });
    } catch (e) {
      console.error('[dashboard/kpis]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
