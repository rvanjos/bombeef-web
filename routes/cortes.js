/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
/**
 * routes/cortes.js — CorteMaster integrado ao Bom Beef
 * Tabelas: cortes_registros, cortes_insumos, cortes_fichas, cortes_vendas
 */
const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabelas ──────────────────────────────────────────────────────────
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cortes_registros (
        id            SERIAL PRIMARY KEY,
        data          DATE NOT NULL DEFAULT CURRENT_DATE,
        fornecedor    TEXT,
        corte         TEXT NOT NULL,
        peso_bruto    NUMERIC(10,3) NOT NULL DEFAULT 0,
        peso_limpo    NUMERIC(10,3) NOT NULL DEFAULT 0,
        custo_por_kg  NUMERIC(10,2) NOT NULL DEFAULT 0,
        margem        NUMERIC(5,4)  NOT NULL DEFAULT 0.30,
        estoque       NUMERIC(10,3) NOT NULL DEFAULT 0,
        produto_id    INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
        obs           TEXT,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cortes_insumos (
        id            SERIAL PRIMARY KEY,
        nome          TEXT NOT NULL UNIQUE,
        categoria     TEXT NOT NULL DEFAULT 'Tempero',
        preco_unit    NUMERIC(10,4) NOT NULL DEFAULT 0,
        unidade       TEXT NOT NULL DEFAULT 'kg',
        estoque       NUMERIC(10,3) NOT NULL DEFAULT 0,
        fornecedor    TEXT,
        produto_id    INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cortes_fichas (
        id            SERIAL PRIMARY KEY,
        produto       TEXT NOT NULL,
        rendimento    NUMERIC(10,3) NOT NULL DEFAULT 1,
        kg_utilizado  NUMERIC(10,3),
        multiplicador NUMERIC(10,3) NOT NULL DEFAULT 2.5,
        itens         JSONB NOT NULL DEFAULT '[]',
        produto_id    INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cortes_vendas (
        id            SERIAL PRIMARY KEY,
        ficha_id      INTEGER REFERENCES cortes_fichas(id) ON DELETE SET NULL,
        ficha_nome    TEXT,
        qtd           NUMERIC(10,3) NOT NULL DEFAULT 1,
        preco_unit    NUMERIC(10,2) NOT NULL DEFAULT 0,
        custo_unit    NUMERIC(10,2) NOT NULL DEFAULT 0,
        total         NUMERIC(10,2) NOT NULL DEFAULT 0,
        data          DATE NOT NULL DEFAULT CURRENT_DATE,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cortes_config (
        chave   TEXT PRIMARY KEY,
        valor   TEXT NOT NULL,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    // Índices
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cr_data     ON cortes_registros(data DESC)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cr_corte    ON cortes_registros(corte)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cv_data     ON cortes_vendas(data DESC)`).catch(()=>{});
  }
  initTables().catch(e => console.error('[cortes] initTables:', e.message));

  // ── Helpers ───────────────────────────────────────────────────────────────
  const toNum = (v, def=0) => { const n = parseFloat(v); return isNaN(n) ? def : n; };

  // ── GET /dashboard — KPIs ────────────────────────────────────────────────
  r.get('/dashboard', async (req, res) => {
    try {
      const { rows: reg }    = await pool.query(`SELECT * FROM cortes_registros ORDER BY data DESC LIMIT 200`);
      const { rows: ins }    = await pool.query(`SELECT COUNT(*) AS total FROM cortes_insumos`);
      const { rows: fichas } = await pool.query(`SELECT COUNT(*) AS total FROM cortes_fichas`);
      const { rows: vendas } = await pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(total),0) AS faturamento FROM cortes_vendas`);
      const { rows: cfg }    = await pool.query(`SELECT valor FROM cortes_config WHERE chave='meta_perda'`);

      const metaPerda = toNum(cfg[0]?.valor, 0.15);

      // Calcular KPIs
      let totalBruto=0, totalLimpo=0, valorPerda=0, custoTotal=0;
      reg.forEach(c => {
        const bruto = toNum(c.peso_bruto);
        const limpo  = toNum(c.peso_limpo);
        const custo  = toNum(c.custo_por_kg);
        totalBruto  += bruto;
        totalLimpo  += limpo;
        valorPerda  += (bruto - limpo) * custo;
        custoTotal  += bruto * custo;
      });
      const perdaMedia = totalBruto > 0 ? (totalBruto - totalLimpo) / totalBruto : 0;

      // Ranking de cortes por valor perdido em R$
      const porCorte = {};
      reg.forEach(c => {
        const k = c.corte;
        if (!porCorte[k]) porCorte[k] = { bruto:0, limpo:0, n:0, valorPerda:0 };
        const b = toNum(c.peso_bruto), l = toNum(c.peso_limpo), cu = toNum(c.custo_por_kg);
        porCorte[k].bruto += b;
        porCorte[k].limpo += l;
        porCorte[k].n++;
        porCorte[k].valorPerda += (b - l) * cu;
      });
      const ranking = Object.entries(porCorte)
        .map(([corte, v]) => ({
          corte,
          perda_pct:   v.bruto > 0 ? (v.bruto - v.limpo) / v.bruto : 0,
          valor_perda: v.valorPerda,
          registros:   v.n,
        }))
        .sort((a,b) => b.valor_perda - a.valor_perda)
        .slice(0, 8);

      // % perda por fornecedor
      const porForn = {};
      reg.forEach(c => {
        const k = c.fornecedor || 'Outros';
        if (!porForn[k]) porForn[k] = { bruto:0, limpo:0 };
        porForn[k].bruto += toNum(c.peso_bruto);
        porForn[k].limpo += toNum(c.peso_limpo);
      });
      const fornecedores = Object.entries(porForn)
        .map(([forn, v]) => ({
          forn,
          perda_pct: v.bruto > 0 ? (v.bruto - v.limpo) / v.bruto : 0,
          peso_bruto: v.bruto,
        }))
        .sort((a,b) => b.peso_bruto - a.peso_bruto);

      // Cortes acima da meta
      const acimaMeta = Object.entries(porCorte)
        .filter(([, v]) => v.bruto > 0 && (v.bruto - v.limpo) / v.bruto > metaPerda)
        .map(([corte, v]) => ({ corte, perda_pct: (v.bruto-v.limpo)/v.bruto }));

      res.json({ ok: true, data: {
        registros:    reg.length,
        insumos:      toNum(ins[0]?.total),
        fichas:       toNum(fichas[0]?.total),
        vendas:       toNum(vendas[0]?.total),
        faturamento:  toNum(vendas[0]?.faturamento),
        perda_media:  perdaMedia,
        meta_perda:   metaPerda,
        valor_perda:  valorPerda,
        custo_total:  custoTotal,
        total_bruto:  totalBruto,
        total_limpo:  totalLimpo,
        ranking,
        fornecedores,
        acima_meta:   acimaMeta,
      }});
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── REGISTROS ─────────────────────────────────────────────────────────────
  r.get('/registros', async (req, res) => {
    try {
      const { mes, corte, fornecedor } = req.query;
      const conds = [], params = [];
      if (mes) { params.push(mes); conds.push(`TO_CHAR(data,'MM/YYYY')=$${params.length}`); }
      if (corte) { params.push(`%${corte}%`); conds.push(`corte ILIKE $${params.length}`); }
      if (fornecedor && fornecedor !== 'todos') { params.push(fornecedor); conds.push(`fornecedor=$${params.length}`); }
      const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT * FROM cortes_registros ${where} ORDER BY data DESC, criado_em DESC LIMIT 500`, params
      );
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/registros', async (req, res) => {
    const { data, fornecedor, corte, peso_bruto, peso_limpo, custo_por_kg, margem, estoque, obs, produto_id } = req.body;
    if (!corte || !peso_bruto) return res.status(400).json({ ok:false, erro:'corte e peso_bruto obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO cortes_registros (data, fornecedor, corte, peso_bruto, peso_limpo, custo_por_kg, margem, estoque, obs, produto_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
      `, [data||new Date().toISOString().slice(0,10), fornecedor||null, corte,
          toNum(peso_bruto), toNum(peso_limpo), toNum(custo_por_kg),
          toNum(margem,0.30), toNum(estoque), obs||null, produto_id||null]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/registros/:id', async (req, res) => {
    const { data, fornecedor, corte, peso_bruto, peso_limpo, custo_por_kg, margem, estoque, obs } = req.body;
    try {
      const { rows } = await pool.query(`
        UPDATE cortes_registros SET
          data=$1, fornecedor=$2, corte=$3, peso_bruto=$4, peso_limpo=$5,
          custo_por_kg=$6, margem=$7, estoque=$8, obs=$9
        WHERE id=$10 RETURNING *
      `, [data, fornecedor||null, corte, toNum(peso_bruto), toNum(peso_limpo),
          toNum(custo_por_kg), toNum(margem,0.30), toNum(estoque), obs||null, req.params.id]);
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Não encontrado' });
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.delete('/registros/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM cortes_registros WHERE id=$1`, [req.params.id]);
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // PATCH /registros/:id/estoque — atualização rápida de estoque (edição inline)
  r.patch('/registros/:id/estoque', async (req, res) => {
    const { estoque } = req.body;
    try {
      const { rowCount } = await pool.query(
        `UPDATE cortes_registros SET estoque=$1 WHERE id=$2`,
        [toNum(estoque), req.params.id]
      );
      if (!rowCount) return res.status(404).json({ ok:false, erro:'Não encontrado' });
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── INSUMOS ───────────────────────────────────────────────────────────────
  r.get('/insumos', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cortes_insumos ORDER BY categoria, nome`);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/insumos', async (req, res) => {
    const { nome, categoria, preco_unit, unidade, estoque, fornecedor, produto_id } = req.body;
    if (!nome) return res.status(400).json({ ok:false, erro:'nome obrigatório' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO cortes_insumos (nome, categoria, preco_unit, unidade, estoque, fornecedor, produto_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (nome) DO UPDATE SET
          categoria=$2, preco_unit=$3, unidade=$4, estoque=$5,
          fornecedor=$6, produto_id=$7, atualizado_em=NOW()
        RETURNING *
      `, [nome, categoria||'Tempero', toNum(preco_unit), unidade||'kg',
          toNum(estoque), fornecedor||null, produto_id||null]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/insumos/:id', async (req, res) => {
    const { nome, categoria, preco_unit, unidade, estoque, fornecedor } = req.body;
    try {
      const { rows } = await pool.query(`
        UPDATE cortes_insumos SET nome=$1, categoria=$2, preco_unit=$3,
          unidade=$4, estoque=$5, fornecedor=$6, atualizado_em=NOW()
        WHERE id=$7 RETURNING *
      `, [nome, categoria||'Tempero', toNum(preco_unit), unidade||'kg',
          toNum(estoque), fornecedor||null, req.params.id]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.delete('/insumos/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM cortes_insumos WHERE id=$1`, [req.params.id]);
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── FICHAS TÉCNICAS ───────────────────────────────────────────────────────
  r.get('/fichas', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cortes_fichas ORDER BY produto`);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/fichas', async (req, res) => {
    const { produto, rendimento, kg_utilizado, multiplicador, itens, produto_id } = req.body;
    if (!produto) return res.status(400).json({ ok:false, erro:'produto obrigatório' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO cortes_fichas (produto, rendimento, kg_utilizado, multiplicador, itens, produto_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [produto, toNum(rendimento,1), kg_utilizado?toNum(kg_utilizado):null,
          toNum(multiplicador,2.5), JSON.stringify(itens||[]), produto_id||null]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/fichas/:id', async (req, res) => {
    const { produto, rendimento, kg_utilizado, multiplicador, itens, produto_id } = req.body;
    try {
      const { rows } = await pool.query(`
        UPDATE cortes_fichas SET produto=$1, rendimento=$2, kg_utilizado=$3,
          multiplicador=$4, itens=$5, produto_id=$6, atualizado_em=NOW()
        WHERE id=$7 RETURNING *
      `, [produto, toNum(rendimento,1), kg_utilizado?toNum(kg_utilizado):null,
          toNum(multiplicador,2.5), JSON.stringify(itens||[]), produto_id||null, req.params.id]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.delete('/fichas/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM cortes_fichas WHERE id=$1`, [req.params.id]);
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── VENDAS ────────────────────────────────────────────────────────────────
  r.get('/vendas', async (req, res) => {
    try {
      const { mes } = req.query;
      const conds = [], params = [];
      if (mes) { params.push(mes); conds.push(`TO_CHAR(data,'MM/YYYY')=$${params.length}`); }
      const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT * FROM cortes_vendas ${where} ORDER BY data DESC, criado_em DESC LIMIT 500`, params
      );
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/vendas', async (req, res) => {
    const { ficha_id, ficha_nome, qtd, preco_unit, custo_unit, data } = req.body;
    if (!ficha_nome || !qtd || !preco_unit) return res.status(400).json({ ok:false, erro:'dados incompletos' });
    try {
      const total = toNum(qtd) * toNum(preco_unit);
      const { rows } = await pool.query(`
        INSERT INTO cortes_vendas (ficha_id, ficha_nome, qtd, preco_unit, custo_unit, total, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [ficha_id||null, ficha_nome, toNum(qtd), toNum(preco_unit),
          toNum(custo_unit), total, data||new Date().toISOString().slice(0,10)]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.delete('/vendas/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM cortes_vendas WHERE id=$1`, [req.params.id]);
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── CONFIG ────────────────────────────────────────────────────────────────
  r.get('/config', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT chave, valor FROM cortes_config`);
      const cfg = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
      res.json({ ok:true, data:cfg });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/config', async (req, res) => {
    const entries = Object.entries(req.body);
    try {
      for (const [chave, valor] of entries) {
        await pool.query(`
          INSERT INTO cortes_config (chave, valor) VALUES ($1,$2)
          ON CONFLICT (chave) DO UPDATE SET valor=$2, atualizado_em=NOW()
        `, [chave, String(valor)]);
      }
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── RELATÓRIO MENSAL ──────────────────────────────────────────────────────
  r.get('/relatorio', async (req, res) => {
    try {
      const { mes } = req.query;
      const param = mes || new Date().toISOString().slice(0,7).split('-').reverse().join('/').slice(3)+'/'+ new Date().toISOString().slice(0,7).split('-')[0];
      const { rows } = await pool.query(`
        SELECT
          corte,
          COUNT(*) AS registros,
          SUM(peso_bruto)  AS total_bruto,
          SUM(peso_limpo)  AS total_limpo,
          SUM(peso_bruto - peso_limpo) AS total_perda,
          AVG(CASE WHEN peso_bruto > 0 THEN (peso_bruto - peso_limpo)/peso_bruto END) AS perda_media,
          AVG(custo_por_kg) AS custo_medio,
          SUM(peso_bruto * custo_por_kg) AS custo_total,
          ROUND(AVG(margem)::numeric, 4) AS margem_media
        FROM cortes_registros
        WHERE TO_CHAR(data,'MM/YYYY') = $1
        GROUP BY corte ORDER BY total_bruto DESC
      `, [mes||`${String(new Date().getMonth()+1).padStart(2,'0')}/${new Date().getFullYear()}`]);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Fornecedores usados em cortes (autocomplete) ──────────────────────────
  r.get('/fornecedores', async (req, res) => {
    try {
      // Combina fornecedores dos cortes + fornecedores dos boletos
      const { rows: fc } = await pool.query(
        `SELECT DISTINCT fornecedor FROM cortes_registros WHERE fornecedor IS NOT NULL ORDER BY fornecedor`
      );
      const { rows: fb } = await pool.query(
        `SELECT DISTINCT fornecedor FROM boletos WHERE fornecedor IS NOT NULL ORDER BY fornecedor LIMIT 50`
      ).catch(()=>({ rows:[] }));
      const todos = [...new Set([...fc.map(r=>r.fornecedor), ...fb.map(r=>r.fornecedor)])].sort();
      res.json({ ok:true, data:todos });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  return r;
};
