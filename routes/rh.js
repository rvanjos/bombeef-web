/**
 * routes/rh.js — Módulo de RH (apenas admin)
 *
 * Tabelas:
 *   rh_fichas       — ficha mensal por funcionário (salário, VA, etc.)
 *   rh_apontamentos — horas extras, feriados, faltas, escalas
 *   rh_pagamentos   — entregas, grelhados, outros recebimentos
 */

const express = require('express');
const autenticar = require('../middleware/auth');
const { requireNivel } = autenticar;

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // Apenas admin
  r.use((req, res, next) => {
    if (req.user?.perfil !== 'admin')
      return res.status(403).json({ ok: false, erro: 'Acesso restrito ao administrador' });
    next();
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_fichas (
        id                  SERIAL PRIMARY KEY,
        funcionario_id      INTEGER NOT NULL,
        mes_ref             TEXT NOT NULL,           -- MM/YYYY
        salario_base        NUMERIC(10,2) DEFAULT 0,
        vale_alimentacao    NUMERIC(10,2) DEFAULT 0,
        escala_domingo      INTEGER DEFAULT 0,       -- qtd domingos trabalhados
        valor_domingo       NUMERIC(10,2) DEFAULT 0, -- valor por domingo
        observacao          TEXT,
        criado_em           TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(funcionario_id, mes_ref)
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_apontamentos (
        id                  SERIAL PRIMARY KEY,
        funcionario_id      INTEGER NOT NULL,
        mes_ref             TEXT NOT NULL,
        tipo                TEXT NOT NULL CHECK (tipo IN ('hora_extra','feriado','falta','desconto','bonus','outro')),
        descricao           TEXT,
        quantidade          NUMERIC(6,2) DEFAULT 0,  -- horas ou dias
        valor_unitario      NUMERIC(10,2) DEFAULT 0,
        valor_total         NUMERIC(10,2) DEFAULT 0,
        data_ref            DATE,
        criado_em           TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_pagamentos (
        id                  SERIAL PRIMARY KEY,
        funcionario_id      INTEGER NOT NULL,
        mes_ref             TEXT NOT NULL,
        tipo                TEXT NOT NULL CHECK (tipo IN ('entrega','grelhado','comissao','outro')),
        descricao           TEXT,
        valor               NUMERIC(10,2) DEFAULT 0,
        data_ref            DATE,
        criado_em           TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Adiciona colunas extras em funcionarios se não existirem
    for (const [col, def] of [
      ['cargo', 'TEXT'],
      ['salario_base', 'NUMERIC(10,2) DEFAULT 0'],
      ['vale_alimentacao', 'NUMERIC(10,2) DEFAULT 0'],
    ]) await pool.query(`ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
  }
  // Aguarda 2s para garantir que config.js já criou a tabela funcionarios
  setTimeout(() => {
    initTables().catch(e => console.error('[rh] initTables:', e.message));
  }, 2000);

  // ── GET /funcionarios — lista com dados base ───────────────────────────────
  r.get('/funcionarios', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT f.id, f.nome, f.cargo, f.email, f.telefone,
               f.salario_base, f.vale_alimentacao, f.limite_retirada, f.ativo
        FROM funcionarios f
        WHERE f.ativo = true
        ORDER BY f.nome ASC
      `);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /ficha?funcionario_id=X&mes=MM/YYYY ────────────────────────────────
  r.get('/ficha', async (req, res) => {
    const { funcionario_id, mes } = req.query;
    if (!funcionario_id || !mes) return res.status(400).json({ ok: false, erro: 'funcionario_id e mes obrigatórios' });
    try {
      // Ficha base
      const { rows: fichas } = await pool.query(`
        SELECT * FROM rh_fichas WHERE funcionario_id = $1 AND mes_ref = $2
      `, [funcionario_id, mes]);

      // Apontamentos
      const { rows: apontamentos } = await pool.query(`
        SELECT * FROM rh_apontamentos
        WHERE funcionario_id = $1 AND mes_ref = $2
        ORDER BY data_ref ASC, id ASC
      `, [funcionario_id, mes]);

      // Pagamentos extras
      const { rows: pagamentos } = await pool.query(`
        SELECT * FROM rh_pagamentos
        WHERE funcionario_id = $1 AND mes_ref = $2
        ORDER BY data_ref ASC, id ASC
      `, [funcionario_id, mes]);

      // Retiradas do mês
      const { rows: retiradas } = await pool.query(`
        SELECT COALESCE(SUM(valor_total), 0) AS total
        FROM retiradas WHERE funcionario_id = $1 AND mes = $2
      `, [funcionario_id, mes]);

      // Dados base do funcionário
      const { rows: func } = await pool.query(`
        SELECT id, nome, cargo,
               COALESCE(salario_base, 0) AS salario_base,
               COALESCE(vale_alimentacao, 0) AS vale_alimentacao,
               limite_retirada
        FROM funcionarios WHERE id = $1
      `, [funcionario_id]);

      res.json({
        ok: true,
        funcionario: func[0] || null,
        ficha: fichas[0] || null,
        apontamentos,
        pagamentos,
        total_retiradas: parseFloat(retiradas[0]?.total || 0),
      });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /ficha — cria ou atualiza ficha mensal ────────────────────────────
  r.post('/ficha', async (req, res) => {
    const { funcionario_id, mes_ref, salario_base, vale_alimentacao,
            escala_domingo, valor_domingo, observacao } = req.body;
    if (!funcionario_id || !mes_ref) return res.status(400).json({ ok: false, erro: 'funcionario_id e mes_ref obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO rh_fichas
          (funcionario_id, mes_ref, salario_base, vale_alimentacao, escala_domingo, valor_domingo, observacao, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (funcionario_id, mes_ref) DO UPDATE SET
          salario_base     = $3,
          vale_alimentacao = $4,
          escala_domingo   = $5,
          valor_domingo    = $6,
          observacao       = $7,
          atualizado_em    = NOW()
        RETURNING *
      `, [funcionario_id, mes_ref,
          parseFloat(salario_base || 0), parseFloat(vale_alimentacao || 0),
          parseInt(escala_domingo || 0), parseFloat(valor_domingo || 0),
          observacao || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /apontamento ──────────────────────────────────────────────────────
  r.post('/apontamento', async (req, res) => {
    const { funcionario_id, mes_ref, tipo, descricao, quantidade, valor_unitario, data_ref } = req.body;
    if (!funcionario_id || !mes_ref || !tipo) return res.status(400).json({ ok: false, erro: 'funcionario_id, mes_ref e tipo obrigatórios' });
    const qtd = parseFloat(quantidade || 0);
    const vUnit = parseFloat(valor_unitario || 0);
    try {
      const { rows } = await pool.query(`
        INSERT INTO rh_apontamentos
          (funcionario_id, mes_ref, tipo, descricao, quantidade, valor_unitario, valor_total, data_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
      `, [funcionario_id, mes_ref, tipo, descricao || null, qtd, vUnit, qtd * vUnit, data_ref || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /apontamento/:id ────────────────────────────────────────────────
  r.delete('/apontamento/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM rh_apontamentos WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /pagamento ────────────────────────────────────────────────────────
  r.post('/pagamento', async (req, res) => {
    const { funcionario_id, mes_ref, tipo, descricao, valor, data_ref } = req.body;
    if (!funcionario_id || !mes_ref || !tipo) return res.status(400).json({ ok: false, erro: 'funcionario_id, mes_ref e tipo obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO rh_pagamentos (funcionario_id, mes_ref, tipo, descricao, valor, data_ref)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [funcionario_id, mes_ref, tipo, descricao || null, parseFloat(valor || 0), data_ref || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /pagamento/:id ──────────────────────────────────────────────────
  r.delete('/pagamento/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM rh_pagamentos WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /resumo-mes?mes=MM/YYYY — todos funcionários no mês ───────────────
  r.get('/resumo-mes', async (req, res) => {
    const { mes } = req.query;
    if (!mes) return res.status(400).json({ ok: false, erro: 'mes obrigatório' });
    try {
      const { rows } = await pool.query(`
        SELECT
          f.id, f.nome, f.cargo,
          COALESCE(fi.salario_base,    0) AS salario_base,
          COALESCE(fi.vale_alimentacao,0) AS vale_alimentacao,
          COALESCE(fi.escala_domingo,  0)                    AS escala_domingo,
          COALESCE(fi.valor_domingo,   0)                    AS valor_domingo,
          COALESCE((SELECT SUM(valor_total) FROM rh_apontamentos
                    WHERE funcionario_id=f.id AND mes_ref=$1 AND tipo NOT IN ('falta','desconto')), 0) AS total_acrescimos,
          COALESCE((SELECT SUM(valor_total) FROM rh_apontamentos
                    WHERE funcionario_id=f.id AND mes_ref=$1 AND tipo IN ('falta','desconto')), 0)     AS total_descontos,
          COALESCE((SELECT SUM(valor)       FROM rh_pagamentos
                    WHERE funcionario_id=f.id AND mes_ref=$1), 0)                                      AS total_extras,
          COALESCE((SELECT SUM(valor_total) FROM retiradas
                    WHERE funcionario_id=f.id AND mes=$1), 0)                                          AS total_retiradas
        FROM funcionarios f
        LEFT JOIN rh_fichas fi ON fi.funcionario_id = f.id AND fi.mes_ref = $1
        WHERE f.ativo = true
        ORDER BY f.nome ASC
      `, [mes]);

      const data = rows.map(r => {
        const base     = parseFloat(r.salario_base);
        const va       = parseFloat(r.vale_alimentacao);
        const domingos = parseFloat(r.escala_domingo) * parseFloat(r.valor_domingo);
        const acres    = parseFloat(r.total_acrescimos);
        const desc     = parseFloat(r.total_descontos);
        const extras   = parseFloat(r.total_extras);
        const retiradas= parseFloat(r.total_retiradas);
        const bruto    = base + va + domingos + acres + extras - desc;
        const liquido  = bruto - retiradas;
        return { ...r, domingos, bruto, liquido,
          salario_base: base, vale_alimentacao: va,
          total_acrescimos: acres, total_descontos: desc,
          total_extras: extras, total_retiradas: retiradas };
      });

      res.json({ ok: true, data, mes });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /funcionario/:id — atualiza salário/VA base ───────────────────────
  r.put('/funcionario/:id', async (req, res) => {
    const { salario_base, vale_alimentacao, cargo } = req.body;
    try {
      await pool.query(`
        UPDATE funcionarios SET
          salario_base     = COALESCE($1, salario_base),
          vale_alimentacao = COALESCE($2, vale_alimentacao),
          cargo            = COALESCE($3, cargo),
          atualizado_em    = NOW()
        WHERE id = $4
      `, [salario_base !== undefined ? parseFloat(salario_base) : null,
          vale_alimentacao !== undefined ? parseFloat(vale_alimentacao) : null,
          cargo || null,
          parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
