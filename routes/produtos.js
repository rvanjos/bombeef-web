const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/produtos ────────────────────────────────────
  router.get('/', autenticar(), async (req, res) => {
    const { q, categoria, perecivel, ativo = 'true', limit = 300, offset = 0 } = req.query;
    const params = [];
    const where  = [];

    where.push(`ativo = $${params.push(ativo !== 'false')}`);
    if (q) {
      params.push(`%${q}%`);
      where.push(`(descricao_produto ILIKE $${params.length} OR codigo_produto ILIKE $${params.length})`);
    }
    if (categoria) where.push(`categoria = $${params.push(categoria)}`);
    if (perecivel !== undefined) where.push(`perecivel = $${params.push(perecivel === 'true')}`);

    try {
      const sql = `SELECT codigo_produto, descricao_produto, descricao_reduzida, categoria,
                          unidade, preco_custo, preco_venda, perecivel, controla_validade,
                          fornecedor_principal, ativo, data_ultima_importacao
                   FROM produtos_mestre
                   WHERE ${where.join(' AND ')}
                   ORDER BY descricao_produto
                   LIMIT $${params.push(parseInt(limit))} OFFSET $${params.push(parseInt(offset))}`;
      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      console.error('[produtos GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar produtos.' });
    }
  });

  // ── GET /api/produtos/categorias ────────────────────────
  router.get('/categorias', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT categoria FROM produtos_mestre
         WHERE ativo = true AND categoria IS NOT NULL
         ORDER BY categoria`
      );
      res.json(rows.map(r => r.categoria));
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar categorias.' });
    }
  });

  // ── GET /api/produtos/count ──────────────────────────────
  router.get('/count', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT COUNT(*) AS total FROM produtos_mestre WHERE ativo = true'
      );
      res.json({ total: parseInt(rows[0].total) });
    } catch (err) {
      res.status(500).json({ erro: 'Erro.' });
    }
  });

  // ── GET /api/produtos/:codigo ────────────────────────────
  router.get('/:codigo', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM produtos_mestre WHERE codigo_produto = $1',
        [req.params.codigo]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'Produto não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar produto.' });
    }
  });

  // ── PATCH /api/produtos/:codigo ──────────────────────────
  // Atualização manual de campos complementares (não-TOTVS)
  router.patch('/:codigo', autenticar(['admin','gerente','estoque']), async (req, res) => {
    const campos = ['perecivel','controla_validade','controla_lote','fornecedor_principal','ativo'];
    const sets   = [];
    const params = [];

    campos.forEach(c => {
      if (req.body[c] !== undefined) {
        params.push(req.body[c]);
        sets.push(`${c} = $${params.length}`);
      }
    });

    if (!sets.length) return res.status(400).json({ erro: 'Nenhum campo válido para atualizar.' });
    params.push(req.params.codigo);

    try {
      await pool.query(
        `UPDATE produtos_mestre SET ${sets.join(', ')}, atualizado_em=NOW() WHERE codigo_produto=$${params.length}`,
        params
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao atualizar produto.' });
    }
  });

  return router;
};
