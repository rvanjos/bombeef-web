/**
 * routes/kits.js — Kits e Precificação
 */
const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  async function initTable() {
    // Migration PRIMEIRO — renomeia colunas legadas antes de qualquer outra operação
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='nome_kit')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='nome')
        THEN ALTER TABLE kits RENAME COLUMN nome_kit TO nome;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='id_kit')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='id')
        THEN ALTER TABLE kits RENAME COLUMN id_kit TO id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='id_kit')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='kit_id')
        THEN ALTER TABLE kit_itens RENAME COLUMN id_kit TO kit_id;
        END IF;
      END $$;
    `).catch(e => console.warn('[kits] migration legada:', e.message));

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
        id SERIAL PRIMARY KEY, kit_id INTEGER, produto_id INTEGER,
        codigo_produto TEXT, descricao_produto TEXT,
        quantidade NUMERIC(10,3) DEFAULT 1, preco_custo_unitario NUMERIC(10,4) DEFAULT 0,
        ignorar_margem BOOLEAN DEFAULT false, custo_kit NUMERIC(10,4)
      )
    `).catch(() => {});
    // Garante que kit_id existe — se só existia id_kit, adiciona kit_id e migra os dados
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='kit_id')
        THEN
          ALTER TABLE kit_itens ADD COLUMN kit_id INTEGER;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='id_kit')
          THEN UPDATE kit_itens SET kit_id = id_kit;
          END IF;
        END IF;
      END $$;
    `).catch(e => console.warn('[kits] migração kit_id:', e.message));
    for (const [col, def] of [
      ['produto_id','INTEGER'],['codigo_produto','TEXT'],
      ['descricao_produto','TEXT'],['preco_custo_unitario','NUMERIC(10,4) DEFAULT 0'],
      ['ignorar_margem','BOOLEAN DEFAULT false'],['custo_kit','NUMERIC(10,4)'],
    ]) await pool.query(`ALTER TABLE kit_itens ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kit_itens_kit ON kit_itens(kit_id)`).catch(() => {});

    // Tabela de histórico semanal de kits
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_semanas (
        id           SERIAL PRIMARY KEY,
        kit_id       INTEGER NOT NULL,
        semana_ini   DATE NOT NULL,          -- segunda-feira da semana
        semana_fim   DATE NOT NULL,          -- domingo da semana
        qtd_produzida INTEGER DEFAULT 0,
        qtd_vendida   INTEGER DEFAULT 0,
        obs           TEXT,
        criado_em    TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ks_kit    ON kit_semanas(kit_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ks_semana ON kit_semanas(semana_ini)`).catch(() => {});

    // Remove FKs indevidas em kit_itens (codigo_produto não deve ter FK)
    await pool.query(`
      DO $$ DECLARE r RECORD; BEGIN
        FOR r IN
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name='kit_itens' AND constraint_type='FOREIGN KEY'
            AND constraint_name NOT LIKE '%kit_id%' AND constraint_name NOT LIKE '%produto_id%'
        LOOP
          EXECUTE 'ALTER TABLE kit_itens DROP CONSTRAINT ' || r.constraint_name;
        END LOOP;
      END $$;
    `).catch(e => console.warn('[kits] drop FKs indevidas:', e.message));
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

      // Detecta colunas de nome disponíveis
      const { rows: nomeCols } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='kits'
          AND column_name IN ('nome','nome_kit')
      `);
      const hasNome    = nomeCols.some(r => r.column_name === 'nome');
      const hasNomeKit = nomeCols.some(r => r.column_name === 'nome_kit');
      
      // Monta INSERT dinamicamente para preencher todas as colunas de nome existentes
      const nomeColunas = [hasNomeKit && 'nome_kit', hasNome && 'nome'].filter(Boolean);
      const nomeValues  = nomeColunas.map(() => nome.trim());
      const allCols     = ['codigo', ...nomeColunas, 'descricao', 'preco_venda', 'margem'];
      const allVals     = [codigo?.trim()||null, ...nomeValues, descricao||null,
                           parseFloat(precoVenda||0), parseFloat(margem||0)];
      const placeholders = allVals.map((_,i) => '$'+(i+1)).join(',');
      
      const { rows: r1 } = await client.query(
        `INSERT INTO kits (${allCols.join(',')}) VALUES (${placeholders}) RETURNING id`,
        allVals
      );
      const kitId = r1[0].id;

      for (const item of itens) {
        let prodId = null;
        if (item.codigo) {
          const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
          if (p.rows.length) prodId = p.rows[0].id;
        }
        await client.query(`
          INSERT INTO kit_itens (kit_id, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [kitId, prodId, item.codigo||null, item.descricao||null,
            parseFloat(item.quantidade||1), parseFloat(item.precoCusto||0)]);
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

      // Detecta nome da coluna
      const nomeColPut = (await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='kits' AND column_name IN ('nome','nome_kit')
        ORDER BY CASE column_name WHEN 'nome' THEN 1 ELSE 2 END LIMIT 1
      `)).rows[0]?.column_name || 'nome';

      await client.query(`
        UPDATE kits SET
          ${nomeColPut} = COALESCE($1, ${nomeColPut}), descricao = COALESCE($2, descricao),
          preco_venda = COALESCE($3, preco_venda), margem = COALESCE($4, margem),
          atualizado_em = NOW()
        WHERE id = $5
      `, [nome||null, descricao||null,
          precoVenda !== undefined ? parseFloat(precoVenda) : null,
          margem !== undefined ? parseFloat(margem) : null,
          numId]);

      if (Array.isArray(itens)) {
        const { rows: kitRow } = await client.query(
          `SELECT id FROM kits WHERE id = $1`,
          [numId]
        );
        if (!kitRow.length) throw new Error('Kit não encontrado');
        const kitId = kitRow[0].id;
        await client.query(`DELETE FROM kit_itens WHERE kit_id = $1`, [kitId]);
        const kiColPut = 'kit_id';

        for (const item of itens) {
          let prodId = null;
          if (item.codigo) {
            const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [item.codigo]);
            if (p.rows.length) prodId = p.rows[0].id;
          }
          await client.query(`
            INSERT INTO kit_itens (kit_id, produto_id, codigo_produto, descricao_produto, quantidade, preco_custo_unitario)
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
      const delId = parseInt(req.params.id);
      if (!isNaN(delId)) {
        await pool.query(`UPDATE kits SET ativo = false, atualizado_em = NOW() WHERE id = $1`, [delId]);
      } else {
        await pool.query(`UPDATE kits SET ativo = false, atualizado_em = NOW() WHERE codigo = $1`, [req.params.id]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /semanas — histórico semanal ─────────────────────────────────────
  r.get('/semanas', async (req, res) => {
    const { kit_id, de, ate } = req.query;
    try {
      const conds = [], params = [];
      if (kit_id) { params.push(parseInt(kit_id)); conds.push(`ks.kit_id=$${params.length}`); }
      if (de)     { params.push(de);               conds.push(`ks.semana_ini>=$${params.length}::date`); }
      if (ate)    { params.push(ate);               conds.push(`ks.semana_ini<=$${params.length}::date`); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const { rows } = await pool.query(`
        SELECT ks.*, k.nome AS kit_nome, k.codigo AS kit_codigo,
          ROUND(ks.qtd_vendida::numeric/NULLIF(ks.qtd_produzida,0)*100, 1) AS pct_vendido
        FROM kit_semanas ks
        JOIN kits k ON k.id = ks.kit_id
        ${where}
        ORDER BY ks.semana_ini DESC, k.nome
      `, params);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /semanas/ranking — ranking de kits por vendas ────────────────────
  r.get('/semanas/ranking', async (req, res) => {
    const { de, ate } = req.query;
    try {
      const conds = ['1=1'];
      const params = [];
      if (de)  { params.push(de);  conds.push(`ks.semana_ini>=$${params.length}::date`); }
      if (ate) { params.push(ate); conds.push(`ks.semana_ini<=$${params.length}::date`); }
      const { rows } = await pool.query(`
        SELECT k.id, k.nome, k.codigo,
          SUM(ks.qtd_produzida) AS total_produzido,
          SUM(ks.qtd_vendida)   AS total_vendido,
          COUNT(ks.id)          AS num_semanas,
          ROUND(AVG(ks.qtd_vendida::numeric/NULLIF(ks.qtd_produzida,0)*100), 1) AS pct_medio
        FROM kit_semanas ks
        JOIN kits k ON k.id = ks.kit_id
        WHERE ${conds.join(' AND ')}
        GROUP BY k.id, k.nome, k.codigo
        ORDER BY total_vendido DESC
      `, params);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /semanas — registrar semana ──────────────────────────────────────
  r.post('/semanas', async (req, res) => {
    const { kit_id, semana_ini, qtd_produzida, qtd_vendida, obs } = req.body;
    if (!kit_id || !semana_ini) return res.status(400).json({ ok: false, erro: 'kit_id e semana_ini obrigatórios' });
    try {
      // semana_fim = semana_ini + 6 dias
      const { rows } = await pool.query(`
        INSERT INTO kit_semanas (kit_id, semana_ini, semana_fim, qtd_produzida, qtd_vendida, obs)
        VALUES ($1, $2::date, $2::date + 6, $3, $4, $5)
        RETURNING *
      `, [parseInt(kit_id), semana_ini, parseInt(qtd_produzida||0), parseInt(qtd_vendida||0), obs||null]);
      res.json({ ok: true, data: rows[0] });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /semanas/:id ───────────────────────────────────────────────────────
  r.put('/semanas/:id', async (req, res) => {
    const { qtd_produzida, qtd_vendida, obs } = req.body;
    try {
      await pool.query(`
        UPDATE kit_semanas SET qtd_produzida=$1, qtd_vendida=$2, obs=$3 WHERE id=$4
      `, [parseInt(qtd_produzida||0), parseInt(qtd_vendida||0), obs||null, parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /semanas/:id ────────────────────────────────────────────────────
  r.delete('/semanas/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM kit_semanas WHERE id=$1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
