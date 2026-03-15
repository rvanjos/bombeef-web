/**
 * routes/retiradas.js — M5: Retiradas de Funcionários
 *
 * Rotas:
 *   GET  /api/retiradas                       → lista retiradas
 *   POST /api/retiradas                       → lança retirada (verifica limite)
 *   PUT  /api/retiradas/:id                   → edita retirada
 *   DELETE /api/retiradas/:id                 → remove retirada
 *   GET  /api/retiradas/relatorio             → relatório mensal
 *   GET  /api/retiradas/limite/:funcionario_id → saldo do limite
 */

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS retiradas (
        id                SERIAL PRIMARY KEY,
        funcionario_id    INTEGER NOT NULL REFERENCES funcionarios(id),
        produto_id        INTEGER REFERENCES produtos(id),
        descricao         TEXT NOT NULL,
        qtd               NUMERIC(10,3) DEFAULT 1,
        preco_unitario    NUMERIC(10,4) DEFAULT 0,
        desconto_pct      NUMERIC(5,2) DEFAULT 100,
        valor_total       NUMERIC(10,2) DEFAULT 0,
        mes               TEXT NOT NULL,
        dt_retirada       DATE DEFAULT CURRENT_DATE,
        observacao        TEXT,
        autorizado_por    INTEGER REFERENCES usuarios(id),
        usuario_id        INTEGER,
        criado_em         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ret_funcionario  ON retiradas(funcionario_id);
      CREATE INDEX IF NOT EXISTS idx_ret_mes          ON retiradas(mes);
    `);
  }
  initTable().catch(e => console.error('[retiradas] initTable:', e.message));

  // ── Helper: calcula total do mês por funcionário ───────────────────────────
  async function totalMes(funcId, mes) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(valor_total), 0) AS total FROM retiradas WHERE funcionario_id = $1 AND mes = $2`,
      [funcId, mes]
    );
    return parseFloat(rows[0].total);
  }

  // ── GET /limite/:funcionario_id ────────────────────────────────────────────
  r.get('/limite/:funcionario_id', async (req, res) => {
    try {
      const { mes } = req.query;
      const mesRef = mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();

      const { rows: func } = await pool.query(
        `SELECT id, nome, limite_retirada FROM funcionarios WHERE id = $1`, [req.params.funcionario_id]
      );
      if (!func.length) return res.status(404).json({ ok: false, erro: 'Funcionário não encontrado' });

      const limite   = parseFloat(func[0].limite_retirada || 0);
      const usado    = await totalMes(func[0].id, mesRef);
      const saldo    = Math.max(0, limite - usado);
      const pct      = limite > 0 ? ((usado / limite) * 100).toFixed(1) : '0.0';

      res.json({ ok: true, data: {
        funcionario: func[0].nome, limite, usado, saldo,
        percentualUsado: parseFloat(pct), mes: mesRef,
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /relatorio ─────────────────────────────────────────────────────────
  r.get('/relatorio', async (req, res) => {
    try {
      const { mes, funcionario_id } = req.query;
      const mesRef = mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();

      const conds = [`ret.mes = $1`], params = [mesRef];
      if (funcionario_id) { params.push(parseInt(funcionario_id)); conds.push(`ret.funcionario_id = $${params.length}`); }

      const where = 'WHERE ' + conds.join(' AND ');

      // Resumo por funcionário
      const { rows: resumo } = await pool.query(`
        SELECT
          f.id, f.nome, f.limite_retirada,
          COUNT(ret.id) AS qtd_itens,
          COALESCE(SUM(ret.valor_total), 0) AS total_retirado,
          f.limite_retirada - COALESCE(SUM(ret.valor_total), 0) AS saldo
        FROM funcionarios f
        LEFT JOIN retiradas ret ON ret.funcionario_id = f.id AND ret.mes = $1
        WHERE f.ativo = true
        GROUP BY f.id, f.nome, f.limite_retirada
        ORDER BY total_retirado DESC
      `, [mesRef]);

      // Detalhes (se filtrado por funcionário)
      let detalhes = [];
      if (funcionario_id) {
        const { rows } = await pool.query(`
          SELECT ret.*, p.descricao AS prod_descricao
          FROM retiradas ret
          LEFT JOIN produtos p ON p.id = ret.produto_id
          ${where}
          ORDER BY ret.dt_retirada DESC
        `, params);
        detalhes = rows;
      }

      res.json({ ok: true, data: { mes: mesRef, resumo, detalhes, totalGeral: resumo.reduce((s, r) => s + parseFloat(r.total_retirado), 0) } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { mes, funcionario_id } = req.query;
      const conds = [], params = [];
      if (mes) { params.push(mes); conds.push(`ret.mes = $${params.length}`); }
      if (funcionario_id) { params.push(parseInt(funcionario_id)); conds.push(`ret.funcionario_id = $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(`
        SELECT ret.*, f.nome AS funcionario_nome, p.descricao AS prod_descricao
        FROM retiradas ret
        LEFT JOIN funcionarios f ON f.id = ret.funcionario_id
        LEFT JOIN produtos p ON p.id = ret.produto_id
        ${where}
        ORDER BY ret.dt_retirada DESC, ret.id DESC
      `, params);
      res.json({ ok: true, data: rows, total: rows.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const ret = req.body;
    if (!ret.funcionarioId || !ret.descricao) {
      return res.status(400).json({ ok: false, erro: 'funcionarioId e descricao obrigatórios' });
    }
    try {
      // Verifica funcionário e limite
      const { rows: func } = await pool.query(
        `SELECT id, nome, limite_retirada FROM funcionarios WHERE id = $1 AND ativo = true`,
        [ret.funcionarioId]
      );
      if (!func.length) return res.status(404).json({ ok: false, erro: 'Funcionário não encontrado' });

      const dtRetirada = ret.dtRetirada || new Date().toISOString().slice(0, 10);
      const mes        = ret.mes || (dtRetirada.slice(5, 7) + '/' + dtRetirada.slice(0, 4));

      // Calcula valor
      let precUnit = parseFloat(ret.precoUnitario || 0);
      if (!precUnit && ret.produtoId) {
        const prod = await pool.query(`SELECT preco_custo FROM produtos WHERE id = $1`, [ret.produtoId]);
        if (prod.rows.length) precUnit = parseFloat(prod.rows[0].preco_custo);
      }
      const qtd        = parseFloat(ret.qtd || 1);
      const descPct    = parseFloat(ret.descontoPct ?? 100);
      const valorTotal = parseFloat((precUnit * qtd * (1 - descPct / 100)).toFixed(2));

      // Verifica limite
      const limite = parseFloat(func[0].limite_retirada || 0);
      if (limite > 0) {
        const usado = await totalMes(ret.funcionarioId, mes);
        if (usado + valorTotal > limite) {
          return res.status(422).json({
            ok: false,
            erro: `Limite excedido. Usado: R$ ${usado.toFixed(2)} / Limite: R$ ${limite.toFixed(2)}`,
            saldo: Math.max(0, limite - usado),
          });
        }
      }

      const { rows } = await pool.query(`
        INSERT INTO retiradas
          (funcionario_id, produto_id, descricao, qtd, preco_unitario, desconto_pct,
           valor_total, mes, dt_retirada, observacao, autorizado_por, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [
        ret.funcionarioId, ret.produtoId || null, ret.descricao,
        qtd, precUnit, descPct, valorTotal, mes, dtRetirada,
        ret.observacao || null, ret.autorizadoPor || req.user.id, req.user.id,
      ]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const ret = req.body;
    try {
      await pool.query(`
        UPDATE retiradas SET
          descricao       = COALESCE($1, descricao),
          qtd             = COALESCE($2, qtd),
          preco_unitario  = COALESCE($3, preco_unitario),
          desconto_pct    = COALESCE($4, desconto_pct),
          valor_total     = COALESCE($5, valor_total),
          observacao      = COALESCE($6, observacao)
        WHERE id = $7
      `, [
        ret.descricao || null,
        ret.qtd       !== undefined ? parseFloat(ret.qtd) : null,
        ret.precoUnitario !== undefined ? parseFloat(ret.precoUnitario) : null,
        ret.descontoPct   !== undefined ? parseFloat(ret.descontoPct) : null,
        ret.valorTotal    !== undefined ? parseFloat(ret.valorTotal) : null,
        ret.observacao || null,
        parseInt(req.params.id),
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM retiradas WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
