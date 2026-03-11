const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/lotes ───────────────────────────────────────
  router.get('/', autenticar(), async (req, res) => {
    const { codigo_produto, status, vencendo_em } = req.query;
    const where  = ['l.ativo = true'];
    const params = [];

    if (codigo_produto) where.push(`l.codigo_produto = $${params.push(codigo_produto)}`);
    if (status === 'com_estoque') where.push('l.quantidade_atual > 0');
    if (vencendo_em) {
      // vencendo_em = número de dias (ex: 7, 15, 30)
      params.push(parseInt(vencendo_em));
      where.push(`l.data_validade <= CURRENT_DATE + ($${params.length} * INTERVAL '1 day')`);
      where.push('l.data_validade >= CURRENT_DATE');
      where.push('l.quantidade_atual > 0');
    }

    try {
      const { rows } = await pool.query(
        `SELECT l.*,
                p.descricao_produto, p.categoria, p.preco_custo AS custo_ref,
                p.perecivel, p.controla_validade,
                l.data_validade - CURRENT_DATE AS dias_para_vencer
         FROM lotes_estoque l
         JOIN produtos_mestre p ON p.codigo_produto = l.codigo_produto
         WHERE ${where.join(' AND ')}
         ORDER BY l.data_validade ASC NULLS LAST, l.criado_em DESC`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('[lotes GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar lotes.' });
    }
  });

  // ── GET /api/lotes/alertas ───────────────────────────────
  router.get('/alertas', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM vw_produtos_validade
         WHERE status_validade IN ('vencido','critico','urgente')
         ORDER BY CASE status_validade WHEN 'vencido' THEN 0 WHEN 'critico' THEN 1 ELSE 2 END,
                  proxima_validade ASC NULLS LAST`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar alertas de validade.' });
    }
  });

  // ── GET /api/lotes/:id ───────────────────────────────────
  router.get('/:id', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT l.*, p.descricao_produto, p.categoria, p.preco_custo AS custo_ref
         FROM lotes_estoque l
         JOIN produtos_mestre p ON p.codigo_produto = l.codigo_produto
         WHERE l.id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'Lote não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar lote.' });
    }
  });

  // ── POST /api/lotes ──────────────────────────────────────
  router.post('/', autenticar(['admin','gerente','estoque','operacao']), async (req, res) => {
    const {
      codigo_produto, lote, data_entrada, data_validade,
      quantidade, custo_unitario, numero_nfe, cnpj_fornecedor, observacao
    } = req.body;

    if (!codigo_produto || !quantidade)
      return res.status(400).json({ erro: 'codigo_produto e quantidade são obrigatórios.' });
    if (isNaN(parseFloat(quantidade)) || parseFloat(quantidade) <= 0)
      return res.status(400).json({ erro: 'quantidade deve ser um número positivo.' });

    try {
      const { rows } = await pool.query(
        `INSERT INTO lotes_estoque
           (codigo_produto, lote, data_entrada, data_validade, quantidade, quantidade_atual,
            custo_unitario, numero_nfe, cnpj_fornecedor, usuario_lancamento, observacao)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          codigo_produto,
          lote || null,
          data_entrada || new Date().toISOString().split('T')[0],
          data_validade || null,
          parseFloat(quantidade),
          custo_unitario ? parseFloat(custo_unitario) : null,
          numero_nfe || null,
          cnpj_fornecedor || null,
          req.usuario.id,
          observacao || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23503') return res.status(400).json({ erro: 'Produto não encontrado na base mestre.' });
      console.error('[lotes POST]', err.message);
      res.status(500).json({ erro: 'Erro ao registrar lote.' });
    }
  });

  // ── PATCH /api/lotes/:id/baixa ───────────────────────────
  // Registra saída/baixa de quantidade de um lote
  router.patch('/:id/baixa', autenticar(['admin','gerente','estoque','operacao']), async (req, res) => {
    const { quantidade } = req.body;
    if (!quantidade || parseFloat(quantidade) <= 0)
      return res.status(400).json({ erro: 'quantidade inválida.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT quantidade_atual FROM lotes_estoque WHERE id = $1 AND ativo = true FOR UPDATE',
        [req.params.id]
      );
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ erro: 'Lote não encontrado.' }); }
      if (rows[0].quantidade_atual < parseFloat(quantidade)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: `Estoque insuficiente. Disponível: ${rows[0].quantidade_atual}` });
      }
      await client.query(
        'UPDATE lotes_estoque SET quantidade_atual = quantidade_atual - $1, atualizado_em = NOW() WHERE id = $2',
        [parseFloat(quantidade), req.params.id]
      );
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ erro: 'Erro ao realizar baixa.' });
    } finally {
      client.release();
    }
  });

  // ── PUT /api/lotes/:id ───────────────────────────────────
  router.put('/:id', autenticar(['admin','gerente','estoque']), async (req, res) => {
    const { data_validade, quantidade_atual, observacao, ativo } = req.body;
    try {
      await pool.query(
        `UPDATE lotes_estoque SET
           data_validade   = COALESCE($1, data_validade),
           quantidade_atual= COALESCE($2, quantidade_atual),
           observacao      = COALESCE($3, observacao),
           ativo           = COALESCE($4, ativo),
           atualizado_em   = NOW()
         WHERE id = $5`,
        [data_validade || null, quantidade_atual !== undefined ? parseFloat(quantidade_atual) : null,
         observacao || null, ativo !== undefined ? ativo : null, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao atualizar lote.' });
    }
  });

  // ── DELETE /api/lotes/:id ────────────────────────────────
  router.delete('/:id', autenticar(['admin','gerente']), async (req, res) => {
    try {
      await pool.query('UPDATE lotes_estoque SET ativo=false, atualizado_em=NOW() WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao remover lote.' });
    }
  });

  return router;
};
