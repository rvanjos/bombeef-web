const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/boletos ─────────────────────────────────────
  router.get('/', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    const { cnpj, status, periodo, limit = 200, offset = 0 } = req.query;
    const where  = ['1=1'];
    const params = [];

    if (cnpj)   where.push(`b.cnpj_fornecedor = $${params.push(cnpj)}`);
    if (status) where.push(`b.status = $${params.push(status)}`);
    if (periodo) {
      // periodo = YYYY-MM
      params.push(periodo);
      where.push(`TO_CHAR(b.data_vencimento, 'YYYY-MM') = $${params.length}`);
    }

    try {
      const { rows } = await pool.query(
        `SELECT b.*,
                COALESCE(f.nome_fantasia, f.razao_social, b.razao_social_fornecedor) AS fornecedor_nome,
                CURRENT_DATE - b.data_vencimento AS dias_atraso
         FROM boletos b
         LEFT JOIN fornecedores f ON f.cnpj_fornecedor = b.cnpj_fornecedor
         WHERE ${where.join(' AND ')}
         ORDER BY b.data_vencimento ASC
         LIMIT $${params.push(parseInt(limit))} OFFSET $${params.push(parseInt(offset))}`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('[boletos GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar boletos.' });
    }
  });

  // ── GET /api/boletos/abertos ─────────────────────────────
  router.get('/abertos', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM vw_boletos_abertos');
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar boletos abertos.' });
    }
  });

  // ── GET /api/boletos/resumo ──────────────────────────────
  router.get('/resumo', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pendente')                         AS pendentes,
           COUNT(*) FILTER (WHERE status = 'vencido')                          AS vencidos,
           COUNT(*) FILTER (WHERE status = 'pago')                             AS pagos_mes,
           COALESCE(SUM(valor) FILTER (WHERE status IN ('pendente','vencido')), 0) AS total_aberto,
           COALESCE(SUM(valor) FILTER (WHERE status = 'pago'
                                   AND DATE_TRUNC('month', data_pagamento) = DATE_TRUNC('month', NOW())), 0) AS total_pago_mes
         FROM boletos`
      );
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar resumo.' });
    }
  });

  // ── GET /api/boletos/:id ─────────────────────────────────
  router.get('/:id', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.*, COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor_nome
         FROM boletos b
         LEFT JOIN fornecedores f ON f.cnpj_fornecedor = b.cnpj_fornecedor
         WHERE b.id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'Boleto não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar boleto.' });
    }
  });

  // ── POST /api/boletos ────────────────────────────────────
  router.post('/', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    const {
      cnpj_fornecedor, razao_social_fornecedor, numero_documento, numero_nfe,
      data_emissao, data_vencimento, valor,
      classificacao_contabil, centro_custo, forma_pagamento, banco, observacao
    } = req.body;

    if (!data_vencimento || !valor)
      return res.status(400).json({ erro: 'data_vencimento e valor são obrigatórios.' });

    try {
      const { rows } = await pool.query(
        `INSERT INTO boletos
           (cnpj_fornecedor, razao_social_fornecedor, numero_documento, numero_nfe,
            data_emissao, data_vencimento, valor, classificacao_contabil,
            centro_custo, forma_pagamento, banco, observacao, usuario_lancamento)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          cnpj_fornecedor || null, razao_social_fornecedor || null,
          numero_documento || null, numero_nfe || null,
          data_emissao || null, data_vencimento,
          parseFloat(valor),
          classificacao_contabil || null, centro_custo || null,
          forma_pagamento || null, banco || null, observacao || null,
          req.usuario.id,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('[boletos POST]', err.message);
      res.status(500).json({ erro: 'Erro ao criar boleto.' });
    }
  });

  // ── PATCH /api/boletos/:id/pagar ─────────────────────────
  router.patch('/:id/pagar', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    const { data_pagamento, forma_pagamento } = req.body;
    try {
      await pool.query(
        `UPDATE boletos SET
           status = 'pago',
           data_pagamento = $1,
           forma_pagamento = COALESCE($2, forma_pagamento),
           atualizado_em = NOW()
         WHERE id = $3`,
        [data_pagamento || new Date().toISOString().split('T')[0],
         forma_pagamento || null, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao registrar pagamento.' });
    }
  });

  // ── PUT /api/boletos/:id ─────────────────────────────────
  router.put('/:id', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    const {
      cnpj_fornecedor, numero_documento, numero_nfe, data_emissao, data_vencimento,
      valor, status, classificacao_contabil, centro_custo, observacao
    } = req.body;
    try {
      await pool.query(
        `UPDATE boletos SET
           cnpj_fornecedor        = COALESCE($1, cnpj_fornecedor),
           numero_documento       = COALESCE($2, numero_documento),
           numero_nfe             = COALESCE($3, numero_nfe),
           data_emissao           = COALESCE($4, data_emissao),
           data_vencimento        = COALESCE($5, data_vencimento),
           valor                  = COALESCE($6, valor),
           status                 = COALESCE($7, status),
           classificacao_contabil = COALESCE($8, classificacao_contabil),
           centro_custo           = COALESCE($9, centro_custo),
           observacao             = COALESCE($10, observacao),
           atualizado_em = NOW()
         WHERE id = $11`,
        [cnpj_fornecedor||null, numero_documento||null, numero_nfe||null,
         data_emissao||null, data_vencimento||null,
         valor ? parseFloat(valor) : null, status||null,
         classificacao_contabil||null, centro_custo||null, observacao||null,
         req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao atualizar boleto.' });
    }
  });

  // ── DELETE /api/boletos/:id ──────────────────────────────
  router.delete('/:id', autenticar(['admin','gerente']), async (req, res) => {
    try {
      await pool.query(`UPDATE boletos SET status='cancelado', atualizado_em=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao cancelar boleto.' });
    }
  });

  return router;
};
