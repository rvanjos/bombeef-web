/**
 * routes/faturamento.js — Módulo de Faturamento
 * Importa CSVs do PDV e armazena por período (dia/semana/mês)
 */
const express    = require('express');
const multer     = require('multer');
const autenticar = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024 } });

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS faturamento_periodos (
        id            SERIAL PRIMARY KEY,
        data_inicio   DATE NOT NULL,
        data_fim      DATE NOT NULL,
        tipo_periodo  TEXT DEFAULT 'custom',  -- dia, semana, mes, custom
        label         TEXT,
        fat_bruto     NUMERIC(12,2) DEFAULT 0,
        fat_liquido   NUMERIC(12,2) DEFAULT 0,
        total_pessoas INTEGER DEFAULT 0,
        ticket_medio  NUMERIC(10,2) DEFAULT 0,
        descontos     NUMERIC(12,2) DEFAULT 0,
        categorias    JSONB DEFAULT '{}',
        pagamentos    JSONB DEFAULT '{}',
        csv_raw       TEXT,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fat_data ON faturamento_periodos(data_inicio);
      CREATE INDEX IF NOT EXISTS idx_fat_tipo ON faturamento_periodos(tipo_periodo);
    `).catch(()=>{});
  }
  initTable().catch(e => console.error('[faturamento] initTable:', e.message));

  // ── Helper: parseia o CSV do PDV ──────────────────────────────────────────
  function parseCSV(buffer) {
    const text = buffer.toString('latin1');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    let secao = null;
    const result = {
      ticket: { pessoas_balcao: 0, pessoas_mesa: 0, total_pessoas: 0, ticket_medio: 0 },
      categorias: {},
      pagamentos: {},
      fat_bruto: 0, fat_liquido: 0, descontos: 0,
    };
    const parseVal = s => parseFloat((s||'0').replace('.','').replace(',','.')) || 0;

    for (const line of lines) {
      const cols = line.split(';').map(c => c.trim());
      const desc = cols[0], media = cols[2], val = parseVal(cols[3]);
      if (desc.startsWith('Tipo:')) { secao = desc; continue; }
      if (!desc || desc === 'Descrição') continue;

      if (secao?.includes('0.Ticket')) {
        if (desc === 'PESSOAS BALCAO') {
          result.ticket.pessoas_balcao = parseInt(cols[1]) || 0;
          result.ticket.ticket_medio_balcao = parseVal(media);
        } else if (desc === 'PESSOAS MESA') {
          result.ticket.pessoas_mesa = parseInt(cols[1]) || 0;
        } else if (!desc) {
          result.ticket.total_pessoas = parseInt(cols[1]) || 0;
        }
      } else if (secao?.includes('1.Produtos')) {
        if (desc && !desc.startsWith(';')) result.categorias[desc] = val;
      } else if (secao?.includes('2.Recebimentos')) {
        if (desc && !desc.startsWith(';')) result.pagamentos[desc] = val;
      } else if (secao?.includes('3.Diferença')) {
        if (desc === 'DESCONTOS') result.descontos = Math.abs(val);
      } else if (secao?.includes('4.Faturamento')) {
        if (desc === 'RECEBIMENTOS BRUTO') result.fat_bruto = val;
        else if (!desc) result.fat_liquido = val;
      }
    }
    // Total pessoas e ticket médio geral
    result.ticket.total_pessoas = result.ticket.pessoas_balcao + result.ticket.pessoas_mesa;
    result.ticket.ticket_medio = result.ticket.total_pessoas > 0
      ? Math.round(result.fat_bruto / result.ticket.total_pessoas * 100) / 100 : 0;
    return result;
  }

  // ── POST /import — importa CSV com datas ──────────────────────────────────
  r.post('/import', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    const { data_inicio, data_fim, label } = req.body;
    if (!data_inicio || !data_fim) return res.status(400).json({ ok: false, erro: 'Informe o período' });
    try {
      const d = parseCSV(req.file.buffer);
      // Determina tipo de período
      const di = new Date(data_inicio), df = new Date(data_fim);
      const dias = Math.round((df - di) / 86400000) + 1;
      const tipo = dias === 1 ? 'dia' : dias <= 7 ? 'semana' : dias <= 31 ? 'mes' : 'custom';

      const { rows } = await pool.query(`
        INSERT INTO faturamento_periodos
          (data_inicio, data_fim, tipo_periodo, label, fat_bruto, fat_liquido,
           total_pessoas, ticket_medio, descontos, categorias, pagamentos, csv_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id
      `, [data_inicio, data_fim, tipo, label || null,
          d.fat_bruto, d.fat_liquido,
          d.ticket.total_pessoas, d.ticket.ticket_medio,
          d.descontos,
          JSON.stringify(d.categorias),
          JSON.stringify(d.pagamentos),
          req.file.buffer.toString('latin1')]);

      res.json({ ok: true, id: rows[0].id, dados: d });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / — lista períodos ─────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { tipo, ano, limit = 50 } = req.query;
      const conds = [], params = [];
      if (tipo && tipo !== 'todos') { params.push(tipo); conds.push(`tipo_periodo=$${params.length}`); }
      if (ano) { params.push(ano); conds.push(`EXTRACT(YEAR FROM data_inicio)=$${params.length}`); }
      const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
      params.push(parseInt(limit));
      const { rows } = await pool.query(
        `SELECT * FROM faturamento_periodos ${where}
         ORDER BY data_inicio DESC LIMIT $${params.length}`, params
      );
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /resumo — totais agrupados por mês ────────────────────────────────
  r.get('/resumo', async (req, res) => {
    try {
      const { ano } = req.query;
      const params = [], conds = [];
      if (ano) { params.push(ano); conds.push(`EXTRACT(YEAR FROM data_inicio)=$${params.length}`); }
      const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
      const { rows } = await pool.query(`
        SELECT
          TO_CHAR(data_inicio,'MM/YYYY') AS mes,
          COUNT(*) AS periodos,
          SUM(fat_bruto) AS fat_bruto,
          SUM(fat_liquido) AS fat_liquido,
          SUM(total_pessoas) AS total_pessoas,
          SUM(descontos) AS descontos,
          ROUND(AVG(ticket_medio),2) AS ticket_medio_avg
        FROM faturamento_periodos ${where}
        GROUP BY TO_CHAR(data_inicio,'MM/YYYY'), EXTRACT(YEAR FROM data_inicio), EXTRACT(MONTH FROM data_inicio)
        ORDER BY EXTRACT(YEAR FROM data_inicio) DESC, EXTRACT(MONTH FROM data_inicio) DESC
      `, params);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM faturamento_periodos WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
