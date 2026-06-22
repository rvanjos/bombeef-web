/**
 * routes/vendas_produto.js
 * Análise de Vendas por Produto — Relatório 101 (XMenu)
 */
const express = require('express');
const r = express.Router();

const autenticar = require('../middleware/auth');
const events     = require('../lib/events');

module.exports = (pool, app) => {
  r.use(autenticar());

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

      // ── F2-07: registrar VENDA_ANALYTICS em movimentos_estoque (try/catch isolado) ──
      // Rastreabilidade pura — NÃO altera produtos.estoque
      try {
        // Agrupar linhas por codigo+data para evitar 1 INSERT por linha
        const agrupado = {};
        for (const l of linhas) {
          const key = `${l.codigo}|${l.data_venda}`;
          if (!agrupado[key]) agrupado[key] = { codigo: String(l.codigo), nome: l.nome, data: l.data_venda, qtd: 0, valor: 0 };
          agrupado[key].qtd   += parseFloat(l.quantidade || 0);
          agrupado[key].valor += parseFloat(l.valor_total || 0);
        }
        for (const it of Object.values(agrupado)) {
          if (!it.qtd || it.qtd <= 0) continue;
          // Buscar produto_id por codigo (pode não existir — não falha)
          const prod = await pool.query(
            `SELECT id FROM produtos WHERE codigo = $1 LIMIT 1`, [it.codigo]
          );
          const prodId = prod.rows[0]?.id || null;
          await pool.query(`
            INSERT INTO movimentos_estoque
              (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
               quantidade, estoque_anterior, estoque_posterior,
               usuario_id, observacao, data_movimento)
            VALUES ($1,$2,'VENDA_ANALYTICS','vendas_produto',$3,
                    -$4::numeric, NULL, NULL,
                    $5, $6, $7::date)
          `, [
            prodId, it.codigo, impId,
            it.qtd,
            req.usuario?.id || null,
            `Venda XMenu: ${it.nome} — ${it.qtd.toFixed(3)} un`,
            it.data,
          ]);
        }
        events.emit(app, 'MOVIMENTO_ESTOQUE', {
          origem:    'vendas_produto',
          origem_id: impId,
          tipo:      'VENDA_ANALYTICS',
          total:     Object.keys(agrupado).length,
        });
      } catch(eMov) {
        console.warn('[vendas_produto] F2-07 movimento falhou (não crítico):', eMov.message);
      }

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

      // ── Cruzamento com faturamento_periodos para calcular desconto real ──
      let fat_liquido_pdv = null, desconto_pdv = null;
      try {
        const fatWhere = ini && fim
          ? `WHERE tipo_periodo='dia' AND data_inicio BETWEEN '${ini}' AND '${fim}'`
          : `WHERE tipo_periodo='dia'`;
        const { rows: fatRows } = await pool.query(`
          SELECT COALESCE(SUM(fat_liquido),0) AS fat_liq,
                 COALESCE(SUM(descontos),0)   AS descontos
          FROM faturamento_periodos ${fatWhere}
        `);
        if (fatRows.length) {
          fat_liquido_pdv = parseFloat(fatRows[0].fat_liq);
          desconto_pdv    = parseFloat(fatRows[0].descontos);
        }
      } catch(e) { /* faturamento_periodos pode não existir — ignora */ }

      const kpis = {
        ...rows[0],
        fat_liquido_pdv,
        desconto_pdv,
        desconto_calc: fat_liquido_pdv != null
          ? Math.max(0, parseFloat(rows[0].fat_total) - fat_liquido_pdv)
          : null,
      };

      res.json({ ok: true, kpis, dias, top10: top });
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


  // ── GET /margem-real ── Sprint 4.3 ─────────────────────────────────────────
  // Cruza vendas_produto × produtos para calcular margem real por produto
  // Custo usado (por prioridade): custo_medio_90d → ultimo_custo → preco_custo (fallback)
  r.get('/margem-real', async (req, res) => {
    try {
      const { ini, fim, categoria, abc, ordem = 'lucro' } = req.query;
      const conds = [];
      const params = [];

      if (ini && fim) {
        params.push(ini, fim);
        conds.push(`vp.data_venda BETWEEN $${params.length-1} AND $${params.length}`);
      } else if (ini) {
        params.push(ini);
        conds.push(`vp.data_venda >= $${params.length}`);
      } else if (fim) {
        params.push(fim);
        conds.push(`vp.data_venda <= $${params.length}`);
      }

      if (categoria) {
        params.push(categoria);
        conds.push(`p.categoria = $${params.length}`);
      }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      const orderBy = {
        lucro:    'lucro_bruto DESC NULLS LAST',
        margem:   'margem_pct DESC NULLS LAST',
        fat:      'faturamento DESC',
        qtd:      'qtd_vendida DESC',
        custo:    'cmv_estimado DESC NULLS LAST',
      }[ordem] || 'lucro_bruto DESC NULLS LAST';

      const { rows } = await pool.query(`
        SELECT
          vp.codigo,
          vp.nome                                                         AS produto_nome,
          p.categoria,
          p.curva_abc,
          p.preco_venda                                                   AS preco_venda_cadastrado,
          SUM(vp.quantidade)                                              AS qtd_vendida,
          ROUND(SUM(vp.valor_total), 2)                                   AS faturamento,
          ROUND(SUM(vp.valor_total) / NULLIF(SUM(vp.quantidade), 0), 4)  AS preco_medio_realizado,
          COUNT(DISTINCT vp.data_venda)                                   AS dias_com_venda,
          -- Custo: prioridade custo_medio_90d > ultimo_custo > preco_custo
          COALESCE(
            NULLIF(MAX(p.custo_medio_90d), 0),
            NULLIF(MAX(p.ultimo_custo), 0),
            NULLIF(MAX(p.preco_custo), 0)
          )                                                               AS custo_unit_usado,
          CASE
            WHEN MAX(p.custo_medio_90d) IS NOT NULL AND MAX(p.custo_medio_90d) > 0 THEN 'custo_medio_90d'
            WHEN MAX(p.ultimo_custo) IS NOT NULL AND MAX(p.ultimo_custo) > 0        THEN 'ultimo_custo'
            WHEN MAX(p.preco_custo) IS NOT NULL AND MAX(p.preco_custo) > 0          THEN 'preco_custo'
            ELSE 'sem_custo'
          END                                                             AS fonte_custo,
          -- CMV estimado = quantidade vendida × custo unitário usado
          ROUND(
            SUM(vp.quantidade) * COALESCE(
              NULLIF(MAX(p.custo_medio_90d), 0),
              NULLIF(MAX(p.ultimo_custo), 0),
              NULLIF(MAX(p.preco_custo), 0)
            ), 2
          )                                                               AS cmv_estimado,
          -- Lucro bruto = faturamento - CMV
          ROUND(
            SUM(vp.valor_total) - SUM(vp.quantidade) * COALESCE(
              NULLIF(MAX(p.custo_medio_90d), 0),
              NULLIF(MAX(p.ultimo_custo), 0),
              NULLIF(MAX(p.preco_custo), 0)
            ), 2
          )                                                               AS lucro_bruto,
          -- Margem % = (faturamento - CMV) / faturamento × 100
          CASE
            WHEN SUM(vp.valor_total) > 0 AND COALESCE(
              NULLIF(MAX(p.custo_medio_90d), 0),
              NULLIF(MAX(p.ultimo_custo), 0),
              NULLIF(MAX(p.preco_custo), 0)
            ) IS NOT NULL
            THEN ROUND(
              (1 - SUM(vp.quantidade) * COALESCE(
                NULLIF(MAX(p.custo_medio_90d), 0),
                NULLIF(MAX(p.ultimo_custo), 0),
                NULLIF(MAX(p.preco_custo), 0)
              ) / SUM(vp.valor_total)) * 100, 1)
            ELSE NULL
          END                                                             AS margem_pct,
          -- Alerta: custo subiu mas preço não foi reajustado
          ROUND((MAX(p.ultimo_custo) - MAX(p.preco_custo)) / NULLIF(MAX(p.preco_custo), 0) * 100, 1)
                                                                          AS variacao_custo_vs_cadastro,
          MAX(p.tendencia_custo)                                          AS tendencia_custo,
          MAX(p.variacao_custo_pct)                                       AS variacao_ultimo_custo_pct
        FROM vendas_produto vp
        LEFT JOIN produtos p ON p.codigo = vp.codigo AND p.ativo = true
        ${where}
        GROUP BY vp.codigo, vp.nome, p.categoria, p.curva_abc, p.preco_venda
        ORDER BY ${orderBy}
      `, params);

      // Filtro por ABC (feito em memória pois curva_abc vem do cadastro)
      const filtrado = abc ? rows.filter(r => r.curva_abc === abc) : rows;

      // Totalizadores
      const totalFat    = filtrado.reduce((s, r) => s + parseFloat(r.faturamento || 0), 0);
      const totalCMV    = filtrado.reduce((s, r) => s + parseFloat(r.cmv_estimado || 0), 0);
      const totalLucro  = filtrado.reduce((s, r) => s + parseFloat(r.lucro_bruto || 0), 0);
      const semCusto    = filtrado.filter(r => r.fonte_custo === 'sem_custo').length;
      const comCusto90d = filtrado.filter(r => r.fonte_custo === 'custo_medio_90d').length;

      res.json({
        ok: true,
        data: filtrado,
        resumo: {
          total_produtos:   filtrado.length,
          sem_custo:        semCusto,
          com_custo_90d:    comCusto90d,
          faturamento_total: parseFloat(totalFat.toFixed(2)),
          cmv_total:         parseFloat(totalCMV.toFixed(2)),
          lucro_bruto_total: parseFloat(totalLucro.toFixed(2)),
          margem_media_pct:  totalFat > 0
            ? parseFloat(((1 - totalCMV / totalFat) * 100).toFixed(1))
            : null,
        },
      });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
