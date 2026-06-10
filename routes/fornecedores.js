const express    = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Garante tabela
  // Tabela de relacionamento fornecedor → produtos (populada pela importação de compras)
  pool.query(`
    CREATE TABLE IF NOT EXISTS fornecedor_produtos (
      id               SERIAL PRIMARY KEY,
      cnpj_fornecedor  TEXT NOT NULL,
      produto_codigo   TEXT NOT NULL,
      produto_nome     TEXT,
      ultima_compra    DATE,
      ultimo_preco     NUMERIC(12,4),
      compras_count    INT DEFAULT 1,
      atualizado_em    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(cnpj_fornecedor, produto_codigo)
    )
  `).catch(()=>{});

  pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fp_cnpj ON fornecedor_produtos(cnpj_fornecedor)
  `).catch(()=>{});

  pool.query(`
    CREATE TABLE IF NOT EXISTS fornecedores (
      id               SERIAL PRIMARY KEY,
      cnpj_fornecedor  TEXT UNIQUE,
      razao_social     TEXT NOT NULL,
      nome_fantasia    TEXT,
      contato          TEXT,
      telefone         TEXT,
      email            TEXT,
      endereco         TEXT,
      categoria_padrao TEXT,
      observacao       TEXT,
      ativo            BOOLEAN DEFAULT true,
      criado_em        TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(()=>{});

  // ── GET /api/fornecedores ────────────────────────────────
  router.get('/', autenticar(), async (req, res) => {
    const { q, ativo = 'true' } = req.query;
    const params = [ativo !== 'false'];
    let where = 'ativo = $1';

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (razao_social ILIKE $${params.length} OR nome_fantasia ILIKE $${params.length} OR cnpj_fornecedor LIKE $${params.length})`;
    }

    try {
      const { rows } = await pool.query(
        `SELECT * FROM fornecedores WHERE ${where} ORDER BY COALESCE(nome_fantasia, razao_social)`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('[fornecedores GET /]', err.message);
      res.status(500).json({ erro: 'Erro ao buscar fornecedores.' });
    }
  });

  // ── POST /api/fornecedores/sincronizar ──────────────────────────────────────
  // Popula fornecedores e fornecedor_produtos a partir do histórico de compras
  router.post('/sincronizar', autenticar(['admin','gestor']), async (req, res) => {
    try {
      // 1. Upsert de todos os fornecedores distintos em compras_produto
      const { rows: fornRows } = await pool.query(`
        SELECT DISTINCT
          REGEXP_REPLACE(fornecedor_cnpj, '[^0-9]', '', 'g') AS cnpj,
          MAX(fornecedor_nome) FILTER (WHERE fornecedor_nome IS NOT NULL) AS nome
        FROM compras_produto
        WHERE fornecedor_cnpj IS NOT NULL AND fornecedor_cnpj <> ''
        GROUP BY REGEXP_REPLACE(fornecedor_cnpj, '[^0-9]', '', 'g')
      `);

      // Limpar duplicatas de fornecedor_produtos com CNPJ formatado diferente
      await pool.query(`
        DELETE FROM fornecedor_produtos fp1
        USING fornecedor_produtos fp2
        WHERE fp1.id > fp2.id
          AND REGEXP_REPLACE(fp1.cnpj_fornecedor, '[^0-9]', '', 'g')
            = REGEXP_REPLACE(fp2.cnpj_fornecedor, '[^0-9]', '', 'g')
          AND fp1.produto_codigo = fp2.produto_codigo
      `).catch(() => {});

      // Normalizar CNPJs existentes em fornecedor_produtos
      await pool.query(`
        UPDATE fornecedor_produtos
        SET cnpj_fornecedor = REGEXP_REPLACE(cnpj_fornecedor, '[^0-9]', '', 'g')
        WHERE cnpj_fornecedor ~ '[^0-9]'
      `).catch(() => {});

      // Normalizar CNPJs em fornecedores
      await pool.query(`
        UPDATE fornecedores
        SET cnpj_fornecedor = REGEXP_REPLACE(cnpj_fornecedor, '[^0-9]', '', 'g')
        WHERE cnpj_fornecedor ~ '[^0-9]'
      `).catch(() => {});

      let novosForn = 0, novosProds = 0;

      for (const f of fornRows) {
        if (!f.cnpj || f.cnpj.length < 11) continue;
        const r = await pool.query(`
          INSERT INTO fornecedores (cnpj_fornecedor, razao_social)
          VALUES ($1, $2)
          ON CONFLICT (cnpj_fornecedor) DO UPDATE
            SET razao_social  = CASE
              WHEN fornecedores.razao_social IS NULL OR fornecedores.razao_social = ''
              THEN EXCLUDED.razao_social
              ELSE fornecedores.razao_social
            END,
            atualizado_em = NOW()
        `, [f.cnpj, f.nome || f.cnpj]);
        if (r.rowCount) novosForn++;
      }

      // 2. Upsert de todos os pares (fornecedor, produto) com agregados
      const { rows: prodRows } = await pool.query(`
        SELECT
          REGEXP_REPLACE(fornecedor_cnpj, '[^0-9]', '', 'g') AS cnpj,
          produto_codigo,
          MAX(produto_nome)                            AS produto_nome,
          MAX(data_entrada) FILTER (
            WHERE valor_unitario = (
              SELECT valor_unitario FROM compras_produto cp2
              WHERE cp2.fornecedor_cnpj = cp.fornecedor_cnpj
                AND cp2.produto_codigo  = cp.produto_codigo
              ORDER BY data_entrada DESC NULLS LAST LIMIT 1
            )
          )                                            AS ultima_compra,
          (SELECT cp3.valor_unitario FROM compras_produto cp3
           WHERE cp3.fornecedor_cnpj = cp.fornecedor_cnpj
             AND cp3.produto_codigo  = cp.produto_codigo
           ORDER BY cp3.data_entrada DESC NULLS LAST LIMIT 1
          )                                            AS ultimo_preco,
          COUNT(*)                                     AS compras_count
        FROM compras_produto cp
        WHERE fornecedor_cnpj IS NOT NULL
          AND produto_codigo   IS NOT NULL
        GROUP BY REGEXP_REPLACE(fornecedor_cnpj, '[^0-9]', '', 'g'), produto_codigo
      `);

      for (const p of prodRows) {
        if (!p.cnpj || !p.produto_codigo) continue;
        await pool.query(`
          INSERT INTO fornecedor_produtos
            (cnpj_fornecedor, produto_codigo, produto_nome,
             ultima_compra, ultimo_preco, compras_count)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (cnpj_fornecedor, produto_codigo) DO UPDATE
            SET produto_nome  = COALESCE(EXCLUDED.produto_nome, fornecedor_produtos.produto_nome),
                ultima_compra = GREATEST(EXCLUDED.ultima_compra, fornecedor_produtos.ultima_compra),
                ultimo_preco  = CASE
                  WHEN EXCLUDED.ultima_compra >= COALESCE(fornecedor_produtos.ultima_compra,'1900-01-01')
                  THEN EXCLUDED.ultimo_preco
                  ELSE fornecedor_produtos.ultimo_preco
                END,
                compras_count = GREATEST(EXCLUDED.compras_count, fornecedor_produtos.compras_count),
                atualizado_em = NOW()
        `, [p.cnpj, p.produto_codigo, p.produto_nome,
            p.ultima_compra, p.ultimo_preco, parseInt(p.compras_count) || 1]);
        novosProds++;
      }

      res.json({
        ok: true,
        fornecedores_sincronizados: novosForn,
        produtos_sincronizados:     novosProds,
        msg: `Sincronizados ${novosForn} fornecedor(es) e ${novosProds} produto(s) do histórico de compras.`
      });
    } catch(e) {
      console.error('[fornecedores/sincronizar]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /api/fornecedores/catalogo ──────────────────────────────────────────
  // Retorna todos os fornecedores com seus produtos agrupados (visão catálogo)
  router.get('/catalogo', autenticar(), async (req, res) => {
    try {
      const { q, forn } = req.query;

      // Buscar todos os fornecedores com produtos cadastrados
      const { rows } = await pool.query(`
        SELECT
          f.cnpj_fornecedor,
          COALESCE(f.nome_fantasia, f.razao_social)  AS nome_display,
          f.razao_social,
          f.nome_fantasia,
          f.categoria_padrao,
          COUNT(fp.produto_codigo)                   AS total_produtos,
          TO_CHAR(MAX(fp.ultima_compra), 'YYYY-MM-DD') AS ultima_compra,
          SUM(fp.compras_count)                      AS total_compras,
          json_agg(
            json_build_object(
              'produto_codigo', fp.produto_codigo,
              'produto_nome',   fp.produto_nome,
              'ultimo_preco',   fp.ultimo_preco,
              'ultima_compra',  TO_CHAR(fp.ultima_compra,'YYYY-MM-DD'),
              'compras_count',  fp.compras_count,
              'curva_abc',      p.curva_abc,
              'categoria',      p.categoria,
              'unidade',        p.unidade,
              'estoque',        p.estoque
            ) ORDER BY fp.compras_count DESC, fp.produto_nome
          ) AS produtos
        FROM fornecedores f
        INNER JOIN fornecedor_produtos fp ON fp.cnpj_fornecedor = REGEXP_REPLACE(f.cnpj_fornecedor, '[^0-9]', '', 'g')
        LEFT  JOIN produtos p ON p.codigo = fp.produto_codigo
        WHERE f.ativo = true
          ${q ? "AND (f.razao_social ILIKE '%' || $1 || '%' OR f.nome_fantasia ILIKE '%' || $1 || '%')" : ''}
          ${forn ? `AND f.cnpj_fornecedor = ${q ? '$2' : '$1'}` : ''}
        GROUP BY f.cnpj_fornecedor, f.razao_social, f.nome_fantasia, f.categoria_padrao
        ORDER BY nome_display
      `, [...(q ? [q] : []), ...(forn ? [forn] : [])]);

      res.json({ ok: true, data: rows });
    } catch(e) {
      console.error('[fornecedores/catalogo]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });


  // ── GET /api/fornecedores/:cnpj/produtos ────────────────────────────────────
  // Retorna todos os produtos já fornecidos por este fornecedor com histórico
  router.get('/:cnpj/produtos', autenticar(), async (req, res) => {
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    try {
      const { rows } = await pool.query(`
        SELECT
          fp.produto_codigo,
          fp.produto_nome,
          TO_CHAR(fp.ultima_compra, 'YYYY-MM-DD') AS ultima_compra,
          fp.ultimo_preco,
          fp.compras_count,
          fp.atualizado_em,
          p.descricao   AS descricao_cadastro,
          p.curva_abc,
          p.categoria,
          p.estoque     AS estoque_atual,
          p.unidade,
          -- Histórico de preços dos últimos 6 meses
          (SELECT json_agg(sub ORDER BY sub.data_entrada DESC)
           FROM (
             SELECT DISTINCT ON (TO_CHAR(cp2.data_entrada,'YYYY-MM'))
               TO_CHAR(cp2.data_entrada,'YYYY-MM-DD') AS data_entrada,
               cp2.valor_unitario,
               cp2.numero_nfe
             FROM compras_produto cp2
             WHERE cp2.fornecedor_cnpj = $1
               AND cp2.produto_codigo  = fp.produto_codigo
               AND cp2.data_entrada   >= NOW() - INTERVAL '6 months'
             ORDER BY TO_CHAR(cp2.data_entrada,'YYYY-MM'), cp2.data_entrada DESC
             LIMIT 6
           ) sub
          ) AS historico_precos
        FROM fornecedor_produtos fp
        LEFT JOIN produtos p ON p.codigo = fp.produto_codigo
        WHERE fp.cnpj_fornecedor = $1
        ORDER BY fp.compras_count DESC, fp.produto_nome
      `, [cnpj]);
      res.json({ ok: true, data: rows });
    } catch(e) {
      console.error('[fornecedores/:cnpj/produtos]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /api/fornecedores/:cnpj/resumo-compras ──────────────────────────────
  // KPIs de compras do fornecedor
  router.get('/:cnpj/resumo-compras', autenticar(), async (req, res) => {
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(DISTINCT numero_nfe)                              AS total_nfes,
          COUNT(DISTINCT produto_codigo)                          AS total_produtos,
          SUM(valor_total_liquido)                                AS total_comprado,
          MAX(data_entrada)                                       AS ultima_compra,
          MIN(data_entrada)                                       AS primeira_compra,
          COUNT(*)                                                AS total_itens
        FROM compras_produto
        WHERE fornecedor_cnpj = $1
      `, [cnpj]);
      res.json({ ok: true, data: rows[0] });
    } catch(e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /api/fornecedores/:cnpj ──────────────────────────
  router.get('/:cnpj', autenticar(), async (req, res) => {
    try {
      const cnpj = req.params.cnpj.replace(/\D/g, '');
      const { rows } = await pool.query(
        'SELECT * FROM fornecedores WHERE cnpj_fornecedor = $1',
        [cnpj]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar fornecedor.' });
    }
  });

  // ── POST /api/fornecedores ───────────────────────────────
  router.post('/', autenticar(), async (req, res) => {
    const {
      cnpj_fornecedor, razao_social, nome_fantasia,
      contato, telefone, email, endereco, categoria_padrao, observacao
    } = req.body;

    if (!cnpj_fornecedor || !razao_social)
      return res.status(400).json({ erro: 'cnpj_fornecedor e razao_social são obrigatórios.' });

    const cnpj = cnpj_fornecedor.replace(/\D/g, '');
    if (cnpj.length !== 14)
      return res.status(400).json({ erro: 'CNPJ inválido. Use 14 dígitos.' });

    try {
      const { rows } = await pool.query(
        `INSERT INTO fornecedores
           (cnpj_fornecedor, razao_social, nome_fantasia, contato, telefone,
            email, endereco, categoria_padrao, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [cnpj, razao_social.trim(), nome_fantasia||null, contato||null,
         telefone||null, email||null, endereco||null, categoria_padrao||null, observacao||null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ erro: 'CNPJ já cadastrado.' });
      console.error('[fornecedores POST]', err.message);
      res.status(500).json({ erro: 'Erro ao criar fornecedor.' });
    }
  });

  // ── PUT /api/fornecedores/:cnpj ──────────────────────────
  router.put('/:cnpj', autenticar(), async (req, res) => {
    const {
      razao_social, nome_fantasia, contato, telefone,
      email, endereco, categoria_padrao, observacao, ativo
    } = req.body;
    const cnpj = req.params.cnpj.replace(/\D/g, '');

    try {
      await pool.query(
        `UPDATE fornecedores SET
           razao_social    = COALESCE($1, razao_social),
           nome_fantasia   = COALESCE($2, nome_fantasia),
           contato         = COALESCE($3, contato),
           telefone        = COALESCE($4, telefone),
           email           = COALESCE($5, email),
           endereco        = COALESCE($6, endereco),
           categoria_padrao= COALESCE($7, categoria_padrao),
           observacao      = COALESCE($8, observacao),
           ativo           = COALESCE($9, ativo),
           atualizado_em   = NOW()
         WHERE cnpj_fornecedor = $10`,
        [razao_social||null, nome_fantasia||null, contato||null, telefone||null,
         email||null, endereco||null, categoria_padrao||null, observacao||null,
         ativo !== undefined ? ativo : null, cnpj]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao atualizar fornecedor.' });
    }
  });

  // ── GET /api/fornecedores/:cnpj/boletos ──────────────────
  router.get('/:cnpj/boletos', autenticar(['admin','gerente','financeiro']), async (req, res) => {
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    try {
      const { rows } = await pool.query(
        `SELECT * FROM boletos WHERE cnpj_fornecedor = $1 ORDER BY data_vencimento DESC LIMIT 50`,
        [cnpj]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar boletos do fornecedor.' });
    }
  });




  return router;
};
