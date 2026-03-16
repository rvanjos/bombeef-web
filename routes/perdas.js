/**
 * routes/perdas.js — M4: Perdas e Metas
 *
 * Rotas:
 *   GET    /api/perdas              → lista perdas
 *   POST   /api/perdas              → registra perda
 *   PUT    /api/perdas/:id          → edita perda
 *   DELETE /api/perdas/:id          → remove perda
 *   GET    /api/perdas/meta/:mes    → status da meta de perda no mês
 *   GET    /api/perdas/ranking      → ranking de perdas por funcionário
 */

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS perdas (
        id                SERIAL PRIMARY KEY,
        validade_item_id  INTEGER,
        produto_id        INTEGER,
        descricao         TEXT NOT NULL,
        motivo            TEXT DEFAULT 'vencimento',
        qtd_unidades      INTEGER DEFAULT 0,
        valor_perda       NUMERIC(10,2) DEFAULT 0,
        funcionario_id    INTEGER,
        dt_perda          DATE DEFAULT CURRENT_DATE,
        mes               TEXT,
        observacao        TEXT,
        usuario_id        INTEGER,
        criado_em         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Garante colunas novas
    const cols = [
      ['mes',               'TEXT'],
      ['motivo',            "TEXT DEFAULT 'vencimento'"],
      ['validade_item_id',  'INTEGER'],
      ['produto_id',        'INTEGER'],
      ['funcionario_id',    'INTEGER'],
      ['qtd_unidades',      'INTEGER DEFAULT 0'],
      ['valor_perda',       'NUMERIC(10,2) DEFAULT 0'],
    ];
    for (const [col, def] of cols) {
      await pool.query(
        `ALTER TABLE perdas ADD COLUMN IF NOT EXISTS ${col} ${def}`
      ).catch(() => {});
    }
    // Popula coluna mes nos registros antigos que não têm
    await pool.query(`
      UPDATE perdas SET mes = TO_CHAR(dt_perda, 'MM/YYYY')
      WHERE mes IS NULL AND dt_perda IS NOT NULL
    `).catch(() => {});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_perdas_mes         ON perdas(mes);
      CREATE INDEX IF NOT EXISTS idx_perdas_funcionario ON perdas(funcionario_id);
      CREATE INDEX IF NOT EXISTS idx_perdas_dt          ON perdas(dt_perda);
    `).catch(() => {});
  }
  initTable().catch(e => console.error('[perdas] initTable:', e.message));

  // ── GET /meta/:mes ─────────────────────────────────────────────────────────
  r.get('/meta/:mes(*)', async (req, res) => {
    try {
      const mes = req.params.mes; // MM/YYYY

      // Total de perdas do mês
      const { rows: perdas } = await pool.query(
        `SELECT COALESCE(SUM(valor_perda), 0) AS total FROM perdas WHERE mes = $1`, [mes]
      );
      const totalPerdas = parseFloat(perdas[0].total);

      // Meta do mês
      const { rows: metas } = await pool.query(
        `SELECT faturamento_real, meta_perda_pct FROM metas WHERE mes = $1 LIMIT 1`, [mes]
      );
      const meta = metas[0] || {};
      const faturamento  = parseFloat(meta.faturamento_real || 0);
      const metaPct      = parseFloat(meta.meta_perda_pct || 0);
      const metaValor    = faturamento > 0 ? (faturamento * metaPct / 100) : 0;
      const perdaPct     = faturamento > 0 ? (totalPerdas / faturamento * 100) : 0;

      res.json({
        ok: true, data: {
          mes,
          totalPerdas,
          faturamento,
          metaPct,
          metaValor,
          perdaPct: parseFloat(perdaPct.toFixed(2)),
          dentroMeta: metaValor === 0 ? null : totalPerdas <= metaValor,
        }
      });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /ranking ───────────────────────────────────────────────────────────
  r.get('/ranking', async (req, res) => {
    try {
      const { mes } = req.query;
      const conds = [], params = [];
      if (mes) { params.push(mes); conds.push(`p.mes = $${params.length}`); }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      const { rows } = await pool.query(`
        SELECT
          f.id AS funcionario_id, f.nome,
          COUNT(p.id) AS total_ocorrencias,
          COALESCE(SUM(p.valor_perda), 0) AS total_valor,
          COALESCE(SUM(p.qtd_unidades), 0) AS total_unidades
        FROM funcionarios f
        LEFT JOIN perdas p ON p.funcionario_id = f.id ${where}
        WHERE f.ativo = true
        GROUP BY f.id, f.nome
        ORDER BY total_valor DESC
      `, params);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { mes, funcionario_id, motivo } = req.query;
      const conds = [], params = [];
      if (mes) { params.push(mes); conds.push(`p.mes = $${params.length}`); }
      if (funcionario_id) { params.push(parseInt(funcionario_id)); conds.push(`p.funcionario_id = $${params.length}`); }
      if (motivo) { params.push(motivo); conds.push(`p.motivo = $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(`
        SELECT p.*, f.nome AS funcionario_nome, pr.descricao AS produto_descricao
        FROM perdas p
        LEFT JOIN funcionarios f ON f.id = p.funcionario_id
        LEFT JOIN produtos pr ON pr.id = p.produto_id
        ${where}
        ORDER BY p.dt_perda DESC, p.id DESC
      `, params);
      res.json({ ok: true, data: rows, total: rows.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const p = req.body;
    if (!p.descricao) return res.status(400).json({ ok: false, erro: 'descricao obrigatória' });
    try {
      // Calcula valor se não informado (custo × qtd)
      let valor = parseFloat(p.valorPerda || 0);
      if (!valor && p.produtoId && p.qtdUnidades) {
        const prod = await pool.query(`SELECT preco_custo FROM produtos WHERE id = $1`, [p.produtoId]);
        if (prod.rows.length) valor = parseFloat(prod.rows[0].preco_custo) * parseInt(p.qtdUnidades);
      }

      const dtPerda = p.dtPerda || new Date().toISOString().slice(0, 10);
      const mes     = p.mes || (dtPerda.slice(5, 7) + '/' + dtPerda.slice(0, 4));

      const { rows } = await pool.query(`
        INSERT INTO perdas
          (validade_item_id, produto_id, descricao, motivo, qtd_unidades,
           valor_perda, funcionario_id, dt_perda, mes, observacao, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        p.validadeItemId || null, p.produtoId || null, p.descricao,
        p.motivo || 'vencimento', parseInt(p.qtdUnidades || 0),
        valor, p.funcionarioId || null, dtPerda, mes, p.observacao || null, req.user.id,
      ]);

      // Se veio de validade_item, marca como descartado
      if (p.validadeItemId) {
        await pool.query(
          `UPDATE validade_items SET status='descartado', atualizado_em=NOW() WHERE id=$1`,
          [p.validadeItemId]
        );
      }

      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const p = req.body;
    try {
      await pool.query(`
        UPDATE perdas SET
          descricao       = COALESCE($1, descricao),
          motivo          = COALESCE($2, motivo),
          qtd_unidades    = COALESCE($3, qtd_unidades),
          valor_perda     = COALESCE($4, valor_perda),
          funcionario_id  = COALESCE($5, funcionario_id),
          dt_perda        = COALESCE($6, dt_perda),
          observacao      = COALESCE($7, observacao)
        WHERE id = $8
      `, [
        p.descricao || null, p.motivo || null,
        p.qtdUnidades !== undefined ? parseInt(p.qtdUnidades) : null,
        p.valorPerda  !== undefined ? parseFloat(p.valorPerda) : null,
        p.funcionarioId || null, p.dtPerda || null, p.observacao || null,
        parseInt(req.params.id),
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM perdas WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
