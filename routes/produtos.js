/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
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
        estoque       NUMERIC(12,3) DEFAULT 0,
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
  // initTable + migration síncronos
  (async () => {
    try {
      await initTable();
      // Migration: garante coluna estoque
      await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque NUMERIC(12,3) DEFAULT 0`);
      console.log('[produtos] coluna estoque OK');
    } catch(e) {
      console.error('[produtos] init error:', e.message);
    }
  })();

  // ── GET /fix-estoque — força migration da coluna estoque (uso único) ────────
  r.get('/fix-estoque', async (req, res) => {
    try {
      await pool.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque NUMERIC(12,3) DEFAULT 0`);
      const { rows } = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name='produtos' 
        ORDER BY ordinal_position
      `);
      const { rows: sample } = await pool.query(
        `SELECT codigo, descricao, estoque FROM produtos WHERE estoque IS NOT NULL LIMIT 5`
      );
      res.json({ ok: true, colunas: rows.map(r=>r.column_name), sample });
    } catch(e) {
      res.json({ ok: false, erro: e.message });
    }
  });

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
  // ── GET /buscar?q= — busca por código ou nome (autocomplete) ────────────────
  r.get('/buscar', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ ok: true, data: [] });
    try {
      const { rows } = await pool.query(`
        SELECT id, codigo, descricao, preco_custo, preco_venda, unidade
        FROM produtos
        WHERE ativo = true
          AND (
            codigo ILIKE $1
            OR descricao ILIKE $1
          )
        ORDER BY
          CASE WHEN codigo ILIKE $2 THEN 0
               WHEN descricao ILIKE $2 THEN 1
               ELSE 2 END,
          descricao ASC
        LIMIT 10
      `, [`%${q}%`, `${q}%`]);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

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
          estoque       = COALESCE($9, estoque),
          atualizado_em = NOW()
        WHERE ${idClause}
      `, [
        p.descricao || null, p.fornecedor || null,
        p.precoCusto !== undefined ? parseFloat(p.precoCusto) : null,
        p.precoVenda !== undefined ? parseFloat(p.precoVenda) : null,
        p.unidade || null, p.categoria || null,
        p.ativo !== undefined ? p.ativo : null,
        req.params.id,
        p.estoque !== undefined && p.estoque !== null ? parseFloat(p.estoque) : null,
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
        // Corrige !ref incorreto (bug em planilhas Xmenu e similares)
        // O range declarado pode ser menor que os dados reais — recalcula
        const decoded = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
        // Percorre todas as células para achar o range real
        let maxR = decoded.e.r, maxC = decoded.e.c;
        for (const addr of Object.keys(sheet)) {
          if (addr[0] === '!') continue;
          const cell = XLSX.utils.decode_cell(addr);
          if (cell.r > maxR) maxR = cell.r;
          if (cell.c > maxC) maxC = cell.c;
        }
        if (maxR > decoded.e.r || maxC > decoded.e.c) {
          sheet['!ref'] = XLSX.utils.encode_range({ s: decoded.s, e: { r: maxR, c: maxC } });
        }
        const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        // Pula linhas iniciais vazias
        let startIdx = 0;
        for (let i = 0; i < Math.min(allRows.length, 10); i++) {
          const nonEmpty = allRows[i].filter(c => String(c).trim() !== '').length;
          if (nonEmpty >= 2) { startIdx = i; break; }
        }
        rows = allRows.slice(startIdx).filter(r => r.some(c => String(c).trim() !== ''));
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

      const colCod    = col(['codigoproduto', 'código', 'codigo', 'cod', 'sku', 'id']);
      const colDesc   = col(['nomeproduto', 'descrição', 'descricao', 'produto', 'desc', 'item', 'nome']);
      const colForn   = col(['fornecedor', 'supplier', 'marca']);
      const colCusto  = col(['precocompra', 'precodecompra', 'custo', 'preco custo', 'preco de compra', 'p. custo', 'cost']);
      const colVenda  = col(['precovenda', 'precodevenda', 'preco venda', 'preco de venda', 'p. venda', 'venda', 'sale', 'preco venda']);
      const colUnit   = col(['unidade', 'unid', 'unit', 'un']);
      const colCat    = col(['categoria', 'category', 'grupo', 'depart', 'subcategoria']);
      const colEstoque = col(['estoque', 'saldo', 'estoque entrada', 'quantidade', 'qtd', 'qty', 'stock']);

      // Detecta relatório 302 XMenu: Código | Produto | Preço Venda | Estoque | Un | ...
      const isXMenu302 = colCod >= 0 && colDesc >= 0 && colEstoque >= 0 &&
        headerNorm.some(h => h.includes('produto')) &&
        headerNorm.some(h => h.includes('estoque'));
      console.log('[produtos/import] isXMenu302:', isXMenu302, 'colEstoque:', colEstoque);

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

      // Monta arrays para batch upsert via unnest (1 query em vez de ~N queries individuais)
      const bCod = [], bDesc = [], bForn = [], bCusto = [], bVenda = [], bUnit = [], bCat = [], bEstoque = [];
      let inseridos = 0, atualizados = 0, erros = 0, pulados = 0;
      const detalheErros = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const codigo    = String(row[colCod]  ?? '').trim();
        const descricao = String(row[colDesc] ?? '').trim();
        if (!codigo || !descricao) continue;
        if (descricao.toLowerCase().includes('total') && isNaN(parseInt(codigo))) continue;
        // Ignora linha de rodapé do XMenu (código numérico pequeno sem descrição real)
        if (isXMenu302 && parseInt(codigo) < 100 && !descricao.match(/[a-zA-Z]{3,}/)) { pulados++; continue; }

        const fornecedor = colForn    >= 0 ? String(row[colForn] ?? '').trim() || null : null;
        const custo      = colCusto   >= 0 ? parseNum(row[colCusto]) : 0;
        const venda      = colVenda   >= 0 ? parseNum(row[colVenda]) : 0;
        const unidade    = colUnit    >= 0 ? String(row[colUnit] ?? 'un').trim().toUpperCase() || 'UN' : 'UN';
        const categoria  = colCat     >= 0 ? String(row[colCat]  ?? '').trim() || null : null;
        const estoque    = colEstoque >= 0 ? parseNum(row[colEstoque]) : null;

        // No XMenu302: aceita produto mesmo sem custo/venda se tiver código e descrição válidos
        if (!isXMenu302 && custo === 0 && venda === 0) { pulados++; continue; }

        bCod.push(codigo); bDesc.push(descricao); bForn.push(fornecedor);
        bCusto.push(custo); bVenda.push(venda); bUnit.push(unidade); bCat.push(categoria);
        bEstoque.push(estoque);
      }

      if (bCod.length === 0) {
        return res.json({ ok: true, inseridos: 0, atualizados: 0, erros: 0, pulados, detalheErros: [] });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Garante coluna estoque existe (migration defensiva)
        await client.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque NUMERIC(12,3) DEFAULT 0`).catch(()=>{});

        const result = await client.query(`
          INSERT INTO produtos (codigo, descricao, fornecedor, preco_custo, preco_venda, unidade, categoria, origem, estoque)
          SELECT
            UNNEST($1::text[]),
            UNNEST($2::text[]),
            UNNEST($3::text[]),
            UNNEST($4::numeric[]),
            UNNEST($5::numeric[]),
            UNNEST($6::text[]),
            UNNEST($7::text[]),
            'pdv',
            UNNEST($8::numeric[])
          ON CONFLICT (codigo) DO UPDATE SET
            descricao     = EXCLUDED.descricao,
            fornecedor    = COALESCE(EXCLUDED.fornecedor, produtos.fornecedor),
            preco_custo   = CASE WHEN EXCLUDED.preco_custo > 0 THEN EXCLUDED.preco_custo ELSE produtos.preco_custo END,
            preco_venda   = CASE WHEN EXCLUDED.preco_venda > 0 THEN EXCLUDED.preco_venda ELSE produtos.preco_venda END,
            unidade       = EXCLUDED.unidade,
            categoria     = COALESCE(EXCLUDED.categoria, produtos.categoria),
            estoque       = CASE WHEN EXCLUDED.estoque IS NOT NULL THEN EXCLUDED.estoque ELSE produtos.estoque END,
            atualizado_em = NOW()
          RETURNING id, codigo, (xmax <> 0) AS foi_update,
            preco_custo AS novo_custo
        `, [bCod, bDesc, bForn, bCusto, bVenda, bUnit, bCat, bEstoque.map(e => e ?? 0)]);

        for (const row of result.rows) {
          if (row.foi_update) atualizados++;
          else inseridos++;
        }

        // Propaga preco_custo atualizado para kit_itens que referenciam esses produtos
        // (somente onde o custo importado é > 0, para não sobrescrever custos manuais)
        const prodsCusto = result.rows
          .filter(r => r.foi_update && parseFloat(r.novo_custo) > 0)
          .map(r => r.id);
        if (prodsCusto.length > 0) {
          await client.query(`
            UPDATE kit_itens ki
            SET preco_custo_unitario = p.preco_custo
            FROM produtos p
            WHERE ki.produto_id = p.id
              AND p.id = ANY($1::int[])
              AND p.preco_custo > 0
          `, [prodsCusto]);
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }

      res.json({ ok: true, inseridos, atualizados, erros, pulados, detalheErros });
    } catch (e) {
      console.error('[produtos/import]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro ao processar planilha: ' + e.message });
    }
  });

  // ── Helpers compartilhados para sync ────────────────────────────────────────
  function lerPlanilhaSync(buffer) {
    const XLSX = require('xlsx');
    const wb   = XLSX.read(buffer, { type: 'buffer' });
    const sheet= wb.Sheets[wb.SheetNames[0]];
    // Corrige !ref incorreto (bug XMenu — declara A1:C1 mas tem 12 colunas)
    const dec  = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    let mR = dec.e.r, mC = dec.e.c;
    for (const addr of Object.keys(sheet)) {
      if (addr[0] === '!') continue;
      const c = XLSX.utils.decode_cell(addr);
      if (c.r > mR) mR = c.r;
      if (c.c > mC) mC = c.c;
    }
    sheet['!ref'] = XLSX.utils.encode_range({ s: dec.s, e: { r: mR, c: mC } });
    const all  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    // Pula linhas iniciais vazias
    let si = 0;
    for (let i = 0; i < Math.min(all.length, 10); i++) {
      if (all[i].filter(c => String(c).trim()).length >= 2) { si = i; break; }
    }
    return all.slice(si).filter(r => r.some(c => String(c).trim()));
  }

  function detectCols(header) {
    const normH = s => String(s).toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const hn = header.map(normH);
    const col = (...nomes) => {
      for (const n of nomes) {
        const nn = normH(n);
        const i  = hn.findIndex(h => h === nn || h.includes(nn));
        if (i >= 0) return i;
      }
      return -1;
    };
    return {
      colCod    : col('codigoproduto','código','codigo','cod','sku','id'),
      colDesc   : col('nomeproduto','descrição','descricao','produto','desc','item','nome'),
      colForn   : col('fornecedor','supplier','marca','fabricante'),
      colCusto  : col('precocompra','precodecompra','custo','preco custo','preco de compra','p. custo','cost','ultimo compra','último compra'),
      colVenda  : col('precovenda','precodevenda','preco venda','preco de venda','p. venda','venda','sale'),
      colUnit   : col('unidade','unid','unit','un'),
      colCat    : col('categoria','category','grupo','depart','subcategoria'),
      colEstoque: col('estoque','saldo','qtd estoque','estoque atual','stock'),
    };
  }

  const parseNum = v => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = String(v).replace(/[^\d.,\-]/g, '').replace(',','.');
    return parseFloat(s) || 0;
  };

  // ── POST /sync-estoque ───────────────────────────────────────────────────────
  // Aceita: Relatório 302 XMenu ou qualquer planilha com Código + Estoque
  r.post('/sync-estoque', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Nenhum arquivo enviado' });
    try {
      // Garante coluna estoque existe
      await pool.query('ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque NUMERIC(12,3) DEFAULT 0').catch(()=>{});

      const rows = lerPlanilhaSync(req.file.buffer);
      if (rows.length < 2) return res.status(422).json({ ok: false, erro: 'Planilha vazia' });

      const { colCod, colEstoque } = detectCols(rows[0]);
      if (colCod < 0)     return res.status(422).json({ ok: false, erro: 'Coluna de Código não encontrada. Cabeçalho: ' + rows[0].join(' | ') });
      if (colEstoque < 0) return res.status(422).json({ ok: false, erro: 'Coluna de Estoque não encontrada. Cabeçalho: ' + rows[0].join(' | ') });

      // Monta pares [codigo, estoque] ignorando linhas inválidas
      const pares = [];
      for (let i = 1; i < rows.length; i++) {
        const row     = rows[i];
        const codigo  = String(row[colCod] ?? '').trim();
        if (!codigo || !/^\d/.test(codigo)) continue;          // pula cabeçalhos repetidos / totais
        const estoque = parseNum(row[colEstoque]);
        pares.push({ codigo, estoque });
      }

      if (!pares.length) return res.json({ ok: true, atualizados: 0, nao_encontrados: 0, msg: 'Nenhuma linha válida' });

      // Upsert em lote via UNNEST
      const bCod = pares.map(p => p.codigo);
      const bEst = pares.map(p => p.estoque);

      const result = await pool.query(`
        UPDATE produtos SET
          estoque       = data.est,
          atualizado_em = NOW()
        FROM (
          SELECT UNNEST($1::text[]) AS cod, UNNEST($2::numeric[]) AS est
        ) AS data
        WHERE produtos.codigo = data.cod
        RETURNING produtos.codigo
      `, [bCod, bEst]);

      const encontrados    = result.rows.map(r => r.codigo);
      const nao_encontrados= pares.filter(p => !encontrados.includes(p.codigo)).length;

      // Propaga estoque para produto_id em kit_itens via JOIN
      // (não há coluna estoque em kit_itens — apenas info de produto)
      // Propaga automaticamente para kit_estoque_interno (estoque de kits)
      pool.query(`
        UPDATE kit_estoque_interno kei
        SET saldo = COALESCE(p.estoque, 0), atualizado_em = NOW()
        FROM produtos p
        WHERE kei.produto_id = p.id AND p.estoque IS NOT NULL
      `).catch(e => console.error('[sync-estoque] propagação kits:', e.message));

      // Insere ingredientes de kits que ainda não têm entrada
      pool.query(`
        INSERT INTO kit_estoque_interno (produto_id, produto_codigo, produto_nome, saldo, atualizado_em)
        SELECT DISTINCT p.id, p.codigo, p.descricao, COALESCE(p.estoque,0), NOW()
        FROM kit_itens ki JOIN produtos p ON p.id = ki.produto_id
        WHERE p.estoque > 0
          AND NOT EXISTS (SELECT 1 FROM kit_estoque_interno kei WHERE kei.produto_id = p.id)
        ON CONFLICT (produto_id) DO UPDATE SET saldo = EXCLUDED.saldo, atualizado_em = NOW()
      `).catch(e => console.error('[sync-estoque] insert kits:', e.message));

      res.json({
        ok: true,
        atualizados:    encontrados.length,
        nao_encontrados,
        total_planilha: pares.length,
        msg: `Estoque atualizado em ${encontrados.length} produto(s). ${nao_encontrados} código(s) não encontrado(s) no cadastro.`
      });
    } catch (e) {
      console.error('[sync-estoque]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /sync-cadastro ──────────────────────────────────────────────────────
  // Aceita: qualquer planilha com Código + Fornecedor + Custo + Venda + Unidade
  r.post('/sync-cadastro', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Nenhum arquivo enviado' });
    try {
      const rows = lerPlanilhaSync(req.file.buffer);
      if (rows.length < 2) return res.status(422).json({ ok: false, erro: 'Planilha vazia' });

      const { colCod, colForn, colCusto, colVenda, colUnit, colCat } = detectCols(rows[0]);
      if (colCod < 0) return res.status(422).json({ ok: false, erro: 'Coluna de Código não encontrada. Cabeçalho: ' + rows[0].join(' | ') });

      const pares = [];
      for (let i = 1; i < rows.length; i++) {
        const row     = rows[i];
        const codigo  = String(row[colCod] ?? '').trim();
        if (!codigo || !/^\d/.test(codigo)) continue;
        const fornecedor = colForn  >= 0 ? String(row[colForn]  ?? '').trim() || null : null;
        const custo      = colCusto >= 0 ? parseNum(row[colCusto]) : null;
        const venda      = colVenda >= 0 ? parseNum(row[colVenda]) : null;
        const unidade    = colUnit  >= 0 ? String(row[colUnit]  ?? '').trim().toUpperCase() || null : null;
        const categoria  = colCat   >= 0 ? String(row[colCat]   ?? '').trim() || null : null;
        // Pula linha se não tem nenhum dado útil
        if (!fornecedor && custo === null && venda === null) continue;
        pares.push({ codigo, fornecedor, custo, venda, unidade, categoria });
      }

      if (!pares.length) return res.json({ ok: true, atualizados: 0, nao_encontrados: 0, msg: 'Nenhuma linha válida' });

      // UPDATE individual por código para respeitar regras de NULL
      const client = await pool.connect();
      let atualizados = 0, nao_encontrados = 0;
      try {
        await client.query('BEGIN');
        for (const p of pares) {
          const { rowCount } = await client.query(`
            UPDATE produtos SET
              fornecedor    = CASE WHEN $1::text IS NOT NULL AND $1 <> '' THEN $1 ELSE fornecedor END,
              preco_custo   = CASE WHEN $2::numeric IS NOT NULL AND $2 > 0 THEN $2 ELSE preco_custo END,
              preco_venda   = CASE WHEN $3::numeric IS NOT NULL AND $3 > 0 THEN $3 ELSE preco_venda END,
              unidade       = CASE WHEN $4::text IS NOT NULL AND $4 <> '' THEN $4 ELSE unidade END,
              categoria     = CASE WHEN $5::text IS NOT NULL AND $5 <> '' THEN $5 ELSE categoria END,
              atualizado_em = NOW()
            WHERE codigo = $6
          `, [p.fornecedor, p.custo, p.venda, p.unidade, p.categoria, p.codigo]);
          if (rowCount > 0) atualizados++;
          else nao_encontrados++;
        }
        // Propaga preco_custo atualizado para kit_itens
        await client.query(`
          UPDATE kit_itens ki
          SET preco_custo_unitario = p.preco_custo
          FROM produtos p
          WHERE ki.produto_id = p.id AND p.preco_custo > 0
        `);
        await client.query('COMMIT');
      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }

      res.json({
        ok: true,
        atualizados,
        nao_encontrados,
        total_planilha: pares.length,
        msg: `Cadastro atualizado em ${atualizados} produto(s). ${nao_encontrados} código(s) não encontrado(s).`
      });
    } catch (e) {
      console.error('[sync-cadastro]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
