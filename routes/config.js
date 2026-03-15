/**
 * routes/config.js — M6: Configurações do Sistema
 *
 * Rotas:
 *   GET/POST/PUT/DELETE /api/config/funcionarios   → CRUD funcionários
 *   GET/POST/PUT        /api/config/metas          → CRUD metas mensais
 *   GET/POST/PUT/DELETE /api/config/categorias     → CRUD categorias DRE
 *   GET/PUT             /api/config/sistema        → configurações gerais
 */

const express    = require('express');
const autenticar = require('../middleware/auth');
const { requireNivel } = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabelas ───────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS funcionarios (
        id                SERIAL PRIMARY KEY,
        nome              TEXT NOT NULL,
        cargo             TEXT,
        email             TEXT,
        telefone          TEXT,
        limite_retirada   NUMERIC(10,2) DEFAULT 0,
        usuario_id        INTEGER REFERENCES usuarios(id),
        ativo             BOOLEAN DEFAULT true,
        criado_em         TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metas (
        id                  SERIAL PRIMARY KEY,
        mes                 TEXT UNIQUE NOT NULL,
        faturamento_meta    NUMERIC(14,2) DEFAULT 0,
        faturamento_real    NUMERIC(14,2) DEFAULT 0,
        meta_perda_pct      NUMERIC(5,2) DEFAULT 2,
        meta_retiradas      NUMERIC(14,2) DEFAULT 0,
        observacao          TEXT,
        criado_em           TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categorias_dre (
        id              SERIAL PRIMARY KEY,
        grupo           TEXT NOT NULL,
        subgrupo        TEXT NOT NULL,
        label_exibicao  TEXT,
        ordem           INTEGER DEFAULT 0,
        ativo           BOOLEAN DEFAULT true
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_sistema (
        chave   TEXT PRIMARY KEY,
        valor   TEXT,
        descricao TEXT
      )
    `);

    // Insere categorias DRE padrão
    await pool.query(`
      INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem) VALUES
        ('RECEITAS',   'Faturamento Bruto',              'Faturamento Bruto', 1),
        ('RECEITAS',   'Outros Créditos',                'Outros Créditos', 2),
        ('CMV',        'COMPRAS - REVENDA',              'Compras para Revenda', 10),
        ('CMV',        'Material de Embalagens',         'Embalagens', 11),
        ('DESPESAS',   'Salários e Encargos',            'Salários', 20),
        ('DESPESAS',   'Aluguel',                        'Aluguel', 21),
        ('DESPESAS',   'Energia e Água',                 'Energia e Água', 22),
        ('DESPESAS',   'Marketing e Publicidade',        'Marketing', 23),
        ('DESPESAS',   'Serviços prestados por terceiros','Terceiros', 24),
        ('DESPESAS',   'Materiais diversos',             'Materiais', 25),
        ('DESPESAS',   'Taxas e Impostos',               'Taxas/Impostos', 26),
        ('DESPESAS',   'Manutenção',                     'Manutenção', 27),
        ('DESPESAS',   'Outras Despesas',                'Outras Desp.', 28),
        ('FINANCEIRO', 'Empréstimos e Financiamentos',   'Empréstimos', 30),
        ('FINANCEIRO', 'Juros e Tarifas Bancárias',      'Juros/Tarifas', 31)
      ON CONFLICT DO NOTHING
    `);

    // Config padrão
    await pool.query(`
      INSERT INTO config_sistema (chave, valor, descricao) VALUES
        ('nome_empresa',    'Bom Beef',         'Nome da empresa'),
        ('logo_emoji',      '🥩',               'Emoji do logo'),
        ('dias_alerta_val', '7',                'Dias de antecedência para alerta de validade'),
        ('taxa_desconto_fun','100',             'Desconto padrão para retiradas de funcionários (%)'),
        ('fuso_horario',    'America/Sao_Paulo','Fuso horário do sistema')
      ON CONFLICT (chave) DO NOTHING
    `);
  }
  initTable().catch(e => console.error('[config] initTable:', e.message));

  // ══════════════════════════════════════════════════════════════════════
  // FUNCIONÁRIOS
  // ══════════════════════════════════════════════════════════════════════

  r.get('/funcionarios', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT f.*, u.email AS usuario_email
        FROM funcionarios f
        LEFT JOIN usuarios u ON u.id = f.usuario_id
        ORDER BY f.nome ASC
      `);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/funcionarios', requireNivel('gestor'), async (req, res) => {
    const f = req.body;
    if (!f.nome) return res.status(400).json({ ok: false, erro: 'nome obrigatório' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO funcionarios (nome, cargo, email, telefone, limite_retirada, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [f.nome.trim(), f.cargo || null, f.email || null, f.telefone || null,
          parseFloat(f.limiteRetirada || 0), f.usuarioId || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/funcionarios/:id', requireNivel('gestor'), async (req, res) => {
    const f = req.body;
    try {
      await pool.query(`
        UPDATE funcionarios SET
          nome              = COALESCE($1, nome),
          cargo             = COALESCE($2, cargo),
          email             = COALESCE($3, email),
          telefone          = COALESCE($4, telefone),
          limite_retirada   = COALESCE($5, limite_retirada),
          usuario_id        = COALESCE($6, usuario_id),
          ativo             = COALESCE($7, ativo),
          atualizado_em     = NOW()
        WHERE id = $8
      `, [
        f.nome || null, f.cargo || null, f.email || null, f.telefone || null,
        f.limiteRetirada !== undefined ? parseFloat(f.limiteRetirada) : null,
        f.usuarioId || null, f.ativo !== undefined ? f.ativo : null,
        parseInt(req.params.id),
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.delete('/funcionarios/:id', autenticar('admin'), async (req, res) => {
    try {
      await pool.query(`UPDATE funcionarios SET ativo = false, atualizado_em = NOW() WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // METAS
  // ══════════════════════════════════════════════════════════════════════

  r.get('/metas', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM metas ORDER BY mes DESC`);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/metas/:mes', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM metas WHERE mes = $1`, [req.params.mes]);
      const mes = req.params.mes;
      if (!rows.length) {
        // Retorna estrutura vazia com o mês
        return res.json({ ok: true, data: { mes, faturamento_meta: 0, faturamento_real: 0, meta_perda_pct: 2, meta_retiradas: 0 } });
      }
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/metas', requireNivel('gestor'), async (req, res) => {
    const m = req.body;
    if (!m.mes) return res.status(400).json({ ok: false, erro: 'mes obrigatório (MM/YYYY)' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO metas (mes, faturamento_meta, faturamento_real, meta_perda_pct, meta_retiradas, observacao)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (mes) DO UPDATE SET
          faturamento_meta  = EXCLUDED.faturamento_meta,
          faturamento_real  = EXCLUDED.faturamento_real,
          meta_perda_pct    = EXCLUDED.meta_perda_pct,
          meta_retiradas    = EXCLUDED.meta_retiradas,
          observacao        = EXCLUDED.observacao,
          atualizado_em     = NOW()
        RETURNING *
      `, [m.mes, parseFloat(m.faturamentoMeta || 0), parseFloat(m.faturamentoReal || 0),
          parseFloat(m.metaPerdaPct || 2), parseFloat(m.metaRetiradas || 0), m.observacao || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // CATEGORIAS DRE
  // ══════════════════════════════════════════════════════════════════════

  r.get('/categorias', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM categorias_dre WHERE ativo = true ORDER BY grupo, ordem, subgrupo`
      );
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/categorias', requireNivel('gestor'), async (req, res) => {
    const c = req.body;
    if (!c.grupo || !c.subgrupo) return res.status(400).json({ ok: false, erro: 'grupo e subgrupo obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem)
        VALUES ($1,$2,$3,$4) RETURNING *
      `, [c.grupo, c.subgrupo, c.labelExibicao || c.subgrupo, parseInt(c.ordem || 99)]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/categorias/:id', requireNivel('gestor'), async (req, res) => {
    const c = req.body;
    try {
      await pool.query(`
        UPDATE categorias_dre SET
          grupo           = COALESCE($1, grupo),
          subgrupo        = COALESCE($2, subgrupo),
          label_exibicao  = COALESCE($3, label_exibicao),
          ordem           = COALESCE($4, ordem),
          ativo           = COALESCE($5, ativo)
        WHERE id = $6
      `, [c.grupo || null, c.subgrupo || null, c.labelExibicao || null,
          c.ordem !== undefined ? parseInt(c.ordem) : null,
          c.ativo !== undefined ? c.ativo : null,
          parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.delete('/categorias/:id', autenticar('admin'), async (req, res) => {
    try {
      await pool.query(`UPDATE categorias_dre SET ativo = false WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // CONFIG SISTEMA
  // ══════════════════════════════════════════════════════════════════════

  r.get('/sistema', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT chave, valor FROM config_sistema`);
      const cfg = {};
      rows.forEach(r => { cfg[r.chave] = r.valor; });
      res.json({ ok: true, data: cfg });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/sistema', requireNivel('admin'), async (req, res) => {
    const updates = req.body; // { chave: valor, ... }
    try {
      for (const [chave, valor] of Object.entries(updates)) {
        await pool.query(`
          INSERT INTO config_sistema (chave, valor) VALUES ($1, $2)
          ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
        `, [chave, String(valor)]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
