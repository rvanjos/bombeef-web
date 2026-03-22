/**
 * routes/kits.js — M3: Kits e Precificação
 *
 * Rotas:
 *   GET  /api/kits          → lista kits com itens
 *   GET  /api/kits/:id      → detalhe do kit
 *   POST /api/kits          → cria kit com itens
 *   PUT  /api/kits/:id      → atualiza kit e itens
 *   DELETE /api/kits/:id    → inativa kit
 *   GET  /api/kits/:id/preco → simula preço com margem
 */

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabelas ───────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kits (
        id            SERIAL PRIMARY KEY,
        codigo        TEXT,
        nome          TEXT NOT NULL,
        descricao     TEXT,
        preco_venda   NUMERIC(10,4) DEFAULT 0,
        margem        NUMERIC(5,2) DEFAULT 0,
        ativo         BOOLEAN DEFAULT true,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Adiciona colunas novas sem quebrar tabela existente
    const cols = [
      ['codigo',        'TEXT'],
      ['descricao',     'TEXT'],
      ['margem',        'NUMERIC(5,2) DEFAULT 0'],
      ['ativo',         'BOOLEAN DEFAULT true'],
      ['atualizado_em', 'TIMESTAMPTZ DEFAULT NOW()'],
    ];
    for (const [col, def] of cols) {
      await pool.query(
        `ALTER TABLE kits ADD COLUMN IF NOT EXISTS ${col} ${def}`
      ).catch(() => {});
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_itens (
        id                    SERIAL PRIMARY KEY,
        kit_id                INTEGER NOT NULL,
        produto_id            INTEGER,
        codigo_produto        TEXT,
        descricao_produto     TEXT,
        quantidade            NUMERIC(10,3) DEFAULT 1,
        preco_custo_unitario  NUMERIC(10,4) DEFAULT 0
      )
    `);
    // ALTER TABLE separados — PostgreSQL não aceita múltiplos DDL num único query
    for (const [col, def] of [
      ['codigo_produto',       'TEXT'],
      ['descricao_produto',    'TEXT'],
      ['preco_custo_unitario', 'NUMERIC(10,4) DEFAULT 0'],
    ]) {
      await pool.query(`ALTER TABLE kit_itens ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
    }
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_kit_itens_kit ON kit_itens(kit_id)`
    ).catch(() => {});
  }
  initTable().catch(e => console.error('[kits] initTable:', e.message));

  // ── Helper: calcula custo total do kit ────────────────────────────────────
  async function calcCustoKit(kitId, client = pool) {
    const { rows } = await client.query(`
      SELECT COALESCE(SUM(ki.quantidade * COALESCE(ki.preco_custo_unitario, p.preco_custo, 0)), 0) AS custo
      FROM kit_itens ki
      LEFT JOIN produtos p ON p.id = ki.produto_id
      WHERE ki.kit_id = $1
    `, [kitId]);
    return parseFloat(rows[0].custo || 0);
  }

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      // Garante tabelas existem (caso o deploy tenha rodado antes da migration)
      await initTable().catch(() => {});
      const { busca, ativo = 'true' } = req.query;
      const conds = [], params = [];
      if (ativo !== 'todos') { params.push(ativo !== 'false'); conds.push(`k.ativo = $${params.length}`); }
      if (busca) {
        params.push(`%${busca}%`);
        const idx = params.length;
        conds.push(`(k.codigo ILIKE $${idx} OR k.nome ILIKE $${idx})`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      const { rows: kits } = await pool.query(
        `SELECT k.*, (
          SELECT COALESCE(SUM(ki.quantidade * COALESCE(
            NULLIF(ki.preco_custo_unitario, 0),
            p.preco_custo,
            0
          )), 0)
          FROM kit_itens ki
          LEFT JOIN produtos p ON p.id = ki.produto_id
          WHERE ki.kit_id = k.id
        ) AS custo_total
        FROM kits k ${where} ORDER BY k.nome ASC`, params
      );

      // Carrega itens de cada kit
      const ids = kits.map(k => k.id);
      let itens = [];
      if (ids.length > 0) {
        const { rows } = await pool.query(`
          SELECT ki.*, p.descricao AS prod_desc, p.unidade, p.preco_venda AS preco_venda_atual
          FROM kit_itens ki
          LEFT JOIN produtos p ON p.id = ki.produto_id
          WHERE ki.kit_id = ANY($1::int[])
        `, [ids]);
        itens = rows;
      }

      const data = kits.map(k => ({
        ...k,
        custoTotal: parseFloat(k.custo_total || 0),
        margemValor: parseFloat(k.preco_venda || 0) - parseFloat(k.custo_total || 0),
        itens: itens.filter(i => i.kit_id === k.id),
      }));

      res.json({ ok: true, data, total: data.length });
    } catch (e) {
      console.error('[kits/GET] ERRO COMPLETO:', e.message, e.stack?.split('\n')[1]);
      res.status(500).json({ ok: false, erro: e.message, detalhe: e.detail || e.hint || '' });
    }
  });

  // ── GET /:id ───────────────────────────────────────────────────────────────
  r.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM kits WHERE id = $1 OR codigo = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Kit não encontrado' });
      const kit = rows[0];

      const { rows: itens } = await pool.query(`
        SELECT ki.*, p.descricao AS prod_desc, p.unidade, p.preco_custo AS custo_atual
        FROM kit_itens ki
        LEFT JOIN produtos p ON p.id = ki.produto_id
        WHERE ki.kit_id = $1
      `, [kit.id]);

      const custoTotal = await calcCustoKit(kit.id);
      res.json({ ok: true, data: { ...kit, custoTotal, itens } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const { codigo, nome, descricao, precoVenda, margem, itens = [] } = req.body;
    if (!nome) return res.status(400).json({ ok: false, erro: 'nome é obrigatório' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verifica se coluna codigo existe na tabela
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='kits' AND column_name='codigo'
      `);
      const temCodigo = colCheck.rows.length > 0;

      let rows;
      if (temCodigo && codigo) {
        ({ rows } = await client.query(`
          INSERT INTO kits (codigo, nome, descricao, preco_venda, margem)
          VALUES ($1, $2, $3, $4, $5) RETURNING id
        `, [codigo.trim(), nome.trim(), descricao || null, parseFloat(precoVenda || 0), parseFloat(margem || 0)]));
      } else {
        ({ rows } = await client.query(`
          INSERT INTO kits (nome, descricao, preco_venda)
          VALUES ($1, $2, $3) RETURNING id
        `, [nome.trim(), descricao || null, parseFloat(precoVenda || 0)]));
        // Adiciona codigo depois se a coluna existir
        if (temCodigo && codigo) {
          await client.query(`UPDATE kits SET codigo=$1 WHERE id=$2`, [codigo.trim(), rows[0].id]).catch(()=>{});
        }
      }

      const kitId = rows[0].id;

      for (const item of itens) {
        // Resolve produto_id pelo código se necessário
        let prodId = item.produtoId || item.produto_id || null;
        if (!prodId && item.codigo) {
          const p = await client.query(`SELECT id, preco_custo FROM produtos WHERE codigo = $1`, [item.codigo]);
          if (p.rows.length) prodId = p.rows[0].id;
        }
        await client.query(`
          INSERT INTO kit_itens (kit_id, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [kitId, prodId, item.codigo || null, item.descricao || null,
            parseFloat(item.quantidade || 1), parseFloat(item.precoCusto || item.preco_custo_unitario || 0)]);
      }

      const custo = await calcCustoKit(kitId, client);
      await client.query('COMMIT');
      res.json({ ok: true, id: kitId, custoTotal: custo });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'Código de kit já existe' });
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const { nome, descricao, precoVenda, margem, itens } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        UPDATE kits SET
          nome = COALESCE($1, nome), descricao = COALESCE($2, descricao),
          preco_venda = COALESCE($3, preco_venda), margem = COALESCE($4, margem),
          atualizado_em = NOW()
        WHERE id = $5 OR codigo = $5
      `, [nome || null, descricao || null,
          precoVenda !== undefined ? parseFloat(precoVenda) : null,
          margem !== undefined ? parseFloat(margem) : null,
          req.params.id]);

      if (Array.isArray(itens)) {
        const kitRow = await client.query(`SELECT id FROM kits WHERE id = $1 OR codigo = $1`, [req.params.id]);
        if (!kitRow.rows.length) throw new Error('Kit não encontrado');
        const kitId = kitRow.rows[0].id;

        await client.query(`DELETE FROM kit_itens WHERE kit_id = $1`, [kitId]);
        for (const item of itens) {
          let prodId = item.produtoId || item.produto_id || null;
          if (!prodId && item.codigo) {
            const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
            if (p.rows.length) prodId = p.rows[0].id;
          }
          await client.query(`
            INSERT INTO kit_itens (kit_id, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario)
            VALUES ($1,$2,$3,$4,$5,$6)
          `, [kitId, prodId, item.codigo || null, item.descricao || null,
              parseFloat(item.quantidade || 1), parseFloat(item.precoCusto || 0)]);
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE kits SET ativo = false, atualizado_em = NOW() WHERE id = $1 OR codigo = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /:id/preco — simula preço por margem ───────────────────────────────
  r.get('/:id/preco', async (req, res) => {
    try {
      const { margem = 30 } = req.query;
      const { rows } = await pool.query(`SELECT id FROM kits WHERE id = $1 OR codigo = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Kit não encontrado' });
      const custo = await calcCustoKit(rows[0].id);
      const m     = parseFloat(margem) / 100;
      const precoSugerido = m < 1 ? custo / (1 - m) : custo * (1 + m);
      res.json({ ok: true, data: { custo, margem: parseFloat(margem), precoSugerido: parseFloat(precoSugerido.toFixed(4)) } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
