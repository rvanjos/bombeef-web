const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/dashboard ───────────────────────────────────
  // Retorna todos os indicadores em uma única chamada
  router.get('/', autenticar(), async (req, res) => {
    try {
      // Atualizar boletos vencidos antes de consolidar
      await pool.query('SELECT atualizar_status_boletos_vencidos()').catch(() => {});

      const [statusBase, alertasVal, perdasResumo, boletosAbertos, topPerdas] = await Promise.all([
        pool.query('SELECT * FROM vw_status_base'),
        pool.query(
          `SELECT * FROM vw_produtos_validade
           WHERE status_validade IN ('vencido','critico','urgente')
           ORDER BY CASE status_validade WHEN 'vencido' THEN 0 WHEN 'critico' THEN 1 ELSE 2 END,
                    proxima_validade ASC NULLS LAST
           LIMIT 15`
        ),
        pool.query('SELECT * FROM vw_perdas_mes_atual LIMIT 10'),
        pool.query('SELECT * FROM vw_boletos_abertos LIMIT 20'),
        pool.query(
          `SELECT p.codigo_produto, pm.descricao_produto, COUNT(*) AS ocorrencias,
                  SUM(p.valor_estimado) AS valor_total
           FROM perdas p
           JOIN produtos_mestre pm ON pm.codigo_produto = p.codigo_produto
           WHERE p.data_perda >= CURRENT_DATE - INTERVAL '90 days'
           GROUP BY p.codigo_produto, pm.descricao_produto
           ORDER BY valor_total DESC NULLS LAST
           LIMIT 5`
        ),
      ]);

      const status = statusBase.rows[0] || {};

      res.json({
        status_base: {
          ...status,
          alerta_desatualizada: parseInt(status.dias_desde_importacao || 0) > 7,
        },
        alertas_validade: alertasVal.rows,
        perdas_mes:       perdasResumo.rows,
        boletos_abertos:  boletosAbertos.rows,
        top_perdas_90d:   topPerdas.rows,
      });
    } catch (err) {
      console.error('[dashboard GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao carregar dashboard.' });
    }
  });

  // ── GET /api/dashboard/kpis ──────────────────────────────
  // KPIs individuais por perfil
  router.get('/kpis', autenticar(), async (req, res) => {
    try {
      const [produtos, perdas, boletos, kits, lotes] = await Promise.all([
        pool.query('SELECT COUNT(*) AS total FROM produtos_mestre WHERE ativo = true'),
        pool.query(
          `SELECT COUNT(*) AS ocorrencias,
                  COALESCE(SUM(valor_estimado),0) AS valor_total
           FROM perdas
           WHERE DATE_TRUNC('month',data_perda) = DATE_TRUNC('month',NOW())`
        ),
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE status IN ('avencer','vencido')) AS abertos,
                  COALESCE(SUM(valor) FILTER (WHERE status IN ('avencer','vencido')),0) AS total_aberto,
                  COUNT(*) FILTER (WHERE status='vencido') AS vencidos
           FROM boletos`
        ),
        pool.query(`SELECT COUNT(*) AS total FROM kits WHERE ativo = true`),
        pool.query(
          `SELECT COUNT(*) AS lotes_criticos
           FROM lotes_estoque
           WHERE quantidade_atual > 0 AND ativo = true
             AND data_validade <= CURRENT_DATE + INTERVAL '7 days'`
        ),
      ]);

      res.json({
        total_produtos:     parseInt(produtos.rows[0].total),
        perdas_mes:         { ocorrencias: parseInt(perdas.rows[0].ocorrencias), valor: parseFloat(perdas.rows[0].valor_total) },
        boletos:            { abertos: parseInt(boletos.rows[0].abertos), total: parseFloat(boletos.rows[0].total_aberto), vencidos: parseInt(boletos.rows[0].vencidos) },
        total_kits:         parseInt(kits.rows[0].total),
        lotes_criticos:     parseInt(lotes.rows[0].lotes_criticos),
      });
    } catch (err) {
      console.error('[dashboard/kpis]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar KPIs.' });
    }
  });

  return router;
};
