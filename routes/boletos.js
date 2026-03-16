/**
 * routes/boletos.js — M1: Controle de Boletos e NF-e
 *
 * Rotas:
 *   GET    /api/boletos                → lista boletos (filtros: status, mes, fornecedor)
 *   POST   /api/boletos                → cria boleto individual
 *   PUT    /api/boletos/:id            → atualiza boleto
 *   DELETE /api/boletos/:id            → remove boleto
 *   POST   /api/boletos/bulk           → upsert em lote
 *   POST   /api/boletos/:id/baixa      → registra pagamento
 *   GET    /api/boletos/kpis           → totais para o dashboard
 *   GET    /api/boletos/classificador  → exporta para DRE
 *   POST   /api/boletos/import-xml     → importa NF-e XML
 *   POST   /api/boletos/import-pdf     → importa boleto PDF
 */

const express  = require('express');
const multer   = require('multer');
const xml2js   = require('xml2js');
const pdfParse = require('pdf-parse');
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
    // Cria tabela se não existir
    await pool.query(`
      CREATE TABLE IF NOT EXISTS boletos (
        id              SERIAL PRIMARY KEY,
        frontend_id     INTEGER,
        fornecedor      TEXT,
        produto         TEXT,
        dt_nota         TEXT,
        nf              TEXT,
        chave_nfe       TEXT,
        parcela         TEXT DEFAULT '1',
        total_parcelas  INTEGER DEFAULT 1,
        plano           TEXT,
        vencimento      DATE,
        valor           NUMERIC(14,2) NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'avencer',
        dt_pagamento    DATE,
        observacao      TEXT,
        origem          TEXT DEFAULT 'manual',
        codigo_barras   TEXT,
        nf_id           INTEGER,
        usuario_id      INTEGER,
        criado_em       TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Adiciona colunas novas sem quebrar tabela existente
    const colunas = [
      ['fornecedor',     'TEXT'],
      ['produto',        'TEXT'],
      ['dt_nota',        'TEXT'],
      ['nf',             'TEXT'],
      ['chave_nfe',      'TEXT'],
      ['parcela',        "TEXT DEFAULT '1'"],
      ['total_parcelas', 'INTEGER DEFAULT 1'],
      ['plano',          'TEXT'],
      ['observacao',     'TEXT'],
      ['codigo_barras',  'TEXT'],
      ['origem',         "TEXT DEFAULT 'manual'"],
      ['atualizado_em',  'TIMESTAMPTZ DEFAULT NOW()'],
    ];
    for (const [col, def] of colunas) {
      await pool.query(
        `ALTER TABLE boletos ADD COLUMN IF NOT EXISTS ${col} ${def}`
      ).catch(() => {});
    }
    // Recria constraint de status de forma segura
    await pool.query(`
      ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_status_check
    `).catch(() => {});
    await pool.query(`
      ALTER TABLE boletos ADD CONSTRAINT boletos_status_check
        CHECK (status IN ('avencer','pago','vencido','cancelado'))
    `).catch(() => {});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_boletos_vencimento  ON boletos(vencimento);
      CREATE INDEX IF NOT EXISTS idx_boletos_status      ON boletos(status);
      CREATE INDEX IF NOT EXISTS idx_boletos_frontend    ON boletos(frontend_id);
    `).catch(() => {});
  }
  initTable().catch(e => console.error('[boletos] initTable:', e.message));

  // ── Helpers ────────────────────────────────────────────────────────────────
  const fmtDate = iso => iso ? String(iso).slice(0, 10) : '';

  function rowToFrontend(b) {
    return {
      id:            b.frontend_id ?? b.id,
      dbId:          b.id,
      fornecedor:    b.fornecedor,
      produto:       b.produto || '',
      dtNota:        fmtDate(b.dt_nota),
      nf:            b.nf || '',
      chaveNfe:      b.chave_nfe || '',
      parcela:       b.parcela || '1',
      totalParcelas: b.total_parcelas || 1,
      plano:         b.plano || '',
      vencimento:    b.vencimento ? fmtDate(b.vencimento.toISOString()) : '',
      valor:         parseFloat(b.valor) || 0,
      status:        b.status || 'avencer',
      dtPagamento:   b.dt_pagamento ? fmtDate(b.dt_pagamento.toISOString()) : '',
      obs:           b.observacao || '',
      origem:        b.origem || 'manual',
      codigoBarras:  b.codigo_barras || '',
    };
  }

  const PLANO_TO_DRE = {
    'Fornec - Proteínas':               'COMPRAS - REVENDA',
    'Fornec - Acompanhamentos':          'COMPRAS - REVENDA',
    'Fornec - Bebidas/Gelo/Sorvete':     'COMPRAS - REVENDA',
    'Fornec - Empório (outros)':         'COMPRAS - REVENDA',
    'Fornec - Empório (carvão)':         'COMPRAS - REVENDA',
    'Fornec - Embalagens':               'Material de Embalagens',
    'Fornec - Acessórios':               'Materiais diversos',
    'Fornec - Outras Desp':              'Serviços prestados por terceiros',
  };

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'avencer')                                   AS avencer,
          COUNT(*) FILTER (WHERE status = 'vencido'
            OR (status = 'avencer' AND vencimento < CURRENT_DATE))                     AS vencidos,
          COUNT(*) FILTER (WHERE status = 'avencer'
            AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days')  AS vence_7dias,
          COALESCE(SUM(valor) FILTER (WHERE status != 'pago'), 0)                      AS total_aberto,
          COALESCE(SUM(valor) FILTER (WHERE status = 'pago'
            AND dt_pagamento >= DATE_TRUNC('month', NOW())), 0)                        AS pago_mes,
          COALESCE(SUM(valor) FILTER (WHERE status = 'avencer'
            AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'), 0) AS valor_vence_7dias
        FROM boletos
        WHERE status != 'cancelado'
      `);
      res.json({
        ok: true, data: {
          avencer:       parseInt(rows[0].avencer),
          vencidos:      parseInt(rows[0].vencidos),
          vence7dias:    parseInt(rows[0].vence_7dias),
          totalAberto:   parseFloat(rows[0].total_aberto),
          pagoMes:       parseFloat(rows[0].pago_mes),
          valorVence7d:  parseFloat(rows[0].valor_vence_7dias || 0),
        }
      });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /classificador ─────────────────────────────────────────────────────
  r.get('/classificador', async (req, res) => {
    try {
      const { mes } = req.query;
      let where = "WHERE status != 'cancelado'";
      const params = [];
      if (mes) {
        const [mm, yyyy] = mes.split('/');
        params.push(parseInt(mm), parseInt(yyyy));
        where += ` AND EXTRACT(MONTH FROM vencimento) = $1 AND EXTRACT(YEAR FROM vencimento) = $2`;
      }
      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST`, params
      );

      const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      const data = rows.map(b => {
        const venc  = b.vencimento ? b.vencimento.toISOString().slice(0, 10) : null;
        const dtNota = b.dt_nota ? String(b.dt_nota).slice(0, 10) : null;
        const isPago = b.status === 'pago';
        const vencDate = venc ? new Date(venc + 'T12:00:00') : null;
        const isOverdue = vencDate && vencDate < hoje && !isPago;
        const mesComp = dtNota
          ? dtNota.slice(5, 7) + '/' + dtNota.slice(0, 4)
          : (venc ? venc.slice(5, 7) + '/' + venc.slice(0, 4) : null);
        const mesCaixa = venc ? venc.slice(5, 7) + '/' + venc.slice(0, 4) : mesComp;
        const dtPag = b.dt_pagamento ? b.dt_pagamento.toISOString().slice(0, 10) : null;
        const fmtBR = iso => iso ? iso.split('-').reverse().join('/') : '';
        return {
          fonte:      isPago ? 'BOLETO' : 'BOLETO_PREV',
          lancamento: b.fornecedor + (b.produto ? ' - ' + String(b.produto).slice(0, 40) : ''),
          valor:      -Math.abs(parseFloat(b.valor) || 0),
          data:       fmtBR(isPago ? (dtPag || venc) : venc),
          mes:        mesComp,
          mesCaixa,
          categoria:  PLANO_TO_DRE[b.plano] || b.plano || 'COMPRAS - REVENDA',
          nf:         b.nf || '',
          parcela:    b.parcela || '1',
          plano:      b.plano || '',
          isOverdue,
          boletoId:   b.id,
        };
      });

      res.json({ ok: true, data, total: data.length, exportedAt: new Date().toISOString() });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { status, mes, fornecedor, busca } = req.query;
      const conds = [], params = [];

      if (status && status !== 'todos') {
        if (status === 'vencido') {
          conds.push(`(status = 'vencido' OR (status = 'avencer' AND vencimento < CURRENT_DATE))`);
        } else {
          params.push(status); conds.push(`status = $${params.length}`);
        }
      }
      if (mes) {
        const [mm, yyyy] = mes.split('/');
        params.push(parseInt(mm), parseInt(yyyy));
        conds.push(`EXTRACT(MONTH FROM vencimento) = $${params.length - 1} AND EXTRACT(YEAR FROM vencimento) = $${params.length}`);
      }
      if (fornecedor) {
        params.push(`%${fornecedor}%`); conds.push(`fornecedor ILIKE $${params.length}`);
      }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(fornecedor ILIKE $${params.length} OR produto ILIKE $${params.length} OR nf ILIKE $${params.length})`);
      }
      conds.push(`status != 'cancelado'`);

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST, id DESC`, params
      );
      res.json({ ok: true, data: rows.map(rowToFrontend), total: rows.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /bulk ─────────────────────────────────────────────────────────────
  r.post('/bulk', async (req, res) => {
    const { boletos = [] } = req.body;
    if (!Array.isArray(boletos)) return res.status(400).json({ ok: false, erro: 'boletos deve ser array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM boletos WHERE status != 'pago' AND usuario_id = $1`, [req.user.id]);

      for (const b of boletos) {
        if (!b.fornecedor || !b.valor) continue;
        await client.query(`
          INSERT INTO boletos
            (frontend_id,fornecedor,produto,dt_nota,nf,parcela,total_parcelas,plano,
             vencimento,valor,status,dt_pagamento,observacao,origem,usuario_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
          b.id ?? null, b.fornecedor, b.produto || null, b.dtNota || null,
          b.nf || null, b.parcela || '1', b.totalParcelas || 1, b.plano || null,
          b.vencimento || null, parseFloat(b.valor) || 0,
          b.status || 'avencer', b.dtPagamento || null, b.obs || null,
          'bulk', req.user.id,
        ]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, count: boletos.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const b = req.body;
    if (!b.fornecedor || !b.valor) return res.status(400).json({ ok: false, erro: 'fornecedor e valor obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO boletos
          (frontend_id,fornecedor,produto,dt_nota,nf,parcela,total_parcelas,plano,
           vencimento,valor,status,observacao,origem,codigo_barras,usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *
      `, [
        b.id ?? null, b.fornecedor, b.produto || null, b.dtNota || null,
        b.nf || null, b.parcela || '1', b.totalParcelas || 1, b.plano || null,
        b.vencimento || null, parseFloat(b.valor), b.status || 'avencer',
        b.obs || null, b.origem || 'manual', b.codigoBarras || null, req.user.id,
      ]);
      res.json({ ok: true, data: rowToFrontend(rows[0]) });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const b = req.body;
    try {
      const { rowCount } = await pool.query(`
        UPDATE boletos SET
          fornecedor=$1, produto=$2, dt_nota=$3, nf=$4, parcela=$5, total_parcelas=$6,
          plano=$7, vencimento=$8, valor=$9, status=$10, dt_pagamento=$11,
          observacao=$12, atualizado_em=NOW()
        WHERE id=$13 OR frontend_id=$13
      `, [
        b.fornecedor, b.produto || null, b.dtNota || null, b.nf || null,
        b.parcela || '1', b.totalParcelas || 1, b.plano || null,
        b.vencimento || null, parseFloat(b.valor), b.status || 'avencer',
        b.dtPagamento || null, b.obs || null, parseInt(req.params.id),
      ]);
      if (rowCount === 0) return res.status(404).json({ ok: false, erro: 'Boleto não encontrado' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /:id/baixa ────────────────────────────────────────────────────────
  r.post('/:id/baixa', async (req, res) => {
    const { dtPagamento, obs } = req.body;
    try {
      await pool.query(`
        UPDATE boletos SET
          status='pago',
          dt_pagamento=COALESCE($1::date, CURRENT_DATE),
          observacao=COALESCE($2, observacao),
          atualizado_em=NOW()
        WHERE id=$3 OR frontend_id=$3
      `, [dtPagamento || null, obs || null, parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(
        `UPDATE boletos SET status='cancelado', atualizado_em=NOW() WHERE id=$1 OR frontend_id=$1`,
        [parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import-xml — importa NF-e ───────────────────────────────────────
  r.post('/import-xml', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo XML não enviado' });

    try {
      const xml = req.file.buffer.toString('utf8');
      const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });

      // Navega pela estrutura padrão NF-e SEFAZ
      const root = parsed.nfeProc?.NFe?.infNFe
                || parsed.NFe?.infNFe
                || parsed.infNFe;

      if (!root) return res.status(422).json({ ok: false, erro: 'Estrutura XML inválida. Verifique se é uma NF-e válida.' });

      const emit    = root.emit;
      const ide     = root.ide;
      const cobr    = root.cobr;
      const total   = root.total?.ICMSTot;
      const chave   = parsed.nfeProc?.protNFe?.infProt?.chNFe || '';

      const fornecedor = emit?.xNome || 'Fornecedor desconhecido';
      const nf         = ide?.nNF || '';
      const dtNota     = ide?.dhEmi
        ? ide.dhEmi.slice(0, 10)
        : (ide?.dEmi || '');
      const valorTotal = parseFloat(total?.vNF || total?.vProd || 0);

      // Extrai parcelas da cobrança
      let parcelas = [];
      if (cobr?.dup) {
        const dups = Array.isArray(cobr.dup) ? cobr.dup : [cobr.dup];
        parcelas = dups.map((d, i) => ({
          parcela:      d.nDup || String(i + 1),
          vencimento:   d.dVenc || null,
          valor:        parseFloat(d.vDup || 0),
        }));
      }

      if (!parcelas.length) {
        // Sem cobr: cria parcela única
        parcelas = [{ parcela: '1', vencimento: null, valor: valorTotal }];
      }

      // Extrai produtos (primeiros 3 para descrição)
      const dets = root.det
        ? (Array.isArray(root.det) ? root.det : [root.det])
        : [];
      const produtos = dets.slice(0, 3).map(d => d.prod?.xProd || '').filter(Boolean);
      const prodDesc = produtos.join(', ') || null;

      // Preview (não salva ainda)
      const preview = parcelas.map((p, i) => ({
        fornecedor,
        produto:       prodDesc,
        dtNota,
        nf,
        chaveNfe:      chave,
        parcela:       String(i + 1),
        totalParcelas: parcelas.length,
        vencimento:    p.vencimento,
        valor:         p.valor || (valorTotal / parcelas.length),
        status:        'avencer',
        origem:        'nfe',
        plano:         '',
      }));

      res.json({ ok: true, preview, fornecedor, nf, dtNota, totalParcelas: parcelas.length, valorTotal });
    } catch (e) {
      console.error('[boletos/import-xml]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro ao processar XML: ' + e.message });
    }
  });

  // ── POST /import-xml/confirmar — salva boletos do preview ─────────────────
  r.post('/import-xml/confirmar', async (req, res) => {
    const { boletos = [] } = req.body;
    if (!Array.isArray(boletos) || !boletos.length) {
      return res.status(400).json({ ok: false, erro: 'Nenhum boleto para salvar' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = [];
      for (const b of boletos) {
        const { rows } = await client.query(`
          INSERT INTO boletos
            (fornecedor,produto,dt_nota,nf,chave_nfe,parcela,total_parcelas,plano,
             vencimento,valor,status,origem,usuario_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'avencer','nfe',$11)
          RETURNING id
        `, [
          b.fornecedor, b.produto || null, b.dtNota || null, b.nf || null,
          b.chaveNfe || null, b.parcela || '1', b.totalParcelas || 1,
          b.plano || null, b.vencimento || null,
          parseFloat(b.valor) || 0, req.user.id,
        ]);
        ids.push(rows[0].id);
      }
      await client.query('COMMIT');
      res.json({ ok: true, ids, count: ids.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── POST /import-pdf — extrai dados de boleto PDF ─────────────────────────
  r.post('/import-pdf', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo PDF não enviado' });

    try {
      const data = await pdfParse(req.file.buffer);
      const text = data.text || '';

      // Extrai linha digitável (47 ou 48 dígitos)
      const codigoBarrasMatch = text.match(/\d{47,48}/);
      const codigoBarras = codigoBarrasMatch ? codigoBarrasMatch[0] : null;

      // Extrai vencimento (DD/MM/YYYY)
      const vencMatches = text.match(/[Vv]encimento[:\s]+(\d{2}\/\d{2}\/\d{4})/);
      const vencimento = vencMatches
        ? vencMatches[1].split('/').reverse().join('-')
        : null;

      // Extrai valor
      const valorMatch = text.match(/[Vv]alor[^0-9]*R?\$?\s*([\d.,]+)/);
      let valor = 0;
      if (valorMatch) {
        valor = parseFloat(valorMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
      }

      // Extrai beneficiário / cedente
      const benefMatch = text.match(/(?:Benefici[aá]rio|Cedente)[:\s]+([^\n]{3,60})/);
      const fornecedor = benefMatch ? benefMatch[1].trim() : 'A identificar';

      // Verifica duplicata por código de barras
      let duplicata = false;
      if (codigoBarras) {
        const dup = await pool.query(
          `SELECT id FROM boletos WHERE codigo_barras = $1 LIMIT 1`,
          [codigoBarras]
        );
        duplicata = dup.rows.length > 0;
      }

      res.json({
        ok: true,
        preview: {
          fornecedor,
          vencimento,
          valor,
          codigoBarras,
          status: 'avencer',
          origem: 'pdf',
        },
        duplicata,
        textoBruto: text.slice(0, 500), // Para debug
      });
    } catch (e) {
      console.error('[boletos/import-pdf]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro ao processar PDF: ' + e.message });
    }
  });

  return r;
};
