/**
 * routes/dre.js — M2: DRE & Classificador
 *
 * Rotas:
 *   GET  /api/dre/sessoes              → lista sessões
 *   GET  /api/dre/sessoes/:id          → carrega sessão
 *   POST /api/dre/salvar               → salva/atualiza sessão (upsert por mes_ref)
 *   DELETE /api/dre/sessoes/:id        → remove sessão
 *   POST /api/dre/import-extrato       → importa extrato bancário (XLSX/CSV/OFX)
 *   GET  /api/dre/relatorio/:mes       → gera relatório DRE estruturado
 *   GET  /api/dre/kpis                 → KPIs financeiros
 *   GET  /api/dre/categorias           → lista categorias DRE configuradas
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

  // ── Init tabelas ───────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dre_sessoes (
        id            SERIAL PRIMARY KEY,
        mes_ref       TEXT NOT NULL,
        descricao     TEXT,
        dados_json    JSONB,
        usuario_id    INTEGER,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (mes_ref, usuario_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dre_lancamentos (
        id            SERIAL PRIMARY KEY,
        sessao_id     INTEGER REFERENCES dre_sessoes(id) ON DELETE CASCADE,
        fonte         TEXT DEFAULT 'MANUAL',
        lancamento    TEXT NOT NULL,
        valor         NUMERIC(14,2) NOT NULL DEFAULT 0,
        data_lanc     TEXT,
        mes           TEXT,
        mes_caixa     TEXT,
        categoria     TEXT,
        grupo_dre     TEXT,
        ignorar       BOOLEAN DEFAULT false,
        boleto_id     INTEGER,
        usuario_id    INTEGER,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_dre_sessoes_mes  ON dre_sessoes(mes_ref);
      CREATE INDEX IF NOT EXISTS idx_dre_lanc_sessao  ON dre_lancamentos(sessao_id);
      CREATE INDEX IF NOT EXISTS idx_dre_lanc_mes     ON dre_lancamentos(mes);
    `);
  }
  initTable().catch(e => console.error('[dre] initTable:', e.message));

  // ── GET /categorias ────────────────────────────────────────────────────────
  r.get('/categorias', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM categorias_dre WHERE ativo=true ORDER BY grupo ASC, ordem ASC, subgrupo ASC`
      );
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /categorias — cria nova categoria ─────────────────────────────────
  r.post('/categorias', async (req, res) => {
    const { grupo, subgrupo, label_exibicao, ordem } = req.body;
    if (!grupo || !subgrupo) return res.status(400).json({ ok: false, erro: 'grupo e subgrupo obrigatórios' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [grupo, subgrupo, label_exibicao || subgrupo, parseInt(ordem) || 0]
      );
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /categorias/:id — atualiza categoria ───────────────────────────────
  r.put('/categorias/:id', async (req, res) => {
    const { grupo, subgrupo, label_exibicao, ordem } = req.body;
    try {
      await pool.query(
        `UPDATE categorias_dre SET grupo=$1, subgrupo=$2, label_exibicao=$3, ordem=$4 WHERE id=$5`,
        [grupo, subgrupo, label_exibicao || subgrupo, parseInt(ordem) || 0, parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /categorias/:id — desativa categoria ────────────────────────────
  r.delete('/categorias/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE categorias_dre SET ativo=false WHERE id=$1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const mes = req.query.mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();

      // Busca sessão do mês
      const { rows: sessoes } = await pool.query(
        `SELECT id, dados_json FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`,
        [mes]
      );

      // Busca meta do mês
      const { rows: metas } = await pool.query(
        `SELECT faturamento_meta, faturamento_real FROM metas WHERE mes = $1 LIMIT 1`,
        [mes]
      );

      let receitas = 0, despesas = 0, resultado = 0;

      if (sessoes.length && sessoes[0].dados_json) {
        const dados = sessoes[0].dados_json;
        const txs = dados.transactions || [];
        for (const t of txs) {
          if (t.ignorar) continue;
          const v = parseFloat(t.valor || 0);
          if (v > 0) receitas += v;
          else despesas += Math.abs(v);
        }
        resultado = receitas - despesas;
      }

      const meta = metas[0] || {};
      res.json({
        ok: true, data: {
          mes,
          receitas,
          despesas,
          resultado,
          margemBruta: receitas > 0 ? ((resultado / receitas) * 100).toFixed(1) : '0.0',
          faturamentoMeta: parseFloat(meta.faturamento_meta || 0),
          faturamentoReal: parseFloat(meta.faturamento_real || receitas || 0),
        }
      });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /sessoes ───────────────────────────────────────────────────────────
  r.get('/sessoes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, mes_ref, descricao, criado_em, atualizado_em,
               jsonb_array_length(dados_json->'transactions') AS total_lancamentos
        FROM dre_sessoes
        ORDER BY mes_ref DESC
      `);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /sessoes/:id ───────────────────────────────────────────────────────
  r.get('/sessoes/:id(*)', async (req, res) => {
    try {
      const isNum = /^\d+$/.test(req.params.id);
      const query = isNum
        ? `SELECT * FROM dre_sessoes WHERE id = $1`
        : `SELECT * FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`;
      const { rows } = await pool.query(query, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Sessão não encontrada' });
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /salvar ───────────────────────────────────────────────────────────
  r.post('/salvar', async (req, res) => {
    const { sessao_id, mes_ref, descricao, dados_json } = req.body;
    if (!mes_ref) return res.status(400).json({ ok: false, erro: 'mes_ref obrigatório' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO dre_sessoes (mes_ref, descricao, dados_json, usuario_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (mes_ref, usuario_id) DO UPDATE SET
          descricao     = EXCLUDED.descricao,
          dados_json    = EXCLUDED.dados_json,
          atualizado_em = NOW()
        RETURNING id
      `, [mes_ref, descricao || `Sessão ${mes_ref}`, JSON.stringify(dados_json), req.user.id]);
      res.json({ ok: true, sessao_id: rows[0].id });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /sessoes/:id ────────────────────────────────────────────────────
  r.delete('/sessoes/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM dre_sessoes WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import-extrato ───────────────────────────────────────────────────
  r.post('/import-extrato', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });

    try {
      const ext  = (req.file.originalname || '').split('.').pop().toLowerCase();
      let lancamentos = [];

      if (ext === 'ofx' || ext === 'ofc') {
        // Parse OFX (texto estruturado)
        lancamentos = parseOFX(req.file.buffer.toString('utf8'));
      } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        // Parse XLSX / CSV
        lancamentos = parseXLSXExtrato(req.file.buffer, ext);
      } else {
        return res.status(422).json({ ok: false, erro: 'Formato não suportado. Use XLSX, CSV ou OFX.' });
      }

      if (!lancamentos.length) {
        return res.status(422).json({ ok: false, erro: 'Nenhum lançamento encontrado no arquivo.' });
      }

      res.json({ ok: true, lancamentos, total: lancamentos.length });
    } catch (e) {
      console.error('[dre/import-extrato]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro ao processar arquivo: ' + e.message });
    }
  });

  // ── GET /relatorio/:mes ────────────────────────────────────────────────────
  r.get('/relatorio/:mes', async (req, res) => {
    try {
      const mes = req.params.mes; // MM/YYYY
      const { rows } = await pool.query(
        `SELECT dados_json FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`,
        [mes]
      );

      if (!rows.length || !rows[0].dados_json) {
        return res.status(404).json({ ok: false, erro: 'Nenhuma sessão encontrada para este mês' });
      }

      const dados   = rows[0].dados_json;
      const txs     = (dados.transactions || []).filter(t => !t.ignorar);

      // Estrutura DRE padrão
      const estrutura = buildDRE(txs);
      res.json({ ok: true, mes, data: estrutura });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function parseOFX(text) {
    // Prefixos de operação bancária — o que vem após é o favorecido
    const OFX_PREF = [
      'PAGAMENTOS PIX QR-CODE','PAGAMENTOS PIX','PAGAMENTOS TRANSF CC ITAU','PAGAMENTOS TRANSF CC',
      'PAGAMENTOS TRANSF','PAGAMENTOS BOLETO','PAGAMENTOS ',
      'PIX RECEBIDO','PIX ENVIADO','PIX QR CODE RECEBIDO','PIX QR CODE',
      'TED RECEBIDA','TED ENVIADA','DOC RECEBIDO','DOC ENVIADO',
      'RECEBIMENTO REDE','RECEBIMENTOS','RECEBIMENTO',
      'DEBITO AUTOMATICO','DEBITO EM CONTA',
      'TRANSFERENCIA ENTRE CONTAS','TRANSFERENCIA',
    ];
    function splitMemo(memo) {
      // 1. CNPJ/CPF no final
      const docRe = /^(.*?)\s+([A-Z][A-Z0-9 .&'\/\-]{3,}?)\s+(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\s*$/;
      const dm = docRe.exec(memo);
      if (dm) return { lancamento: dm[1].trim(), razaoSocial: dm[2].trim() + ' ' + dm[3] };
      // 2. Prefixo bancário conhecido
      const up = memo.toUpperCase();
      for (const p of OFX_PREF) {
        if (up.startsWith(p)) {
          const resto = memo.slice(p.length).trim();
          if (resto.length > 2) return { lancamento: p.trim(), razaoSocial: resto };
          break;
        }
      }
      return { lancamento: memo, razaoSocial: '' };
    }

    const txRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    const result  = [];
    let m;
    while ((m = txRegex.exec(text)) !== null) {
      const bloco = m[1];
      const get   = tag => { const r = bloco.match(new RegExp(`<${tag}>([^<\\n\\r]+)`)); return r ? r[1].trim() : ''; };
      const dtRaw = get('DTPOSTED');
      const dt    = dtRaw.length >= 8 ? `${dtRaw.slice(0,4)}-${dtRaw.slice(4,6)}-${dtRaw.slice(6,8)}` : '';
      const val   = parseFloat(get('TRNAMT').replace(',', '.')) || 0;
      const memo  = get('MEMO') || get('NAME') || 'Lançamento';
      if (!val) continue;
      const mes = dt ? dt.slice(5,7) + '/' + dt.slice(0,4) : '';
      const { lancamento, razaoSocial } = splitMemo(memo);
      result.push({ lancamento, razaoSocial, valor: val, data: dt, mes, mesCaixa: mes, fonte: 'EXTRATO', categoria: '' });
    }
    return result;
  }

  function parseXLSXExtrato(buffer, ext) {
    const wb    = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length < 2) return [];

    // Detecta cabeçalho
    const header = rows[0].map(c => String(c).toLowerCase().trim());
    const iCol = (nomes) => {
      for (const n of nomes) {
        const i = header.findIndex(h => h.includes(n));
        if (i >= 0) return i;
      }
      return -1;
    };

    const colData  = iCol(['data', 'date', 'dt']);
    const colDesc  = iCol(['histórico', 'historico', 'descri', 'memo', 'lancamento', 'lançamento']);
    const colVal   = iCol(['valor', 'value', 'montante', 'quantia']);
    const colCred  = iCol(['crédito', 'credito', 'entrada', 'credit']);
    const colDeb   = iCol(['débito', 'debito', 'saída', 'saida', 'debit']);

    const result = [];
    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const desc = String(row[colDesc] ?? '').trim();
      if (!desc) continue;

      let val = 0;
      if (colVal >= 0) {
        val = parseFloat(String(row[colVal]).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
      } else if (colCred >= 0 || colDeb >= 0) {
        const cred = parseFloat(String(row[colCred] ?? '0').replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
        const deb  = parseFloat(String(row[colDeb]  ?? '0').replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
        val = cred > 0 ? cred : -deb;
      }

      if (val === 0) continue;

      let dtStr = '';
      if (colData >= 0 && row[colData]) {
        const d = row[colData];
        if (d instanceof Date) {
          dtStr = d.toISOString().slice(0, 10);
        } else {
          // tenta parsear DD/MM/YYYY
          const parts = String(d).split('/');
          if (parts.length === 3) dtStr = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
          else dtStr = String(d).slice(0, 10);
        }
      }

      const mes = dtStr ? dtStr.slice(5, 7) + '/' + dtStr.slice(0, 4) : '';
      result.push({ lancamento: desc, valor: val, data: dtStr, mes, mesCaixa: mes, fonte: 'EXTRATO', categoria: '' });
    }
    return result;
  }

  function buildDRE(txs) {
    const grupos = {};
    for (const t of txs) {
      const cat = t.categoria || 'Sem categoria';
      if (!grupos[cat]) grupos[cat] = { total: 0, lancamentos: [] };
      grupos[cat].total += parseFloat(t.valor || 0);
      grupos[cat].lancamentos.push(t);
    }

    const receitas  = Object.entries(grupos).filter(([,v]) => v.total > 0);
    const despesas  = Object.entries(grupos).filter(([,v]) => v.total < 0);
    const totRec    = receitas.reduce((s, [,v]) => s + v.total, 0);
    const totDesp   = despesas.reduce((s, [,v]) => s + Math.abs(v.total), 0);

    return {
      receitas:  receitas.map(([cat, v]) => ({ categoria: cat, total: v.total, lancamentos: v.lancamentos })),
      despesas:  despesas.map(([cat, v]) => ({ categoria: cat, total: Math.abs(v.total), lancamentos: v.lancamentos })),
      totalReceitas:  totRec,
      totalDespesas:  totDesp,
      resultado:      totRec - totDesp,
      margemBruta:    totRec > 0 ? (((totRec - totDesp) / totRec) * 100).toFixed(2) : '0.00',
    };
  }

  return r;
};
