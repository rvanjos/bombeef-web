const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Garante tabela
  pool.query(`
    CREATE TABLE IF NOT EXISTS fornecedores (
      id               SERIAL PRIMARY KEY,
      cnpj_fornecedor  TEXT UNIQUE,
      razao_social     TEXT NOT NULL,
      nome_fantasia    TEXT,
      contato          TEXT,
      telefone         TEXT,
      email            TEXT,
      endereco         TEXT,
      categoria_padrao TEXT,
      observacao       TEXT,
      ativo            BOOLEAN DEFAULT true,
      criado_em        TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(()=>{});

  // ── GET /api/fornecedores ────────────────────────────────
  router.get('/', autenticar(), async (req, res) => {
    const { q, ativo = 'true' } = req.query;
    const params = [ativo !== 'false'];
    let where = 'ativo = $1';

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (razao_social ILIKE $${params.length} OR nome_fantasia ILIKE $${params.length} OR cnpj_fornecedor LIKE $${params.length})`;
    }

    try {
      const { rows } = await pool.query(
        `SELECT * FROM fornecedores WHERE ${where} ORDER BY COALESCE(nome_fantasia, razao_social)`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('[fornecedores GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar fornecedores.' });
    }
  });

  // ── GET /api/fornecedores/:cnpj ──────────────────────────
  router.get('/:cnpj', autenticar(), async (req, res) => {
    try {
      const cnpj = req.params.cnpj.replace(/\D/g, '');
      const { rows } = await pool.query(
        'SELECT * FROM fornecedores WHERE cnpj_fornecedor = $1',
        [cnpj]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar fornecedor.' });
    }
  });

  // ── POST /api/fornecedores ───────────────────────────────
  router.post('/', autenticar(), async (req, res) => {
    const {
      cnpj_fornecedor, razao_social, nome_fantasia,
      contato, telefone, email, endereco, categoria_padrao, observacao
    } = req.body;

    if (!cnpj_fornecedor || !razao_social)
      return res.status(400).json({ erro: 'cnpj_fornecedor e razao_social são obrigatórios.' });

    const cnpj = cnpj_fornecedor.replace(/\D/g, '');
    if (cnpj.length !== 14)
      return res.status(400).json({ erro: 'CNPJ inválido. Use 14 dígitos.' });

    try {
      const { rows } = await pool.query(
        `INSERT INTO fornecedores
           (cnpj_fornecedor, razao_social, nome_fantasia, contato, telefone,
            email, endereco, categoria_padrao, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [cnpj, razao_social.trim(), nome_fantasia||null, contato||null,
         telefone||null, email||null, endereco||null, categoria_padrao||null, observacao||null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ erro: 'CNPJ já cadastrado.' });
      console.error('[fornecedores POST]', err.message);
      res.status(500).json({ erro: 'Erro ao criar fornecedor.' });
    }
  });

  // ── PUT /api/fornecedores/:cnpj ──────────────────────────
  router.put('/:cnpj', autenticar(), async (req, res) => {
    const {
      razao_social, nome_fantasia, contato, telefone,
      email, endereco, categoria_padrao, observacao, ativo
    } = req.body;
    const cnpj = req.params.cnpj.replace(/\D/g, '');

    try {
      await pool.query(
        `UPDATE fornecedores SET
           razao_social    = COALESCE($1, razao_social),
           nome_fantasia   = COALESCE($2, nome_fantasia),
           contato         = COALESCE($3, contato),
           telefone        = COALESCE($4, telefone),
           email           = COALESCE($5, email),
           endereco        = COALESCE($6, endereco),
           categoria_padrao= COALESCE($7, categoria_padrao),
           observacao      = COALESCE($8, observacao),
           ativo           = COALESCE($9, ativo),
           atualizado_em   = NOW()
         WHERE cnpj_fornecedor = $10`,
        [razao_social||null, nome_fantasia||null, contato||null, telefone||null,
         email||null, endereco||null, categoria_padrao||null, observacao||null,
         ativo !== undefined ? ativo : null, cnpj]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao atualizar fornecedor.' });
    }
  });

  // ── GET /api/fornecedores/:cnpj/boletos ──────────────────
  router.get('/:cnpj/boletos', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    try {
      const { rows } = await pool.query(
        `SELECT * FROM boletos WHERE cnpj_fornecedor = $1 ORDER BY data_vencimento DESC LIMIT 50`,
        [cnpj]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar boletos do fornecedor.' });
    }
  });

  return router;
};
