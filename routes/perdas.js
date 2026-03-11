const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/perdas ──────────────────────────────────────
  router.get('/', autenticar(), async (req, res) => {
    const { mes, codigo_produto, limit = 200, offset = 0 } = req.query;
    const where  = ['1=1'];
    const params = [];

    if (mes) {
      // mes = YYYY-MM
      params.push(mes);
      where.push(`TO_CHAR(p.data_perda, 'YYYY-MM') = $${params.length}`);
    }
    if (codigo_produto) where.push(`p.codigo_produto = $${params.push(codigo_produto)}`);

    try {
      const { rows } = await pool.query(
        `SELECT p.*,
                pm.descricao_produto, pm.categoria,
                l.lote AS lote_codigo, l.data_validade AS lote_validade
         FROM perdas p
         JOIN produtos_mestre pm ON pm.codigo_produto = p.codigo_produto
         LEFT JOIN lotes_estoque l ON l.id = p.lote_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.data_perda DESC, p.criado_em DESC
         LIMIT $${params.push(parseInt(limit))} OFFSET $${params.push(parseInt(offset))}`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('[perdas GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar perdas.' });
    }
  });

  // ── GET /api/perdas/resumo ───────────────────────────────
  router.get('/resumo', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM vw_perdas_mes_atual ORDER BY valor_total_perdido DESC LIMIT 20');
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar resumo de perdas.' });
    }
  });

  // ── GET /api/perdas/top-produtos ─────────────────────────
  router.get('/top-produtos', autenticar(), async (req, res) => {
    const { meses = 3 } = req.query;
    try {
      const { rows } = await pool.query(
        `SELECT p.codigo_produto, pm.descricao_produto,
                COUNT(*) AS ocorrencias,
                SUM(p.quantidade) AS quantidade_total,
                SUM(p.valor_estimado) AS valor_total
         FROM perdas p
         JOIN produtos_mestre pm ON pm.codigo_produto = p.codigo_produto
         WHERE p.data_perda >= CURRENT_DATE - ($1 * INTERVAL '1 month')
         GROUP BY p.codigo_produto, pm.descricao_produto
         ORDER BY valor_total DESC NULLS LAST
         LIMIT 10`,
        [parseInt(meses)]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar top produtos de perda.' });
    }
  });

  // ── POST /api/perdas ─────────────────────────────────────
  router.post('/', autenticar(['admin','gerente','estoque','operacao']), async (req, res) => {
    const {
      codigo_produto, lote_id, data_perda, quantidade,
      motivo, tipo_motivo, funcionario_responsavel, observacao
    } = req.body;

    if (!codigo_produto || !quantidade)
      return res.status(400).json({ erro: 'codigo_produto e quantidade são obrigatórios.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Buscar preço de custo atual do produto para valor_estimado
      const { rows: [prod] } = await client.query(
        'SELECT preco_custo FROM produtos_mestre WHERE codigo_produto = $1',
        [codigo_produto]
      );
      if (!prod) { await client.query('ROLLBACK'); return res.status(400).json({ erro: 'Produto não encontrado.' }); }

      const qtd = parseFloat(quantidade);
      const valorEstimado = prod.preco_custo ? parseFloat((qtd * prod.preco_custo).toFixed(2)) : null;

      const { rows } = await client.query(
        `INSERT INTO perdas
           (codigo_produto, lote_id, data_perda, quantidade, motivo, tipo_motivo,
            valor_estimado, preco_custo_referencia, funcionario_responsavel,
            usuario_lancamento, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          codigo_produto,
          lote_id || null,
          data_perda || new Date().toISOString().split('T')[0],
          qtd,
          motivo || null,
          tipo_motivo || null,
          valorEstimado,
          prod.preco_custo || null,
          funcionario_responsavel || null,
          req.usuario.id,
          observacao || null,
        ]
      );

      // Se lote informado, baixar do estoque automaticamente
      if (lote_id) {
        await client.query(
          `UPDATE lotes_estoque
           SET quantidade_atual = GREATEST(quantidade_atual - $1, 0), atualizado_em = NOW()
           WHERE id = $2`,
          [qtd, lote_id]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[perdas POST]', err.message);
      res.status(500).json({ erro: 'Erro ao registrar perda.' });
    } finally {
      client.release();
    }
  });

  // ── DELETE /api/perdas/:id ───────────────────────────────
  router.delete('/:id', autenticar(['admin','gerente']), async (req, res) => {
    try {
      await pool.query('DELETE FROM perdas WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao excluir perda.' });
    }
  });

  return router;
};
