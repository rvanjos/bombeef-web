/**
 * routes/produtos.js — M3: Produtos
 *
 * Rotas:
 *   GET    /api/produtos              → lista produtos
 *   GET    /api/produtos/:id          → detalhe
 *   POST   /api/produtos              → cria produto
 *   PUT    /api/produtos/:id          → atualiza
 *   DELETE /api/produtos/:id          → inativa (soft delete)
 *   POST   /api/produtos/import       → importa planilha PDV (XLSX)
 *   GET    /api/produtos/kpis         → KPIs
 */

const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const autenticar = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.UPLOAD_MAX_MB) || 15) * 1024 * 1024 },
});

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id            SERIAL PRIMARY KEY,
        codigo        TEXT UNIQUE NOT NULL,
        descricao     TEXT NOT NULL,
        fornecedor    TEXT,
        preco_custo   NUMERIC(10,4) DEFAULT 0,
        preco_venda   NUMERIC(10,4) DEFAULT 0,
        unidade       TEXT DEFAULT 'un',
        categoria     TEXT,
        ativo         BOOLEAN DEFAULT true,
        origem        TEXT DEFAULT 'manual',
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_produtos_codigo     ON produtos(codigo);
      CREATE INDEX IF NOT EXISTS idx_produtos_descricao  ON produtos(descricao);
      CREATE INDEX IF NOT EXISTS idx_produtos_fornecedor ON produtos(fornecedor);
    `);
  }
  initTable().catch(e => console.error('[produtos] initTable:', e.message));

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      // Verifica se coluna data_ultima_importacao existe
      const colCheck = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='produtos' AND column_name='data_ultima_importacao'
      `);
      const temDataImport = colCheck.rows.length > 0;

      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ativo = true)           AS ativos,
          COUNT(*) FILTER (WHERE ativo = false)          AS inativos,
          COUNT(DISTINCT fornecedor) FILTER (WHERE ativo) AS fornecedores,
          ROUND(AVG(preco_venda) FILTER (WHERE ativo AND preco_venda > 0), 2) AS preco_medio,
          MAX(COALESCE(atualizado_em, '1970-01-01')) AS ultima_atualizacao
          ${temDataImport ? `, MAX(GREATEST(COALESCE(data_ultima_importacao,'1970-01-01'::timestamptz), COALESCE(atualizado_em,'1970-01-01'::timestamptz))) AS ultima_import` : ''}
        FROM produtos
      `);
      res.json({ ok: true, data: {
        ativos:            parseInt(rows[0].ativos),
        inativos:          parseInt(rows[0].inativos),
        fornecedores:      parseInt(rows[0].fornecedores),
        precoMedio:        parseFloat(rows[0].preco_medio || 0),
        ultimaAtualizacao: rows[0].ultima_import || rows[0].ultima_atualizacao || null,
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { busca, fornecedor, categoria, ativo = 'true' } = req.query;
      const conds = [], params = [];

      if (ativo !== 'todos') {
        params.push(ativo === 'false' ? false : true);
        conds.push(`ativo = $${params.length}`);
      }
      if (fornecedor) { params.push(`%${fornecedor}%`); conds.push(`fornecedor ILIKE $${params.length}`); }
      if (categoria)  { params.push(`%${categoria}%`);  conds.push(`categoria ILIKE $${params.length}`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(codigo ILIKE $${params.length} OR descricao ILIKE $${params.length} OR fornecedor ILIKE $${params.length})`);
      }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT * FROM produtos ${where} ORDER BY descricao ASC${busca ? ' LIMIT 12' : ''}`, params
      );
      res.json({ ok: true, data: rows, total: rows.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /:id ───────────────────────────────────────────────────────────────
  r.get('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      // Busca por CÓDIGO primeiro (código PDV tem prioridade sobre id interno)
      // Resolve o bug: código '49' retornava produto com id=49 (errado)
      let { rows } = await pool.query(
        `SELECT * FROM produtos WHERE codigo = $1 AND ativo = true LIMIT 1`, [id]
      );
      if (!rows.length) {
        // Fallback: busca por id interno numérico
        const numId = parseInt(id);
        if (!isNaN(numId)) {
          ({ rows } = await pool.query(
            `SELECT * FROM produtos WHERE id = $1`, [numId]
          ));
        }
      }
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const p = req.body;
    if (!p.codigo || !p.descricao) return res.status(400).json({ ok: false, erro: 'codigo e descricao obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO produtos (codigo, descricao, fornecedor, preco_custo, preco_venda, unidade, categoria, origem)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [p.codigo.trim(), p.descricao.trim(), p.fornecedor || null,
          parseFloat(p.precoCusto || p.preco_custo) || 0,
          parseFloat(p.precoVenda || p.preco_venda) || 0,
          p.unidade || 'un', p.categoria || null, p.origem || 'manual']);
      res.json({ ok: true, data: rows[0] });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'Código de produto já existe' });
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const p = req.body;
    try {
      const numId = parseInt(req.params.id);
      const idClause = !isNaN(numId)
        ? `(id = ${numId} OR codigo = $8)`
        : `codigo = $8`;
      const { rowCount } = await pool.query(`
        UPDATE produtos SET
          descricao     = COALESCE($1, descricao),
          fornecedor    = COALESCE($2, fornecedor),
          preco_custo   = COALESCE($3, preco_custo),
          preco_venda   = COALESCE($4, preco_venda),
          unidade       = COALESCE($5, unidade),
          categoria     = COALESCE($6, categoria),
          ativo         = COALESCE($7, ativo),
          atualizado_em = NOW()
        WHERE ${idClause}
      `, [
        p.descricao || null, p.fornecedor || null,
        p.precoCusto !== undefined ? parseFloat(p.precoCusto) : null,
        p.precoVenda !== undefined ? parseFloat(p.precoVenda) : null,
        p.unidade || null, p.categoria || null,
        p.ativo !== undefined ? p.ativo : null,
        req.params.id,
      ]);
      if (rowCount === 0) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      const numId = parseInt(req.params.id);
      if (!isNaN(numId)) {
        await pool.query(`UPDATE produtos SET ativo=false, atualizado_em=NOW() WHERE id=$1 OR codigo=$2`, [numId, req.params.id]);
      } else {
        await pool.query(`UPDATE produtos SET ativo=false, atualizado_em=NOW() WHERE codigo=$1`, [req.params.id]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import ── importa planilha PDV (XLSX, CSV padrão, CSV ChefWeb UTF-16) ─
  r.post('/import', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });

    try {
      const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
      let rows = [];

      // ── Detecta se é CSV UTF-16 (ChefWeb / TOTVS) ─────────────────────────
      const isUtf16 = req.file.buffer[0] === 0xFF && req.file.buffer[1] === 0xFE;
      const isChefweb = isUtf16 || (ext === 'csv' && req.file.buffer.toString('latin1', 0, 50).includes(';'));

      if (isChefweb || (ext === 'csv' && !isUtf16)) {
        // Parse CSV manual — suporta UTF-16 LE e UTF-8
        let txt;
        if (isUtf16) {
          txt = req.file.buffer.toString('utf16le');
        } else {
          // Tenta UTF-8 primeiro; se tiver caracteres inválidos, cai para latin1
          txt = req.file.buffer.toString('utf8');
          if (txt.includes('�')) {
            txt = req.file.buffer.toString('latin1');
          }
        }
        // Normaliza: remove BOM e normaliza acentos para comparação
        txt = txt.replace(/^\uFEFF/, '');

        const lines = txt.split(/\r?\n/);

        // Detecta separador
        const sep = lines.find(l => l.includes(';')) ? ';' : ',';

        // Encontra linha de cabeçalho real
        const normStr = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        let headerIdx = -1;
        for (let i = 0; i < Math.min(lines.length, 15); i++) {
          const l = normStr(lines[i]);
          if (l.includes('codigoproduto') || l.includes('codigo') || l.includes('nomeproduto') || l.includes('produto')) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx < 0) headerIdx = 0;

        const header = lines[headerIdx].split(sep).map(c => c.replace(/^"|"$/g, '').trim());
        rows.push(header);

        for (let i = headerIdx + 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const cols = line.split(sep).map(c => c.replace(/^"|"$/g, '').trim());
          rows.push(cols);
        }
      } else {
        // XLSX / XLS
        const wb    = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        // Pula linhas iniciais vazias ou sem conteúdo relevante
        const normStr2 = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        let startIdx = 0;
        for (let i = 0; i < Math.min(allRows.length, 10); i++) {
          const rowStr = allRows[i].map(normStr2).join('|');
          if (rowStr.includes('codigo') || rowStr.includes('produto') || rowStr.includes('codigoproduto')) {
            startIdx = i;
            break;
          }
        }
        rows = allRows.slice(startIdx);
      }

      if (rows.length < 2) {
        return res.status(422).json({ ok: false, erro: 'Planilha vazia ou sem cabeçalho' });
      }

      // Normaliza header: sem acentos, minúsculo
      const normH = s => String(s).toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const header    = rows[0].map(c => String(c).toLowerCase().trim());
      const headerNorm= rows[0].map(c => normH(c));

      // Mapeamento de colunas — suporta ChefWeb, TOTVS, Xmenu e planilhas genéricas
      const col = (nomes) => {
        for (const n of nomes) {
          const nn = normH(n);
          const i = headerNorm.findIndex(h => h === nn || h.includes(nn));
          if (i >= 0) return i;
        }
        return -1;
      };

      const colCod   = col(['codigoproduto', 'código', 'codigo', 'cod', 'sku', 'id']);
      const colDesc  = col(['nomeproduto', 'descrição', 'descricao', 'produto', 'desc', 'item', 'nome']);
      const colForn  = col(['fornecedor', 'supplier', 'marca']);
      const colCusto = col(['precocompra', 'precodecompra', 'custo', 'preco custo', 'preco de compra', 'p. custo', 'cost']);
      const colVenda = col(['precovenda', 'precodevenda', 'preco venda', 'preco de venda', 'p. venda', 'venda', 'sale']);
      const colUnit  = col(['unidade', 'unid', 'unit', 'un']);
      const colCat   = col(['categoria', 'category', 'grupo', 'depart', 'subcategoria']);

      console.log('[produtos/import] header:', header);
      console.log('[produtos/import] cols:', { colCod, colDesc, colForn, colCusto, colVenda, colUnit, colCat });

      if (colCod < 0 || colDesc < 0) {
        return res.status(422).json({
          ok: false,
          erro: `Não foi possível identificar colunas de código e descrição.\nCabeçalho detectado: ${header.slice(0,8).join(' | ')}`,
          cabecalho: header,
        });
      }

      const parseNum = v => {
        if (typeof v === 'number') return v;
        return parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
      };

      const client = await pool.connect();
      let inseridos = 0, atualizados = 0, erros = 0;
      const detalheErros = [];

      try {
        await client.query('BEGIN');

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const codigo    = String(row[colCod]  ?? '').trim();
          const descricao = String(row[colDesc] ?? '').trim();
          if (!codigo || !descricao) continue;
          // Pula linhas de totais ou cabeçalhos repetidos
          if (descricao.toLowerCase().includes('total') && isNaN(parseInt(codigo))) continue;

          const fornecedor = colForn >= 0 ? String(row[colForn] ?? '').trim() || null : null;
          const custo      = colCusto >= 0 ? parseNum(row[colCusto]) : 0;
          const venda      = colVenda >= 0 ? parseNum(row[colVenda]) : 0;
          const unidade    = colUnit  >= 0 ? String(row[colUnit] ?? 'un').trim().toUpperCase() || 'UN' : 'UN';
          const categoria  = colCat   >= 0 ? String(row[colCat]  ?? '').trim() || null : null;

          // Ignora produtos com preço de venda E custo ambos zerados (Xmenu: itens inativos)
          if (custo === 0 && venda === 0) continue;

          try {
            await client.query(`
              INSERT INTO produtos (codigo, descricao, fornecedor, preco_custo, preco_venda, unidade, categoria, origem)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'pdv')
              ON CONFLICT (codigo) DO UPDATE SET
                descricao     = EXCLUDED.descricao,
                fornecedor    = COALESCE(EXCLUDED.fornecedor, produtos.fornecedor),
                preco_custo   = CASE WHEN EXCLUDED.preco_custo > 0 THEN EXCLUDED.preco_custo ELSE produtos.preco_custo END,
                preco_venda   = CASE WHEN EXCLUDED.preco_venda > 0 THEN EXCLUDED.preco_venda ELSE produtos.preco_venda END,
                unidade       = EXCLUDED.unidade,
                categoria     = COALESCE(EXCLUDED.categoria, produtos.categoria),
                atualizado_em = NOW()
            `, [codigo, descricao, fornecedor, custo, venda, unidade, categoria]);

            const chk = await client.query(
              `SELECT (xmin::text::bigint != xmax::text::bigint) AS is_update FROM produtos WHERE codigo = $1`, [codigo]
            );
            if (chk.rows[0]?.is_update) atualizados++;
            else inseridos++;
          } catch (e) {
            erros++;
            detalheErros.push({ linha: i + 1, codigo, erro: e.message });
          }
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }

      res.json({ ok: true, inseridos, atualizados, erros, detalheErros });
    } catch (e) {
      console.error('[produtos/import]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro ao processar planilha: ' + e.message });
    }
  });

  return r;
};
