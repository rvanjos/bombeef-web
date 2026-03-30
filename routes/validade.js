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
      // Se foi fornecido código, tenta vincular automaticamente
      let prodId = v.produtoId || null;
      if (v.codigo && !prodId) {
        const p = await pool.query(`SELECT id FROM produtos WHERE codigo = $1`, [v.codigo.trim()]);
        if (p.rows.length) prodId = p.rows[0].id;
      }

      await pool.query(`
        UPDATE validade_items SET
          produto_id          = COALESCE($1, produto_id),
          codigo              = COALESCE($2, codigo),
          descricao           = COALESCE($3, descricao),
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
        prodId, v.codigo?.trim() || null, v.descricao || null,
        v.dataValidade || null, v.lote || null, v.acaoAntesVencer || null,
        v.ultimaConferencia || null, v.responsavel || null,
        v.qtdUnidades !== undefined ? parseInt(v.qtdUnidades) : null,
        v.diasAlerta !== undefined ? parseInt(v.diasAlerta) : null,
        v.localizacao || null, v.observacao || null,
        parseInt(req.params.id),
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

      await pool.query(`
        UPDATE validade_items
        SET produto_id=$1, codigo=$2, descricao=COALESCE(NULLIF(descricao,''),$3),
            preco_custo=$4, atualizado_em=NOW()
        WHERE id=$5
      `, [prod[0].id, codigo.trim(), prod[0].descricao, parseFloat(prod[0].preco_custo||0), parseInt(req.params.id)]);

      res.json({ ok: true, produto: { ...prod[0], codigo: codigo.trim() } });
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
      const wb    = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (rows.length < 2) return res.status(422).json({ ok: false, erro: 'Planilha vazia' });

      const header = rows[0].map(c => String(c).toLowerCase().trim());
      const col = (nomes) => {
        for (const n of nomes) {
          const i = header.findIndex(h => h.includes(n));
          if (i >= 0) return i;
        }
        return -1;
      };

      const colDesc    = col(['descrição', 'descricao', 'produto', 'item', 'nome']);
      const colCod     = col(['código', 'codigo', 'cod', 'sku']);
      const colVal     = col(['validade', 'vencimento', 'vence', 'exp']);
      const colLote    = col(['lote', 'batch']);
      const colAcao    = col(['ação', 'acao', 'action']);
      const colConf    = col(['conferência', 'conferencia', 'ultima conf', 'última conf']);
      const colResp    = col(['responsável', 'responsavel', 'resp']);
      const colQtd     = col(['qtd', 'quantidade', 'qty', 'unid']);
      const colLocal   = col(['local', 'localização', 'localizacao', 'posição']);

      if (colDesc < 0) {
        return res.status(422).json({ ok: false, erro: 'Coluna de descrição não encontrada', cabecalho: header });
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
          const qtd   = colQtd  >= 0 ? parseInt(row[colQtd] || 0) || 0 : 0;
          const resp  = colResp >= 0 ? String(row[colResp]  ?? '').trim() || null : null;
          const acao  = colAcao >= 0 ? String(row[colAcao]  ?? '').trim() || null : null;
          const lote  = colLote >= 0 ? String(row[colLote]  ?? '').trim() || null : null;
          const local = colLocal>= 0 ? String(row[colLocal] ?? '').trim() || null : null;

          const parseDate = (v) => {
            if (!v) return null;
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            const s = String(v).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.split('/').reverse().join('-');
            if (/^\d{2}\/\d{4}$/.test(s)) { // MM/YYYY → último dia do mês
              const [mm, yyyy] = s.split('/');
              return `${yyyy}-${mm}-${new Date(parseInt(yyyy), parseInt(mm), 0).getDate()}`;
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

  return r;
};
