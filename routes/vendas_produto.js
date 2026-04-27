/**
 * routes/vendas_produto.js
 * Análise de Vendas por Produto — Relatório 101 (XMenu)
 */
const express = require('express');
const r = express.Router();

module.exports = (pool) => {

  // ── Init tabelas ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendas_produto (
        id            SERIAL PRIMARY KEY,
        data_venda    DATE NOT NULL,
        codigo        TEXT NOT NULL,
        nome          TEXT NOT NULL,
        quantidade    NUMERIC(12,4) DEFAULT 0,
        valor_total   NUMERIC(14,2) DEFAULT 0,
        importacao_id INTEGER,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendas_importacoes (
        id          SERIAL PRIMARY KEY,
        nome_arquivo TEXT,
        periodo_ini  DATE,
        periodo_fim  DATE,
        total_linhas INTEGER,
        total_valor  NUMERIC(14,2),
        criado_em    TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vp_data    ON vendas_produto(data_venda)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vp_codigo  ON vendas_produto(codigo)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vp_import  ON vendas_produto(importacao_id)`).catch(()=>{});
  }
  initTable().catch(e => console.error('[vendas_produto] init:', e.message));

  // ── GET /importacoes ────────────────────────────────────────────────────────
  r.get('/importacoes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM vendas_importacoes ORDER BY criado_em DESC LIMIT 50`
      );
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /importar ──────────────────────────────────────────────────────────
  // Body: { nome_arquivo, linhas: [{data_venda, codigo, nome, quantidade, valor_total}], substituir: bool }
  r.post('/importar', async (req, res) => {
    const { nome_arquivo, linhas, substituir } = req.body;
    if (!linhas?.length) return res.status(400).json({ ok: false, erro: 'Sem linhas' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Detecta período
      const datas = linhas.map(l => l.data_venda).filter(Boolean).sort();
      const periodoIni = datas[0];
      const periodoFim = datas[datas.length - 1];

      // Substituir período existente?
      if (substituir) {
        await client.query(
          `DELETE FROM vendas_produto WHERE data_venda BETWEEN $1 AND $2`,
          [periodoIni, periodoFim]
        );
      }

      // Registra importação
      const imp = await client.query(
        `INSERT INTO vendas_importacoes (nome_arquivo, periodo_ini, periodo_fim, total_linhas, total_valor)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [nome_arquivo, periodoIni, periodoFim, linhas.length,
         linhas.reduce((s,l)=>s+parseFloat(l.valor_total||0),0)]
      );
      const impId = imp.rows[0].id;

      // Insere linhas em batch
      for (const l of linhas) {
        await client.query(
          `INSERT INTO vendas_produto (data_venda, codigo, nome, quantidade, valor_total, importacao_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [l.data_venda, String(l.codigo), l.nome,
           parseFloat(l.quantidade||0), parseFloat(l.valor_total||0), impId]
        );
      }

      await client.query('COMMIT');
      res.json({ ok: true, importacao_id: impId, total: linhas.length });
    } catch(e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── GET /resumo — KPIs por período ─────────────────────────────────────────
  r.get('/resumo', async (req, res) => {
    const { ini, fim } = req.query;
    try {
      const where = ini && fim ? `WHERE data_venda BETWEEN '${ini}' AND '${fim}'` : '';
      const { rows } = await pool.query(`
        SELECT
          COALESCE(SUM(valor_total),0)            AS fat_total,
          COALESCE(SUM(quantidade),0)              AS qtd_total,
          COUNT(DISTINCT codigo)                   AS produtos_distintos,
          COUNT(DISTINCT data_venda)               AS dias_com_venda,
          COALESCE(AVG(valor_total),0)             AS ticket_medio_item
        FROM vendas_produto ${where}
      `);
      const { rows: dias } = await pool.query(`
        SELECT TO_CHAR(data_venda,'YYYY-MM-DD') AS data_venda,
          SUM(valor_total) AS fat_dia, SUM(quantidade) AS qtd_dia
        FROM vendas_produto ${where}
        GROUP BY data_venda ORDER BY fat_dia DESC
      `);
      const { rows: top } = await pool.query(`
        SELECT codigo, nome,
          SUM(valor_total) AS fat_total,
          SUM(quantidade)  AS qtd_total,
          COUNT(DISTINCT data_venda) AS frequencia
        FROM vendas_produto ${where}
        GROUP BY codigo, nome ORDER BY fat_total DESC LIMIT 10
      `);
      res.json({ ok: true, kpis: rows[0], dias, top10: top });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /produtos — ranking completo com margem de lucro ──────────────────
  r.get('/produtos', async (req, res) => {
    const { ini, fim, ordem = 'fat', sem_taxa = '0', sem_kit = '0', sem_bebida = '0' } = req.query;
    try {
      const conds = [];
      if (ini && fim) conds.push(`data_venda BETWEEN '${ini}' AND '${fim}'`);
      if (sem_taxa   === '1') conds.push(`LOWER(vp.nome) NOT LIKE '%taxa%'`);
      if (sem_kit    === '1') conds.push(`LOWER(vp.nome) NOT LIKE '%kit%'`);
      if (sem_bebida === '1') conds.push(`LOWER(vp.nome) NOT SIMILAR TO '%(cerveja|heineken|brahma|skol|corona|amstel|budweiser|spaten|stella|sprite|coca|pepsi|agua|suco|refrigerante|vinho|espumante|dose|whisky)%'`);
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const orderBy = ordem === 'qtd' ? 'qtd_total DESC' : ordem === 'freq' ? 'frequencia DESC' : ordem === 'margem' ? 'margem_pct DESC NULLS LAST' : 'fat_total DESC';

      const { rows } = await pool.query(`
        SELECT
          vp.codigo,
          vp.nome,
          SUM(vp.valor_total)            AS fat_total,
          SUM(vp.quantidade)             AS qtd_total,
          COUNT(DISTINCT vp.data_venda)  AS frequencia,
          ROUND(SUM(vp.valor_total)/NULLIF(SUM(vp.quantidade),0), 2)  AS preco_medio,
          -- Vincula com tabela de produtos pelo código
          MAX(p.preco_custo)   AS preco_custo_unit,
          MAX(p.preco_venda)   AS preco_venda_cad,
          -- Custo total estimado = quantidade × custo unitário
          ROUND(SUM(vp.quantidade) * COALESCE(MAX(p.preco_custo), 0), 2) AS custo_total,
          -- Lucro bruto = faturamento - custo total
          ROUND(SUM(vp.valor_total) - SUM(vp.quantidade) * COALESCE(MAX(p.preco_custo), 0), 2) AS lucro_bruto,
          -- Margem % = lucro / faturamento
          CASE
            WHEN SUM(vp.valor_total) > 0 AND MAX(p.preco_custo) IS NOT NULL AND MAX(p.preco_custo) > 0
            THEN ROUND((1 - SUM(vp.quantidade) * MAX(p.preco_custo) / SUM(vp.valor_total)) * 100, 1)
            ELSE NULL
          END AS margem_pct
        FROM vendas_produto vp
        LEFT JOIN produtos p ON p.codigo = vp.codigo AND p.ativo = true
        ${where}
        GROUP BY vp.codigo, vp.nome
        ORDER BY ${orderBy}
      `);

      // Curva ABC por faturamento
      const fatTotal = rows.reduce((s,r)=>s+parseFloat(r.fat_total),0);
      let acum = 0;
      // Ordena por fat para calcular ABC mesmo se ordenação for outra
      const porFat = [...rows].sort((a,b)=>parseFloat(b.fat_total)-parseFloat(a.fat_total));
      const abcMap = {};
      let acumAbc = 0;
      for (const r of porFat) {
        acumAbc += parseFloat(r.fat_total);
        const pct = fatTotal > 0 ? acumAbc/fatTotal*100 : 0;
        abcMap[r.codigo] = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
      }
      const comABC = rows.map(r => ({ ...r, abc: abcMap[r.codigo] || 'C' }));

      // Estatísticas de margem para insights
      const comMargem = comABC.filter(r => r.margem_pct !== null);
      const semCusto  = comABC.filter(r => r.margem_pct === null).length;

      res.json({ ok: true, data: comABC, total: rows.length, semCusto });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /por-dia-semana ─────────────────────────────────────────────────────
  r.get('/por-dia-semana', async (req, res) => {
    const { ini, fim } = req.query;
    try {
      const where = ini && fim ? `WHERE vp.data_venda BETWEEN '${ini}' AND '${fim}'` : '';
      const { rows } = await pool.query(`
        SELECT
          EXTRACT(DOW FROM vp.data_venda)  AS dow,
          SUM(vp.valor_total)              AS fat_total,
          SUM(vp.quantidade)               AS qtd_total,
          COUNT(DISTINCT vp.data_venda)    AS num_dias,
          ROUND(SUM(vp.valor_total)/NULLIF(COUNT(DISTINCT vp.data_venda),0),2) AS fat_medio_dia,
          -- Lucro bruto via JOIN com custos
          ROUND(SUM(vp.valor_total) - SUM(vp.quantidade * COALESCE(p.preco_custo,0)), 2) AS lucro_bruto,
          CASE WHEN SUM(vp.valor_total) > 0
            THEN ROUND((1 - SUM(vp.quantidade * COALESCE(p.preco_custo,0)) / SUM(vp.valor_total)) * 100, 1)
            ELSE NULL
          END AS margem_pct
        FROM vendas_produto vp
        LEFT JOIN produtos p ON p.codigo = vp.codigo AND p.ativo = true
        ${where}
        GROUP BY EXTRACT(DOW FROM vp.data_venda)
        ORDER BY EXTRACT(DOW FROM vp.data_venda)
      `);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /top-por-dia-semana ─────────────────────────────────────────────────
  r.get('/top-por-dia-semana', async (req, res) => {
    const { ini, fim, limite = '5' } = req.query;
    try {
      const where = ini && fim ? `AND data_venda BETWEEN '${ini}' AND '${fim}'` : '';
      const { rows } = await pool.query(`
        WITH ranked AS (
          SELECT
            EXTRACT(DOW FROM data_venda) AS dow,
            codigo, nome,
            SUM(valor_total) AS fat_total,
            SUM(quantidade)  AS qtd_total,
            ROW_NUMBER() OVER (
              PARTITION BY EXTRACT(DOW FROM data_venda)
              ORDER BY SUM(valor_total) DESC
            ) AS rn
          FROM vendas_produto
          WHERE 1=1 ${where}
          GROUP BY EXTRACT(DOW FROM data_venda), codigo, nome
        )
        SELECT * FROM ranked WHERE rn <= ${parseInt(limite)}
        ORDER BY dow, rn
      `);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /por-data ───────────────────────────────────────────────────────────
  r.get('/por-data', async (req, res) => {
    const { ini, fim } = req.query;
    try {
      const where = ini && fim ? `WHERE data_venda BETWEEN '${ini}' AND '${fim}'` : '';
      const { rows } = await pool.query(`
        SELECT TO_CHAR(data_venda,'YYYY-MM-DD') AS data_venda,
          SUM(valor_total)           AS fat_total,
          SUM(quantidade)            AS qtd_total,
          COUNT(DISTINCT codigo)     AS produtos_distintos,
          EXTRACT(DOW FROM data_venda) AS dow
        FROM vendas_produto ${where}
        GROUP BY data_venda ORDER BY data_venda
      `);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /importacoes/:id ─────────────────────────────────────────────────
  r.delete('/importacoes/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM vendas_produto WHERE importacao_id=$1`, [req.params.id]);
      await pool.query(`DELETE FROM vendas_importacoes WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
