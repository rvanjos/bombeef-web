/**
 * routes/kits.js — Kits e Precificação
 * Suporta bancos antigos com colunas id_kit/nome_kit detectando schema dinamicamente.
 */

const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  async function detectSchema(client) {
    const db = client || pool;
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('kits','kit_itens')
        AND column_name IN ('id','id_kit','nome','nome_kit','kit_id')
    `);
    const cols = rows.map(r => r.column_name);
    console.log('[kits] detectSchema cols:', cols);
    return {
      pkCol:   cols.includes('id')     ? 'id'     : 'id_kit',
      nomeCol: cols.includes('nome')   ? 'nome'   : 'nome_kit',
      kiCol:   cols.includes('kit_id') ? 'kit_id' : 'id_kit',
    };
  }

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
        ignorar_margem BOOLEAN DEFAULT false
      )
    `).catch(() => {});
    for (const [col, def] of [
      ['kit_id','INTEGER'],['produto_id','INTEGER'],['codigo_produto','TEXT'],
      ['descricao_produto','TEXT'],['preco_custo_unitario','NUMERIC(10,4) DEFAULT 0'],
      ['ignorar_margem','BOOLEAN DEFAULT false'],
    ]) await pool.query(`ALTER TABLE kit_itens ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kit_itens_kit ON kit_itens(kit_id)`).catch(() => {});
  }
  initTable().catch(e => console.error('[kits] initTable:', e.message));

  // Migration: renomeia colunas legadas
  pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='id_kit')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='id')
      THEN ALTER TABLE kits RENAME COLUMN id_kit TO id; END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='nome_kit')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='nome')
      THEN ALTER TABLE kits RENAME COLUMN nome_kit TO nome; END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='id_kit')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='kit_id')
      THEN ALTER TABLE kit_itens RENAME COLUMN id_kit TO kit_id; END IF;
    END $$;
  `).catch(e => console.warn('[kits] migration:', e.message));

  async function calcCustoKit(kitId, client) {
    const db = client || pool;
    const { kiCol } = await detectSchema(db);
    const { rows } = await db.query(`
      SELECT COALESCE(SUM(ki.quantidade * COALESCE(ki.preco_custo_unitario, p.preco_custo, 0)), 0) AS custo
      FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
      WHERE ki.${kiCol} = $1
    `, [kitId]);
    return parseFloat(rows[0].custo || 0);
  }

  // GET /
  r.get('/', async (req, res) => {
    try {
      const { pkCol, nomeCol, kiCol } = await detectSchema();
      const { busca, ativo = 'true' } = req.query;
      const conds = [], params = [];
      if (ativo !== 'todos') { params.push(ativo !== 'false'); conds.push(`k.ativo = $${params.length}`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(k.codigo ILIKE $${params.length} OR k.${nomeCol} ILIKE $${params.length})`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      const { rows: kits } = await pool.query(`
        SELECT k.*, k.${pkCol} AS id, k.${nomeCol} AS nome,
               (SELECT COALESCE(SUM(ki.quantidade * COALESCE(NULLIF(ki.preco_custo_unitario,0), p.preco_custo, 0)),0)
                FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
                WHERE ki.${kiCol} = k.${pkCol}) AS custo_total
        FROM kits k ${where} ORDER BY k.${nomeCol} ASC
      `, params);

      const ids = kits.map(k => k.id);
      let itens = [];
      if (ids.length) {
        const { rows } = await pool.query(`
          SELECT ki.*, ki.${kiCol} AS kit_id, p.descricao AS prod_desc, p.unidade, p.preco_venda AS preco_venda_atual
          FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
          WHERE ki.${kiCol} = ANY($1::int[])
        `, [ids]);
        itens = rows;
      }

      const data = kits.map(k => ({
        ...k, id: k.id, nome: k.nome,
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
      const { pkCol, nomeCol, kiCol } = await detectSchema();
      const numId = parseInt(req.params.id);
      const { rows } = await pool.query(
        isNaN(numId)
          ? `SELECT *, ${pkCol} AS id, ${nomeCol} AS nome FROM kits WHERE codigo = $1`
          : `SELECT *, ${pkCol} AS id, ${nomeCol} AS nome FROM kits WHERE ${pkCol} = $1 OR codigo = $2`,
        isNaN(numId) ? [req.params.id] : [numId, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Kit não encontrado' });
      const kit = rows[0];
      const { rows: itens } = await pool.query(`
        SELECT ki.*, p.descricao AS prod_desc, p.unidade, p.preco_custo AS custo_atual
        FROM kit_itens ki LEFT JOIN produtos p ON p.id = ki.produto_id
        WHERE ki.${kiCol} = $1
      `, [kit.id]);
      const custoTotal = await calcCustoKit(kit.id);
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
      const { pkCol, nomeCol, kiCol } = await detectSchema(client);
      const { rows: colCheck } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='kits' AND column_name='codigo'`
      );
      const temCodigo = colCheck.length > 0;

      // Helper: tenta INSERT com SAVEPOINT para fallback seguro na transação
      async function insertKit(cols, vals) {
        await client.query('SAVEPOINT insert_kit');
        try {
          const { rows } = await client.query(
            `INSERT INTO kits (${cols.join(',')}) VALUES (${vals.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING ${pkCol} AS id`,
            vals
          );
          await client.query('RELEASE SAVEPOINT insert_kit');
          return rows[0].id;
        } catch(e) {
          await client.query('ROLLBACK TO SAVEPOINT insert_kit');
          // Se o erro é de coluna errada, tenta com o nome oposto
          if (e.message.includes('nome_kit') || e.message.includes('"nome"') || e.message.includes('column')) {
            const altNome = nomeCol === 'nome' ? 'nome_kit' : 'nome';
            const idx = cols.indexOf(nomeCol);
            if (idx >= 0) {
              const altCols = [...cols]; altCols[idx] = altNome;
              console.log(`[kits] fallback INSERT: trocando ${nomeCol}→${altNome}`);
              const { rows } = await client.query(
                `INSERT INTO kits (${altCols.join(',')}) VALUES (${vals.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING ${pkCol} AS id`,
                vals
              );
              return rows[0].id;
            }
          }
          throw e;
        }
      }

      let kitId;
      if (temCodigo && codigo) {
        kitId = await insertKit(['codigo', nomeCol, 'descricao', 'preco_venda', 'margem'],
          [codigo.trim(), nome.trim(), descricao||null, parseFloat(precoVenda||0), parseFloat(margem||0)]);
      } else {
        kitId = await insertKit([nomeCol, 'descricao', 'preco_venda'],
          [nome.trim(), descricao||null, parseFloat(precoVenda||0)]);
        if (temCodigo && codigo)
          await client.query(`UPDATE kits SET codigo=$1 WHERE ${pkCol}=$2`, [codigo.trim(), kitId]).catch(()=>{});
      }

      for (const item of itens) {
        let prodId = item.produtoId || item.produto_id || null;
        if (!prodId && item.codigo) {
          const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
          if (p.rows.length) prodId = p.rows[0].id;
        }
        await client.query(`
          INSERT INTO kit_itens (${kiCol}, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [kitId, prodId, item.codigo||null, item.descricao||null,
            parseFloat(item.quantidade||1), parseFloat(item.precoCusto||item.preco_custo_unitario||0)]);
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

  // PUT /:id
  r.put('/:id', async (req, res) => {
    const { nome, descricao, precoVenda, margem, itens } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { pkCol, nomeCol, kiCol } = await detectSchema(client);

      await client.query(`
        UPDATE kits SET
          ${nomeCol}    = COALESCE($1, ${nomeCol}),
          descricao     = COALESCE($2, descricao),
          preco_venda   = COALESCE($3, preco_venda),
          margem        = COALESCE($4, margem),
          atualizado_em = NOW()
        WHERE ${pkCol} = $5 OR codigo = $5
      `, [nome||null, descricao||null,
          precoVenda !== undefined ? parseFloat(precoVenda) : null,
          margem     !== undefined ? parseFloat(margem)     : null,
          req.params.id]);

      if (Array.isArray(itens)) {
        const { rows: kitRow } = await client.query(
          `SELECT ${pkCol} AS id FROM kits WHERE ${pkCol} = $1 OR codigo = $1`, [req.params.id]
        );
        if (!kitRow.length) throw new Error('Kit não encontrado');
        const kitId = kitRow[0].id;
        await client.query(`DELETE FROM kit_itens WHERE ${kiCol} = $1`, [kitId]);
        for (const item of itens) {
          let prodId = item.produtoId || item.produto_id || null;
          if (!prodId && item.codigo) {
            const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
            if (p.rows.length) prodId = p.rows[0].id;
          }
          await client.query(`
            INSERT INTO kit_itens (${kiCol}, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario)
            VALUES ($1,$2,$3,$4,$5,$6)
          `, [kitId, prodId, item.codigo||null, item.descricao||null,
              parseFloat(item.quantidade||1), parseFloat(item.precoCusto||0)]);
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
      const { pkCol } = await detectSchema();
      await pool.query(
        `UPDATE kits SET ativo = false, atualizado_em = NOW() WHERE ${pkCol} = $1 OR codigo = $1`,
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
