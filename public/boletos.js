/**
 * routes/boletos.js
 * Controle de boletos e NF-e — persistência no PostgreSQL
 *
 * Tabelas criadas automaticamente:
 *   boletos  — boletos/parcelas cadastrados no nfe_boletos_bombeef.html
 *
 * Rotas:
 *   GET  /api/boletos              → lista boletos (filtro: status, mes)
 *   POST /api/boletos              → cria boleto individual
 *   PUT  /api/boletos/:id          → atualiza boleto
 *   DELETE /api/boletos/:id        → remove boleto
 *   POST /api/boletos/bulk         → upsert em lote (sincronização do frontend)
 *   POST /api/boletos/:id/baixa    → registra pagamento
 *   GET  /api/boletos/kpis         → totais para o dashboard
 *   GET  /api/boletos/classificador → exporta formato compatível com o classificador
 */

const express = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS boletos (
        id              SERIAL PRIMARY KEY,
        frontend_id     INTEGER,           -- ID gerado pelo frontend (boletosId)
        fornecedor      TEXT NOT NULL,
        produto         TEXT,
        dt_nota         TEXT,              -- data da NF-e (YYYY-MM-DD ou string)
        nf              TEXT,              -- número da NF-e
        parcela         TEXT DEFAULT '1',
        plano           TEXT,              -- categoria DRE
        vencimento      DATE,
        valor           NUMERIC(14,2) NOT NULL DEFAULT 0,
        status          TEXT DEFAULT 'avencer', -- avencer | pago | vencido
        dt_pagamento    DATE,
        observacao      TEXT,
        origem          TEXT DEFAULT 'manual', -- manual | nfe | csv
        nf_id           INTEGER,           -- referência à NF-e de origem
        usuario_id      INTEGER,
        criado_em       TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_boletos_vencimento ON boletos(vencimento);
      CREATE INDEX IF NOT EXISTS idx_boletos_status     ON boletos(status);
      CREATE INDEX IF NOT EXISTS idx_boletos_frontend   ON boletos(frontend_id);
    `);
  }
  initTable().catch(e => console.error('[boletos] initTable:', e.message));

  // ── Helpers ────────────────────────────────────────────────────────────────
  function rowToFrontend(b) {
    return {
      id:           b.frontend_id ?? b.id,
      dbId:         b.id,
      fornecedor:   b.fornecedor,
      produto:      b.produto || '',
      dtNota:       b.dt_nota || '',
      nf:           b.nf || '',
      parcela:      b.parcela || '1',
      plano:        b.plano || '',
      vencimento:   b.vencimento ? b.vencimento.toISOString().slice(0, 10) : '',
      valor:        parseFloat(b.valor) || 0,
      status:       b.status || 'avencer',
      dtPagamento:  b.dt_pagamento ? b.dt_pagamento.toISOString().slice(0, 10) : '',
      obs:          b.observacao || '',
      origem:       b.origem || 'manual',
    };
  }

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status != 'pago')                        AS abertos,
          COUNT(*) FILTER (WHERE status = 'vencido' OR (status = 'avencer' AND vencimento < CURRENT_DATE)) AS vencidos,
          COALESCE(SUM(valor) FILTER (WHERE status != 'pago'), 0)         AS total_aberto,
          COALESCE(SUM(valor) FILTER (WHERE status = 'pago'
            AND dt_pagamento >= DATE_TRUNC('month', NOW())), 0)           AS pago_mes
        FROM boletos
      `);
      res.json({ ok: true, data: {
        abertos:      parseInt(rows[0].abertos),
        vencidos:     parseInt(rows[0].vencidos),
        total_aberto: parseFloat(rows[0].total_aberto),
        pago_mes:     parseFloat(rows[0].pago_mes),
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /classificador — formato para o classificador DRE ─────────────────
  r.get('/classificador', async (req, res) => {
    try {
      const { mes } = req.query;
      let where = "WHERE status != 'pago'";
      const params = [];
      if (mes) {
        const [mm, yyyy] = mes.split('/');
        params.push(parseInt(mm), parseInt(yyyy));
        where += ` AND EXTRACT(MONTH FROM vencimento) = $1 AND EXTRACT(YEAR FROM vencimento) = $2`;
      }
      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST`, params
      );

      const PLANO_TO_DRE = {
        'Fornec - Proteínas': 'COMPRAS - REVENDA',
        'Fornec - Acompanhamentos': 'COMPRAS - REVENDA',
        'Fornec - Bebidas/Gelo/Sorvete': 'COMPRAS - REVENDA',
        'Fornec - Empório (outros)': 'COMPRAS - REVENDA',
        'Fornec - Empório (carvão)': 'COMPRAS - REVENDA',
        'Fornec - Embalagens': 'Material de Embalagens',
        'Fornec - Acessórios': 'Materiais diversos',
        'Fornec - Outras Desp': 'Serviços prestados por terceiros',
      };

      const hoje = new Date(); hoje.setHours(0,0,0,0);
      const fmtDate = iso => iso ? iso.split('-').reverse().join('/') : '';

      const data = rows.map(b => {
        const venc = b.vencimento ? b.vencimento.toISOString().slice(0,10) : null;
        const dtNota = b.dt_nota ? String(b.dt_nota).slice(0,10) : null;
        const isPago = b.status === 'pago';
        const vencDate = venc ? new Date(venc + 'T12:00:00') : null;
        const isOverdue = vencDate && vencDate < hoje && !isPago;
        const mesComp = dtNota
          ? dtNota.slice(5,7) + '/' + dtNota.slice(0,4)
          : (venc ? venc.slice(5,7) + '/' + venc.slice(0,4) : null);
        const mesCaixa = venc ? venc.slice(5,7) + '/' + venc.slice(0,4) : mesComp;
        const dtPag = b.dt_pagamento ? b.dt_pagamento.toISOString().slice(0,10) : null;
        return {
          fonte: isPago ? 'BOLETO' : 'BOLETO_PREV',
          lancamento: b.fornecedor + (b.produto ? ' - ' + String(b.produto).slice(0,40) : ''),
          valor: -Math.abs(parseFloat(b.valor) || 0),
          data: fmtDate(isPago ? (dtPag || venc) : venc),
          mes: mesComp,
          mesCaixa,
          categoria: PLANO_TO_DRE[b.plano] || b.plano || 'COMPRAS - REVENDA',
          nf: b.nf || '',
          parcela: b.parcela || '1',
          plano: b.plano || '',
          isOverdue,
          boletoId: b.id,
        };
      });

      res.json({ ok: true, data, total: data.length, exportedAt: new Date().toISOString() });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / — lista boletos ──────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { status, mes } = req.query;
      const conds = [];
      const params = [];
      if (status && status !== 'todos') {
        params.push(status);
        conds.push(`status = $${params.length}`);
      }
      if (mes) {
        // mes = MM/YYYY
        const [mm, yyyy] = mes.split('/');
        params.push(parseInt(mm), parseInt(yyyy));
        conds.push(`EXTRACT(MONTH FROM vencimento) = $${params.length - 1}
                    AND EXTRACT(YEAR FROM vencimento) = $${params.length}`);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST, id DESC`,
        params
      );
      res.json({ ok: true, data: rows.map(rowToFrontend) });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /bulk — upsert em lote (sincronização do frontend) ───────────────
  r.post('/bulk', async (req, res) => {
    const { boletos = [], globalId } = req.body;
    if (!Array.isArray(boletos)) return res.status(400).json({ ok: false, erro: 'boletos deve ser array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Desativa todos os do usuário e reinsere — abordagem mais simples para bulk sync
      // Mantém histórico de pagos
      await client.query(`
        DELETE FROM boletos WHERE status != 'pago' AND usuario_id = $1
      `, [req.user.id]);

      for (const b of boletos) {
        if (!b.fornecedor || !b.valor) continue;
        await client.query(`
          INSERT INTO boletos
            (frontend_id, fornecedor, produto, dt_nota, nf, parcela, plano,
             vencimento, valor, status, dt_pagamento, observacao, origem, nf_id, usuario_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
          b.id ?? null,
          b.fornecedor,
          b.produto || null,
          b.dtNota || b.dt_nota || null,
          b.nf || null,
          b.parcela || '1',
          b.plano || null,
          b.vencimento || null,
          parseFloat(b.valor) || 0,
          b.status || 'avencer',
          b.dtPagamento || b.dt_pagamento || null,
          b.obs || b.observacao || null,
          b.origem || 'manual',
          b.nfId || b.nf_id || null,
          req.user.id,
        ]);
      }

      await client.query('COMMIT');
      res.json({ ok: true, count: boletos.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── POST / — cria boleto individual ───────────────────────────────────────
  r.post('/', async (req, res) => {
    const b = req.body;
    if (!b.fornecedor || !b.valor) return res.status(400).json({ ok: false, erro: 'fornecedor e valor obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO boletos
          (frontend_id, fornecedor, produto, dt_nota, nf, parcela, plano,
           vencimento, valor, status, observacao, origem, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *
      `, [
        b.id ?? null, b.fornecedor, b.produto || null, b.dtNota || null,
        b.nf || null, b.parcela || '1', b.plano || null,
        b.vencimento || null, parseFloat(b.valor),
        b.status || 'avencer', b.obs || null, b.origem || 'manual', req.user.id,
      ]);
      res.json({ ok: true, data: rowToFrontend(rows[0]) });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id — atualiza boleto ─────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const b = req.body;
    try {
      await pool.query(`
        UPDATE boletos SET
          fornecedor=$1, produto=$2, dt_nota=$3, nf=$4, parcela=$5, plano=$6,
          vencimento=$7, valor=$8, status=$9, dt_pagamento=$10,
          observacao=$11, atualizado_em=NOW()
        WHERE id=$12 OR frontend_id=$12
      `, [
        b.fornecedor, b.produto || null, b.dtNota || null, b.nf || null,
        b.parcela || '1', b.plano || null, b.vencimento || null,
        parseFloat(b.valor), b.status || 'avencer',
        b.dtPagamento || null, b.obs || null,
        parseInt(req.params.id),
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /:id/baixa — registra pagamento ──────────────────────────────────
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
        `DELETE FROM boletos WHERE id=$1 OR frontend_id=$1`,
        [parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
