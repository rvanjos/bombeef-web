/**
 * routes/kits.js — Kits e Precificação
 */
const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kits (
        id SERIAL PRIMARY KEY, codigo TEXT, nome TEXT NOT NULL,
        descricao TEXT, preco_venda NUMERIC(10,4) DEFAULT 0,
        margem NUMERIC(5,2) DEFAULT 0, ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMPTZ DEFAULT NOW(), atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    for (const [col, def] of [
      ['codigo','TEXT'],['descricao','TEXT'],['margem','NUMERIC(5,2) DEFAULT 0'],
      ['ativo','BOOLEAN DEFAULT true'],['atualizado_em','TIMESTAMPTZ DEFAULT NOW()'],
    ]) await pool.query(`ALTER TABLE kits ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_itens (
        id SERIAL PRIMARY KEY, kit_id INTEGER NOT NULL, produto_id INTEGER,
        codigo_produto TEXT, descricao_produto TEXT,
        quantidade NUMERIC(10,3) DEFAULT 1, preco_custo_unitario NUMERIC(10,4) DEFAULT 0,
        ignorar_margem BOOLEAN DEFAULT false, custo_kit NUMERIC(10,4)
      )
    `).catch(() => {});
    for (const [col, def] of [
      ['kit_id','INTEGER'],['produto_id','INTEGER'],['codigo_produto','TEXT'],
      ['descricao_produto','TEXT'],['preco_custo_unitario','NUMERIC(10,4) DEFAULT 0'],
      ['ignorar_margem','BOOLEAN DEFAULT false'],['custo_kit','NUMERIC(10,4)'],
    ]) await pool.query(`ALTER TABLE kit_itens ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kit_itens_kit ON kit_itens(kit_id)`).catch(() => {});
  }
  initTable().catch(e => console.error('[kits] initTable:', e.message));

  async function calcCusto(kitId, client) {
    const db = client || pool;
    const { rows } = await db.query(`
      SELECT COALESCE(SUM(ki.quantidade * COALESCE(ki.preco_custo_unitario, p.preco_custo, 0)), 0) AS custo
      FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
      WHERE ki.kit_id = $1
    `, [kitId]);
    return parseFloat(rows[0].custo || 0);
  }

  // GET /
  r.get('/', async (req, res) => {
    try {
      const { busca, ativo = 'true' } = req.query;
      const conds = [], params = [];
      if (ativo !== 'todos') { params.push(ativo !== 'false'); conds.push(`k.ativo = $${params.length}`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(k.codigo ILIKE $${params.length} OR k.nome ILIKE $${params.length})`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      const { rows: kits } = await pool.query(`
        SELECT k.*,
          (SELECT COALESCE(SUM(ki.quantidade * COALESCE(NULLIF(ki.preco_custo_unitario,0), p.preco_custo, 0)),0)
           FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
           WHERE ki.kit_id = k.id) AS custo_total
        FROM kits k ${where} ORDER BY k.nome ASC
      `, params);

      const ids = kits.map(k => k.id);
      let itens = [];
      if (ids.length) {
        const { rows } = await pool.query(`
          SELECT ki.*, p.descricao AS prod_desc, p.unidade, p.preco_venda AS preco_venda_atual
          FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
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
      console.error('[kits/GET]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // GET /:id
  r.get('/:id', async (req, res) => {
    try {
      const numId = parseInt(req.params.id);
      const { rows } = await pool.query(
        isNaN(numId)
          ? `SELECT * FROM kits WHERE codigo = $1`
          : `SELECT * FROM kits WHERE id = $1 OR codigo = $2`,
        isNaN(numId) ? [req.params.id] : [numId, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Kit não encontrado' });
      const kit = rows[0];
      const { rows: itens } = await pool.query(`
        SELECT ki.*, p.descricao AS prod_desc, p.unidade, p.preco_custo AS custo_atual, p.preco_venda AS preco_venda_atual
        FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
        WHERE ki.kit_id = $1
      `, [kit.id]);
      const custoTotal = await calcCusto(kit.id);
      res.json({ ok: true, data: { ...kit, custoTotal, itens } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // POST /
  r.post('/', async (req, res) => {
    const { codigo, nome, descricao, precoVenda, margem, itens = [] } = req.body;
    if (!nome) return res.status(400).json({ ok: false, erro: 'nome é obrigatório' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(`
        INSERT INTO kits (codigo, nome, descricao, preco_venda, margem)
        VALUES ($1,$2,$3,$4,$5) RETURNING id
      `, [codigo?.trim()||null, nome.trim(), descricao||null,
          parseFloat(precoVenda||0), parseFloat(margem||0)]);
      const kitId = rows[0].id;

      for (const item of itens) {
        let prodId = null;
        if (item.codigo) {
          const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
          if (p.rows.length) prodId = p.rows[0].id;
        }
        await client.query(`
          INSERT INTO kit_itens (kit_id, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario, ignorar_margem, custo_kit)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [kitId, prodId, item.codigo||null, item.descricao||null,
            parseFloat(item.quantidade||1), parseFloat(item.precoCusto||0),
            !!item.ignorarMargem, item.custoKit!=null?parseFloat(item.custoKit):null]);
      }

      const custo = await calcCusto(kitId, client);
      await client.query('COMMIT');
      res.json({ ok: true, id: kitId, custoTotal: custo });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[kits/POST] ERRO:', e.message, '| code:', e.code, '| detail:', e.detail, '| hint:', e.hint);
      if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'Código de kit já existe' });
      res.status(500).json({ ok: false, erro: e.message, detalhe: e.detail || e.hint || '' });
    } finally { client.release(); }
  });

  // PUT /:id
  r.put('/:id', async (req, res) => {
    const { nome, descricao, precoVenda, margem, itens } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const numId = parseInt(req.params.id);

      await client.query(`
        UPDATE kits SET
          nome = COALESCE($1, nome), descricao = COALESCE($2, descricao),
          preco_venda = COALESCE($3, preco_venda), margem = COALESCE($4, margem),
          atualizado_em = NOW()
        WHERE id = $5 OR codigo = $5
      `, [nome||null, descricao||null,
          precoVenda !== undefined ? parseFloat(precoVenda) : null,
          margem !== undefined ? parseFloat(margem) : null,
          isNaN(numId) ? req.params.id : numId]);

      if (Array.isArray(itens)) {
        const { rows: kitRow } = await client.query(
          `SELECT id FROM kits WHERE id = $1 OR codigo = $1`,
          [isNaN(numId) ? req.params.id : numId]
        );
        if (!kitRow.length) throw new Error('Kit não encontrado');
        const kitId = kitRow[0].id;
        await client.query(`DELETE FROM kit_itens WHERE kit_id = $1`, [kitId]);
        for (const item of itens) {
          let prodId = null;
          if (item.codigo) {
            const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
            if (p.rows.length) prodId = p.rows[0].id;
          }
          await client.query(`
            INSERT INTO kit_itens (kit_id, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario, ignorar_margem, custo_kit)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `, [kitId, prodId, item.codigo||null, item.descricao||null,
              parseFloat(item.quantidade||1), parseFloat(item.precoCusto||0),
              !!item.ignorarMargem, item.custoKit!=null?parseFloat(item.custoKit):null]);
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // DELETE /:id
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE kits SET ativo = false, atualizado_em = NOW() WHERE id = $1 OR codigo = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
