/**
 * routes/validade.js — M4: Controle de Validades
 *
 * Rotas:
 *   GET    /api/validade              → lista itens
 *   POST   /api/validade              → cadastra item
 *   PUT    /api/validade/:id          → atualiza (conferência, ação, código)
 *   DELETE /api/validade/:id          → remove
 *   POST   /api/validade/import       → importa planilha XLSX
 *   POST   /api/validade/:id/vincular → vincula produto_id pelo código
 *   GET    /api/validade/kpis         → KPIs de validade
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
      CREATE TABLE IF NOT EXISTS validade_items (
        id                  SERIAL PRIMARY KEY,
        produto_id          INTEGER,
        codigo              TEXT,
        descricao           TEXT NOT NULL,
        data_validade       DATE,
        lote                TEXT,
        acao_antes_vencer   TEXT,
        ultima_conferencia  DATE,
        responsavel         TEXT,
        qtd_unidades        INTEGER DEFAULT 0,
        preco_custo         NUMERIC(10,4) DEFAULT 0,
        status              TEXT DEFAULT 'ok',
        dias_alerta         INTEGER DEFAULT 7,
        localizacao         TEXT,
        observacao          TEXT,
        criado_em           TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Garante colunas novas
    const needed = [
      ['preco_custo',   'NUMERIC(10,4) DEFAULT 0'],
      ['localizacao',   'TEXT'],
      ['qtd_unidades',  'INTEGER DEFAULT 0'],
      ['dias_alerta',   'INTEGER DEFAULT 7'],
      ['atualizado_em',  'TIMESTAMPTZ DEFAULT NOW()'],
      ['resolucao',      'TEXT'],
      ['dt_resolucao',   'DATE'],
      ['obs_resolucao',  'TEXT'],
      ['encerrado_por',  'TEXT'],
      ['desc_original',  'TEXT'],
    ];
    for (const [col, def] of needed) {
      await pool.query(`ALTER TABLE validade_items ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
    }

    // Remove constraint de status que pode conflitar
    await pool.query(`ALTER TABLE validade_items DROP CONSTRAINT IF EXISTS validade_items_status_check`).catch(() => {});

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_val_codigo    ON validade_items(codigo);
      CREATE INDEX IF NOT EXISTS idx_val_validade  ON validade_items(data_validade);
      CREATE INDEX IF NOT EXISTS idx_val_status    ON validade_items(status);
    `).catch(() => {});
  }
  initTable().catch(e => console.error('[validade] initTable:', e.message));

  // ── Helper: atualiza status baseado na data ────────────────────────────────
  async function atualizarStatus() {
    await pool.query(`
      UPDATE validade_items SET
        status = CASE
          WHEN data_validade < CURRENT_DATE THEN 'vencido'
          WHEN data_validade <= CURRENT_DATE + (dias_alerta || ' days')::INTERVAL THEN 'alerta'
          ELSE 'ok'
        END,
        atualizado_em = NOW()
      WHERE status NOT IN ('descartado')
        AND data_validade IS NOT NULL
    `);
  }

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      await atualizarStatus();
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'ok')        AS ok,
          COUNT(*) FILTER (WHERE status = 'alerta')    AS alerta,
          COUNT(*) FILTER (WHERE status = 'vencido')   AS vencidos,
          COUNT(*) FILTER (WHERE status = 'descartado' AND data_validade >= DATE_TRUNC('month', NOW())) AS descartados_mes,
          COUNT(*) FILTER (WHERE codigo IS NULL OR codigo = '') AS sem_codigo
        FROM validade_items
        WHERE status != 'descartado' OR data_validade >= DATE_TRUNC('month', NOW())
      `);
      res.json({ ok: true, data: {
        ok:            parseInt(rows[0].ok),
        alerta:        parseInt(rows[0].alerta),
        vencidos:      parseInt(rows[0].vencidos),
        descartadosMes: parseInt(rows[0].descartados_mes),
        semCodigo:     parseInt(rows[0].sem_codigo),
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      await atualizarStatus();
      const { status, busca, semCodigo } = req.query;
      const conds = [], params = [];

      if (semCodigo === 'true') conds.push(`(codigo IS NULL OR codigo = '')`);
      if (status && status !== 'todos') { params.push(status); conds.push(`status = $${params.length}`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(descricao ILIKE $${params.length} OR codigo ILIKE $${params.length} OR lote ILIKE $${params.length})`);
      }
      conds.push(`status != 'descartado'`);

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT vi.*, p.descricao AS prod_descricao, p.preco_custo
         FROM validade_items vi
         LEFT JOIN produtos p ON p.id = vi.produto_id
         ${where} ORDER BY vi.data_validade ASC NULLS LAST, vi.descricao ASC`,
        params
      );
      // Serializa datas como strings YYYY-MM-DD para o frontend
      const data = rows.map(r => ({
        ...r,
        data_validade: r.data_validade instanceof Date
          ? r.data_validade.toISOString().slice(0, 10)
          : r.data_validade ? String(r.data_validade).slice(0, 10) : null,
        ultima_conferencia: r.ultima_conferencia instanceof Date
          ? r.ultima_conferencia.toISOString().slice(0, 10)
          : r.ultima_conferencia ? String(r.ultima_conferencia).slice(0, 10) : null,
      }));
      res.json({ ok: true, data, total: data.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const v = req.body;
    if (!v.descricao) return res.status(400).json({ ok: false, erro: 'descricao obrigatória' });
    try {
      // Tenta vincular produto pelo código
      let prodId = null;
      if (v.codigo) {
        const p = await pool.query(`SELECT id FROM produtos WHERE codigo = $1`, [v.codigo.trim()]);
        if (p.rows.length) prodId = p.rows[0].id;
      }
      const { rows } = await pool.query(`
        INSERT INTO validade_items
          (produto_id, codigo, descricao, data_validade, lote, acao_antes_vencer,
           ultima_conferencia, responsavel, qtd_unidades, dias_alerta, localizacao, observacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [
        prodId, v.codigo?.trim() || null, v.descricao.trim(),
        v.dataValidade || null, v.lote || null, v.acaoAntesVencer || null,
        v.ultimaConferencia || null, v.responsavel || null,
        parseInt(v.qtdUnidades || 0), parseInt(v.diasAlerta || 7),
        v.localizacao || null, v.observacao || null,
      ]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const v = req.body;
    try {
      // Se tem código, busca produto para obter nome oficial e produto_id
      let prodId = v.produtoId || null;
      let descFinal = v.descricao || null;
      let descOriginal = null;
      if (v.codigo) {
        const p = await pool.query(
          `SELECT id, descricao FROM produtos WHERE codigo = $1 AND ativo = true LIMIT 1`,
          [v.codigo.trim()]
        );
        if (p.rows.length) {
          prodId = p.rows[0].id;
          // Salva nome original antes de sobrescrever (só se ainda não foi salvo)
          const cur = await pool.query(`SELECT descricao, desc_original FROM validade_items WHERE id=$1`, [parseInt(req.params.id)]);
          if (cur.rows.length && !cur.rows[0].desc_original) {
            descOriginal = cur.rows[0].descricao; // nome atual vira original
          }
          descFinal = p.rows[0].descricao; // sempre usa nome do cadastro
        }
      }

      await pool.query(`
        UPDATE validade_items SET
          produto_id          = COALESCE($1, produto_id),
          codigo              = COALESCE($2, codigo),
          descricao           = COALESCE($3, descricao),
          desc_original       = COALESCE(desc_original, $14),
          data_validade       = COALESCE($4, data_validade),
          lote                = COALESCE($5, lote),
          acao_antes_vencer   = COALESCE($6, acao_antes_vencer),
          ultima_conferencia  = COALESCE($7, ultima_conferencia),
          responsavel         = COALESCE($8, responsavel),
          qtd_unidades        = COALESCE($9, qtd_unidades),
          dias_alerta         = COALESCE($10, dias_alerta),
          localizacao         = COALESCE($11, localizacao),
          observacao          = COALESCE($12, observacao),
          atualizado_em       = NOW()
        WHERE id = $13
      `, [
        prodId, v.codigo?.trim() || null, descFinal,
        v.dataValidade || null, v.lote || null, v.acaoAntesVencer || null,
        v.ultimaConferencia || null, v.responsavel || null,
        v.qtdUnidades !== undefined ? parseInt(v.qtdUnidades) : null,
        v.diasAlerta !== undefined ? parseInt(v.diasAlerta) : null,
        v.localizacao || null, v.observacao || null,
        parseInt(req.params.id), descOriginal,
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /:id/vincular ─────────────────────────────────────────────────────
  r.post('/:id/vincular', async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ ok: false, erro: 'codigo obrigatório' });
    try {
      const { rows: prod } = await pool.query(
        `SELECT id, descricao, preco_custo, preco_venda FROM produtos WHERE codigo = $1`, [codigo.trim()]
      );
      if (!prod.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado com este código' });

      // Busca descrição atual para salvar como original (auditoria)
      const { rows: cur } = await pool.query(
        `SELECT descricao FROM validade_items WHERE id=$1`, [parseInt(req.params.id)]
      );
      const descAtual = cur[0]?.descricao || null;

      await pool.query(`
        UPDATE validade_items
        SET produto_id    = $1,
            codigo        = $2,
            descricao     = $3,
            desc_original = COALESCE(desc_original, $4),
            preco_custo   = $5,
            atualizado_em = NOW()
        WHERE id = $6
      `, [prod[0].id, codigo.trim(), prod[0].descricao,
          descAtual, parseFloat(prod[0].preco_custo||0), parseInt(req.params.id)]);

      res.json({ ok: true, produto: { ...prod[0], codigo: codigo.trim(), desc_original: descAtual } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /auto-vincular — vincula itens sem código por nome ────────────────
  // Tenta casar cada item sem código com um produto do catálogo pelo nome
  r.post('/auto-vincular', async (req, res) => {
    try {
      // Busca todos os itens sem código
      const { rows: semCod } = await pool.query(
        `SELECT id, descricao FROM validade_items
         WHERE (codigo IS NULL OR codigo = '') AND status != 'descartado'`
      );
      if (!semCod.length) return res.json({ ok: true, vinculados: 0, nao_encontrados: 0, detalhes: [] });

      // Busca todos os produtos ativos para casar
      const { rows: prods } = await pool.query(
        `SELECT id, codigo, descricao, preco_custo FROM produtos WHERE ativo = true`
      );

      // Função de normalização para comparação
      const norm = s => s.toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
        .replace(/[^A-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ').trim();

      // Índice de produtos pelo nome normalizado
      const prodIdx = {};
      for (const p of prods) {
        prodIdx[norm(p.descricao)] = p;
      }

      let vinculados = 0;
      const detalhes = [];

      for (const item of semCod) {
        const nItem = norm(item.descricao);
        // 1. Match exato
        let prod = prodIdx[nItem];
        // 2. Se não achou, tenta match parcial: produto cujo nome está contido no item ou vice-versa
        if (!prod) {
          for (const [nProd, p] of Object.entries(prodIdx)) {
            if (nItem.includes(nProd) || nProd.includes(nItem)) {
              // Prefere o match mais longo (mais específico)
              if (!prod || nProd.length > norm(prod.descricao).length) prod = p;
            }
          }
        }
        if (prod) {
          await pool.query(
            `UPDATE validade_items SET
               produto_id    = $1, codigo = $2,
               desc_original = COALESCE(desc_original, descricao),
               descricao     = $3, preco_custo = $4,
               atualizado_em = NOW()
             WHERE id = $5`,
            [prod.id, prod.codigo, prod.descricao, parseFloat(prod.preco_custo||0), item.id]
          );
          vinculados++;
          detalhes.push({ id: item.id, item: item.descricao, produto: prod.descricao, codigo: prod.codigo });
        } else {
          detalhes.push({ id: item.id, item: item.descricao, produto: null, codigo: null });
        }
      }

      res.json({ ok: true, vinculados, nao_encontrados: semCod.length - vinculados, detalhes });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /vincular-multiplos — vincula lista de ids com mesmo código ────────
  r.post('/vincular-multiplos', async (req, res) => {
    const { ids, codigo } = req.body;
    if (!ids?.length || !codigo) return res.status(400).json({ ok: false, erro: 'ids e codigo obrigatórios' });
    try {
      const { rows: prod } = await pool.query(
        `SELECT id, descricao, preco_custo FROM produtos WHERE codigo = $1 AND ativo = true LIMIT 1`,
        [codigo.trim()]
      );
      if (!prod.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      const p = prod[0];
      let count = 0;
      for (const id of ids) {
        await pool.query(
          `UPDATE validade_items SET
             produto_id    = $1, codigo = $2,
             desc_original = COALESCE(desc_original, descricao),
             descricao     = $3, preco_custo = $4,
             atualizado_em = NOW()
           WHERE id = $5`,
          [p.id, codigo.trim(), p.descricao, parseFloat(p.preco_custo||0), parseInt(id)]
        );
        count++;
      }
      res.json({ ok: true, vinculados: count, produto: p.descricao });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id — encerra com motivo ──────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    const { resolucao, obs_resolucao, encerrado_por, dt_resolucao } = req.body || {};
    try {
      await pool.query(
        `UPDATE validade_items SET
           status='descartado', resolucao=$1, obs_resolucao=$2,
           encerrado_por=$3, dt_resolucao=COALESCE($4::date,CURRENT_DATE),
           atualizado_em=NOW()
         WHERE id=$5`,
        [resolucao||'outro', obs_resolucao||null, encerrado_por||null,
         dt_resolucao||null, parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /historico ─────────────────────────────────────────────────────────
  r.get('/historico', async (req, res) => {
    try {
      const { resolucao, de, ate, busca } = req.query;
      const conds = [`status='descartado'`], params = [];
      if (resolucao && resolucao !== 'todos') {
        params.push(resolucao); conds.push(`resolucao=$${params.length}`);
      }
      if (de)  { params.push(de);  conds.push(`dt_resolucao>=$${params.length}::date`); }
      if (ate) { params.push(ate); conds.push(`dt_resolucao<=$${params.length}::date`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(descricao ILIKE $${params.length} OR COALESCE(codigo,'') ILIKE $${params.length})`);
      }
      const { rows } = await pool.query(
        `SELECT * FROM validade_items WHERE ${conds.join(' AND ')}
         ORDER BY dt_resolucao DESC NULLS LAST, atualizado_em DESC`, params
      );
      const fmt = v => v instanceof Date ? v.toISOString().slice(0,10) : v ? String(v).slice(0,10) : null;
      const data = rows.map(r => ({
        ...r,
        data_validade: fmt(r.data_validade),
        dt_resolucao:  fmt(r.dt_resolucao),
        ultima_conferencia: fmt(r.ultima_conferencia),
      }));
      res.json({ ok: true, data, total: data.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import ───────────────────────────────────────────────────────────
  r.post('/import', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });

      // Escolhe a aba: preferência para 'Pereciveis', 'Perecíveis', 'Validade', senão a primeira
      const abaPref = ['Pereciveis','Perecíveis','Perecivel','Perecível','Validade','Ativos'];
      let sheetName = wb.SheetNames[0];
      for (const pref of abaPref) {
        const found = wb.SheetNames.find(n => n.toLowerCase().includes(pref.toLowerCase()));
        if (found) { sheetName = found; break; }
      }
      const sheet = wb.Sheets[sheetName];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (rows.length < 2) return res.status(422).json({ ok: false, erro: 'Planilha vazia' });

      const header = rows[0].map(c => String(c).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\n/g,' ').trim());
      const col = (nomes) => {
        for (const n of nomes) {
          const i = header.findIndex(h => h.includes(n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')));
          if (i >= 0) return i;
        }
        return -1;
      };

      // Colunas — compatível com formato Bom Beef (DATA VALIDADE, Produto, CÓDIGO, etc.)
      const colVal     = col(['data validade','validade','vencimento','vence','exp']);
      const colDesc    = col(['produto','descrição','descricao','item','nome']);
      const colCod     = col(['código','codigo','cod','sku']);
      const colQtdPec  = col(['quantidade de peças','qtd peças','quantidade de pecas','peças (no estoque)','peças']);
      const colQtdKg   = col(['quantidade estoque (em kg)','quantidade\nestoque','em kg','kg']);
      const colLocal   = col(['local','localização','localizacao','posição']);
      const colAcao    = col(['ação antes','acao antes','ação','acao','action']);
      const colConf    = col(['última conferência','ultima conferencia','conferência','conferencia','ultima conf']);
      const colLote    = col(['lote','batch']);
      const colResp    = col(['responsável','responsavel','resp']);
      // Qtd: usa peças se tiver, senão kg
      const colQtd     = colQtdPec >= 0 ? colQtdPec : col(['qtd','quantidade','qty','unid']);

      if (colDesc < 0) {
        return res.status(422).json({ ok: false, erro: 'Coluna de descrição/produto não encontrada', cabecalho: header, aba: sheetName });
      }
      if (colVal < 0) {
        return res.status(422).json({ ok: false, erro: 'Coluna de data de validade não encontrada', cabecalho: header, aba: sheetName });
      }

      const client = await pool.connect();
      let inseridos = 0, erros = 0;
      const detalheErros = [];

      try {
        await client.query('BEGIN');
        for (let i = 1; i < rows.length; i++) {
          const row  = rows[i];
          const desc = String(row[colDesc] ?? '').trim();
          if (!desc) continue;

          const cod   = colCod  >= 0 ? String(row[colCod]  ?? '').trim() || null : null;
          const qtdRaw = colQtd >= 0 ? row[colQtd] : 0;
          const qtdNum = typeof qtdRaw === 'number' ? qtdRaw
                       : parseFloat(String(qtdRaw||'0').replace(',','.'));
          const qtd = isNaN(qtdNum) ? 0 : Math.round(qtdNum);
          const resp  = colResp >= 0 ? String(row[colResp]  ?? '').trim() || null : null;
          const acao  = colAcao >= 0 ? String(row[colAcao]  ?? '').trim() || null : null;
          const lote  = colLote >= 0 ? String(row[colLote]  ?? '').trim() || null : null;
          const local = colLocal>= 0 ? String(row[colLocal] ?? '').trim() || null : null;

          const parseDate = (v) => {
            if (!v) return null;
            if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
            const s = String(v).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.split('/').reverse().join('-');
            if (/^\d{2}\/\d{4}$/.test(s)) {
              const [mm, yyyy] = s.split('/');
              return `${yyyy}-${mm}-${String(new Date(parseInt(yyyy), parseInt(mm), 0).getDate()).padStart(2,'0')}`;
            }
            // Excel serial date number
            if (/^\d{5}$/.test(s)) {
              const d = new Date((parseInt(s) - 25569) * 86400 * 1000);
              return d.toISOString().slice(0,10);
            }
            return null;
          };

          const dataVal  = colVal  >= 0 ? parseDate(row[colVal])  : null;
          const dataConf = colConf >= 0 ? parseDate(row[colConf]) : null;

          // Tenta vincular produto
          let prodId = null;
          if (cod) {
            const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [cod]);
            if (p.rows.length) prodId = p.rows[0].id;
          }

          try {
            await client.query(`
              INSERT INTO validade_items
                (produto_id, codigo, descricao, data_validade, lote, acao_antes_vencer,
                 ultima_conferencia, responsavel, qtd_unidades, localizacao)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [prodId, cod, desc, dataVal, lote, acao, dataConf, resp, qtd, local]);
            inseridos++;
          } catch (e) {
            erros++;
            detalheErros.push({ linha: i + 1, descricao: desc, erro: e.message });
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK'); throw e;
      } finally { client.release(); }

      res.json({ ok: true, inseridos, erros, detalheErros });
    } catch (e) {
      res.status(500).json({ ok: false, erro: 'Erro ao processar planilha: ' + e.message });
    }
  });

  // ── DELETE /limpar-tudo — admin apaga todos os itens de validade ────────────
  r.delete('/limpar-tudo', async (req, res) => {
    if (req.user?.perfil !== 'admin')
      return res.status(403).json({ ok: false, erro: 'Acesso restrito ao administrador' });
    try {
      const { rows } = await pool.query(`SELECT COUNT(*) AS total FROM validade_items`);
      const total = parseInt(rows[0].total);
      // Limpa referências nas tabelas filhas antes de truncar
      await pool.query(`UPDATE perdas SET validade_item_id = NULL WHERE validade_item_id IS NOT NULL`);
      await pool.query(`TRUNCATE TABLE validade_items RESTART IDENTITY CASCADE`);
      console.log(`[validade] limpar-tudo: ${total} itens removidos por ${req.user.email}`);
      res.json({ ok: true, removidos: total });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
