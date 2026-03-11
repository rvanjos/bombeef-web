const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/kits ────────────────────────────────────────
  router.get('/', autenticar(), async (req, res) => {
    const { ativo = 'true' } = req.query;
    try {
      const { rows } = await pool.query(
        `SELECT k.*,
                COUNT(ki.id) AS total_itens,
                u.nome AS criado_por
         FROM kits k
         LEFT JOIN kit_itens ki ON ki.id_kit = k.id_kit
         LEFT JOIN usuarios u ON u.id = k.usuario_criacao
         WHERE k.ativo = $1
         GROUP BY k.id_kit, u.nome
         ORDER BY k.criado_em DESC`,
        [ativo !== 'false']
      );
      res.json(rows);
    } catch (err) {
      console.error('[kits GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar kits.' });
    }
  });

  // ── GET /api/kits/:id ────────────────────────────────────
  router.get('/:id', autenticar(), async (req, res) => {
    try {
      const kitQ = pool.query('SELECT * FROM kits WHERE id_kit = $1', [req.params.id]);
      const itensQ = pool.query(
        `SELECT ki.*,
                p.descricao_produto, p.categoria, p.unidade,
                p.preco_custo AS custo_atual, p.preco_venda AS venda_atual,
                (SELECT MIN(data_validade) FROM lotes_estoque
                 WHERE codigo_produto = ki.codigo_produto AND quantidade_atual > 0 AND ativo = true) AS proxima_validade,
                (SELECT SUM(quantidade_atual) FROM lotes_estoque
                 WHERE codigo_produto = ki.codigo_produto AND ativo = true) AS estoque_disponivel
         FROM kit_itens ki
         JOIN produtos_mestre p ON p.codigo_produto = ki.codigo_produto
         WHERE ki.id_kit = $1
         ORDER BY p.descricao_produto`,
        [req.params.id]
      );

      const [{ rows: [kit] }, { rows: itens }] = await Promise.all([kitQ, itensQ]);
      if (!kit) return res.status(404).json({ erro: 'Kit não encontrado.' });
      res.json({ ...kit, itens });
    } catch (err) {
      console.error('[kits GET /:id]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar kit.' });
    }
  });

  // ── POST /api/kits ───────────────────────────────────────
  router.post('/', autenticar(['admin','gerente']), async (req, res) => {
    const { nome_kit, tipo_kit, descricao, preco_venda, itens = [] } = req.body;
    if (!nome_kit) return res.status(400).json({ erro: 'nome_kit é obrigatório.' });
    if (!itens.length) return res.status(400).json({ erro: 'Kit precisa ter pelo menos 1 item.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [kit] } = await client.query(
        `INSERT INTO kits (nome_kit, tipo_kit, descricao, preco_venda, usuario_criacao)
         VALUES ($1,$2,$3,$4,$5) RETURNING id_kit`,
        [nome_kit, tipo_kit || 'Kit Churrasco', descricao || null,
         preco_venda ? parseFloat(preco_venda) : null, req.usuario.id]
      );

      for (const item of itens) {
        if (!item.codigo_produto || !item.quantidade) continue;
        await client.query(
          `INSERT INTO kit_itens (id_kit, codigo_produto, quantidade, custo_unitario)
           VALUES ($1,$2,$3,$4)`,
          [kit.id_kit, item.codigo_produto, parseFloat(item.quantidade),
           item.custo_unitario ? parseFloat(item.custo_unitario) : null]
        );
      }

      await client.query('COMMIT');

      const { rows: [kitFinal] } = await pool.query('SELECT * FROM kits WHERE id_kit=$1', [kit.id_kit]);
      res.status(201).json(kitFinal);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(400).json({ erro: 'Produto duplicado no kit.' });
      console.error('[kits POST]', err.message);
      res.status(500).json({ erro: 'Erro ao criar kit.' });
    } finally {
      client.release();
    }
  });

  // ── PUT /api/kits/:id ────────────────────────────────────
  router.put('/:id', autenticar(['admin','gerente']), async (req, res) => {
    const { nome_kit, tipo_kit, descricao, preco_venda, ativo, itens } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE kits SET
           nome_kit    = COALESCE($1, nome_kit),
           tipo_kit    = COALESCE($2, tipo_kit),
           descricao   = COALESCE($3, descricao),
           preco_venda = COALESCE($4, preco_venda),
           ativo       = COALESCE($5, ativo),
           atualizado_em = NOW()
         WHERE id_kit = $6`,
        [nome_kit || null, tipo_kit || null, descricao || null,
         preco_venda !== undefined ? parseFloat(preco_venda) : null,
         ativo !== undefined ? ativo : null, req.params.id]
      );

      // Se itens fornecidos, substituir
      if (itens) {
        await client.query('DELETE FROM kit_itens WHERE id_kit = $1', [req.params.id]);
        for (const item of itens) {
          if (!item.codigo_produto || !item.quantidade) continue;
          await client.query(
            `INSERT INTO kit_itens (id_kit, codigo_produto, quantidade, custo_unitario)
             VALUES ($1,$2,$3,$4)`,
            [req.params.id, item.codigo_produto, parseFloat(item.quantidade),
             item.custo_unitario ? parseFloat(item.custo_unitario) : null]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ erro: 'Erro ao atualizar kit.' });
    } finally {
      client.release();
    }
  });

  // ── DELETE /api/kits/:id ─────────────────────────────────
  router.delete('/:id', autenticar(['admin','gerente']), async (req, res) => {
    try {
      await pool.query('UPDATE kits SET ativo=false, atualizado_em=NOW() WHERE id_kit=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao remover kit.' });
    }
  });

  return router;
};
