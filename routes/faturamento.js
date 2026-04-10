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
    // Tabela de metas mensais de faturamento
    await pool.query(`
      CREATE TABLE IF NOT EXISTS faturamento_metas (
        id         SERIAL PRIMARY KEY,
        mes_ref    TEXT NOT NULL UNIQUE,  -- MM/YYYY
        meta       NUMERIC(12,2) NOT NULL DEFAULT 0,
        obs        TEXT,
        criado_em  TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
  }
  initTable().catch(e => console.error('[faturamento] initTable:', e.message));

  // ── Detecta formato do arquivo ───────────────────────────────────────────
  function detectarFormato(buffer) {
    // XMenu: UTF-16, começa com "Loja :" ou tem header "NumeroCaixa;TotalProdutos"
    try {
      const utf16 = buffer.toString('utf16le');
      if (utf16.includes('NumeroCaixa') || utf16.includes('Loja :')) return 'xmenu';
    } catch(_) {}
    const latin = buffer.toString('latin1');
    if (latin.includes('NumeroCaixa') || latin.includes('Loja :')) return 'xmenu';
    return 'pdv'; // formato padrão do PDV
  }

  // ── Parser XMenu (R200 - Vendas Diárias por Caixa) ───────────────────────
  // Usa apenas: Bruto, Descontos, Liquido — ignora Cancelamento
  function parseXMenu(buffer) {
    let text;
    try { text = buffer.toString('utf16le'); } catch(_) { text = buffer.toString('latin1'); }
    const lines = text.split('\n');
    const parseVal = s => parseFloat((s||'0').trim().replace(',','.')) || 0;

    // Extrair período do cabeçalho
    let dataInicio = '', dataFim = '';
    for (const l of lines.slice(0, 5)) {
      const m = l.match(/Data Inicial\s*:\s*(\d{2}\/\d{2}\/\d{4})/);
      if (m) dataInicio = m[1].split('/').reverse().join('-');
      const m2 = l.match(/Data Final\s*:\s*(\d{2}\/\d{2}\/\d{4})/);
      if (m2) dataFim = m2[1].split('/').reverse().join('-');
    }

    // Encontrar linha do header
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('NumeroCaixa') && lines[i].includes('Bruto')) {
        headerIdx = i; break;
      }
    }
    if (headerIdx < 0) throw new Error('Header NumeroCaixa não encontrado');

    const headers = lines[headerIdx].trim().split(';').map(h => h.trim());
    const iB = headers.indexOf('Bruto');
    const iL = headers.indexOf('Liquido');
    const iD = headers.indexOf('Descontos');

    let fat_bruto = 0, fat_liquido = 0, descontos = 0, dias = 0;
    const diasDetalhes = [];

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cols = lines[i].trim().replace(/\r/g,'').split(';');
      if (cols.length < 4 || !cols[0].trim()) continue;
      const bruto = iB >= 0 ? parseVal(cols[iB]) : 0;
      const liq   = iL >= 0 ? parseVal(cols[iL]) : 0;
      const desc  = iD >= 0 ? parseVal(cols[iD]) : 0;
      if (bruto === 0 && liq === 0) continue;
      fat_bruto  += bruto;
      fat_liquido += liq;
      descontos  += desc;
      dias++;
      diasDetalhes.push({ bruto, liq, desc });
    }

    return {
      fonte: 'xmenu',
      fat_bruto: Math.round(fat_bruto * 100) / 100,
      fat_liquido: Math.round(fat_liquido * 100) / 100,
      descontos: Math.round(descontos * 100) / 100,
      ticket: { total_pessoas: 0, ticket_medio: 0 },
      categorias: {},
      pagamentos: {},
      dias,
      dataInicio, dataFim, // do cabeçalho do arquivo
    };
  }

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

  // ── Parser Xmenu Listagem (relatório de vendas por dia) ────────────────────
  function parseXMenuListagem(buffer) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // Corrige !ref incorreto (bug Xmenu)
    const decoded = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    let maxR = decoded.e.r, maxC = decoded.e.c;
    for (const addr of Object.keys(sheet)) {
      if (addr[0] === '!') continue;
      const cell = XLSX.utils.decode_cell(addr);
      if (cell.r > maxR) maxR = cell.r;
      if (cell.c > maxC) maxC = cell.c;
    }
    sheet['!ref'] = XLSX.utils.encode_range({ s: decoded.s, e: { r: maxR, c: maxC } });

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const dias = [];
    let diaAtual = null;

    for (const row of rows) {
      const cel0 = String(row[0] || '').trim();

      // Linha de cabeçalho do dia: "Data: 01/04/2026 (7)"
      if (cel0.startsWith('Data:')) {
        const m = cel0.match(/Data:\s*(\d{2})\/(\d{2})\/(\d{4})\s*\((\d+)\)/);
        if (m) {
          const data = `${m[3]}-${m[2]}-${m[1]}`; // YYYY-MM-DD
          const valStr = String(row[2] || '').replace(/R\$\s*/,'').replace(/\./g,'').replace(',','.').trim();
          diaAtual = {
            data,
            pedidos: parseInt(m[4]) || 0,
            fat_bruto: parseFloat(valStr) || 0,
            pessoas: parseInt(row[4]) || 0,
            fat_nfce: 0, qtd_nfce: 0,
            fat_mei: 0,  qtd_mei: 0,
            cancelados: 0,
          };
          dias.push(diaAtual);
        }
        continue;
      }

      // Linha de pedido: operador = "CAIXA"
      if (diaAtual && cel0 === 'CAIXA') {
        const cancelado = String(row[5] || '').toLowerCase() === 'verdadeiro';
        const emissor   = String(row[6] || '').trim().toUpperCase();
        const valor     = parseFloat(String(row[2] || '0').replace(',', '.')) || 0;
        if (cancelado) {
          diaAtual.cancelados++;
        } else if (emissor === 'NFCE') {
          diaAtual.qtd_nfce++;
          diaAtual.fat_nfce += valor;
        } else if (emissor === 'MEI') {
          diaAtual.qtd_mei++;
          diaAtual.fat_mei += valor;
        }
      }
    }

    return dias;
  }

  // ── POST /import — importa CSV com datas ──────────────────────────────────
  r.post('/import', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    const { data_inicio, data_fim, label } = req.body;
    if (!data_inicio || !data_fim) return res.status(400).json({ ok: false, erro: 'Informe o período' });
    try {
      const formato = detectarFormato(req.file.buffer);
      const d = formato === 'xmenu'
        ? parseXMenu(req.file.buffer)
        : parseCSV(req.file.buffer);

      // XMenu: se não informou datas, usa as do cabeçalho do arquivo
      const ini = data_inicio || d.dataInicio;
      const fim = data_fim    || d.dataFim;
      if (!ini || !fim) return res.status(400).json({ ok: false, erro: 'Informe o período' });

      const di = new Date(ini), df = new Date(fim);
      const nDias = Math.round((df - di) / 86400000) + 1;
      const tipo = nDias === 1 ? 'dia' : nDias <= 7 ? 'semana' : nDias <= 31 ? 'mes' : 'custom';

      const labelFinal = label ||
        (formato === 'xmenu' ? `XMenu ${ini.slice(0,7)}` : null);

      const { rows } = await pool.query(`
        INSERT INTO faturamento_periodos
          (data_inicio, data_fim, tipo_periodo, label, fat_bruto, fat_liquido,
           total_pessoas, ticket_medio, descontos, categorias, pagamentos, csv_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id
      `, [ini, fim, tipo, labelFinal,
          d.fat_bruto, d.fat_liquido,
          d.ticket.total_pessoas, d.ticket.ticket_medio,
          d.descontos,
          JSON.stringify(d.categorias),
          JSON.stringify(d.pagamentos),
          req.file.buffer.toString('latin1')]);

      res.json({ ok: true, id: rows[0].id, formato, dados: d });
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
          ROUND(CASE WHEN SUM(total_pessoas)>0 THEN SUM(fat_bruto)/SUM(total_pessoas) ELSE 0 END, 2) AS ticket_medio_avg,
          COALESCE(SUM((pagamentos->'nfce'->>'total')::numeric),0) AS fat_nfce,
          COALESCE(SUM((pagamentos->'mei'->>'total')::numeric),0) AS fat_mei,
          COALESCE(SUM((pagamentos->'nfce'->>'qtd')::int),0) AS qtd_nfce,
          COALESCE(SUM((pagamentos->'mei'->>'qtd')::int),0) AS qtd_mei
        FROM faturamento_periodos ${where}
        GROUP BY TO_CHAR(data_inicio,'MM/YYYY'), EXTRACT(YEAR FROM data_inicio), EXTRACT(MONTH FROM data_inicio)
        ORDER BY EXTRACT(YEAR FROM data_inicio) DESC, EXTRACT(MONTH FROM data_inicio) DESC
      `, params);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import-listagem — importa relatório de vendas por dia (Xmenu) ───
  r.post('/import-listagem', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    try {
      const dias = parseXMenuListagem(req.file.buffer);
      if (!dias.length) return res.status(422).json({ ok: false, erro: 'Nenhum dia encontrado no arquivo' });

      const client = await pool.connect();
      let inseridos = 0, atualizados = 0;
      try {
        await client.query('BEGIN');
        for (const d of dias) {
          const ticket = d.pessoas > 0 ? Math.round(d.fat_bruto / d.pessoas * 100) / 100 : 0;
          const pagamentos = JSON.stringify({
            nfce: { qtd: d.qtd_nfce, total: Math.round(d.fat_nfce * 100) / 100 },
            mei:  { qtd: d.qtd_mei,  total: Math.round(d.fat_mei  * 100) / 100 },
          });
          const categorias = JSON.stringify({
            nfce_pct: d.fat_bruto > 0 ? Math.round(d.fat_nfce / d.fat_bruto * 100) : 0,
            mei_pct:  d.fat_bruto > 0 ? Math.round(d.fat_mei  / d.fat_bruto * 100) : 0,
          });
          // Upsert por data (dia)
          const { rowCount } = await client.query(`
            INSERT INTO faturamento_periodos
              (data_inicio, data_fim, tipo_periodo, label, fat_bruto, fat_liquido,
               total_pessoas, ticket_medio, descontos, categorias, pagamentos)
            VALUES ($1,$1,'dia',$2,$3,$3,$4,$5,0,$6,$7)
            ON CONFLICT DO NOTHING
          `, [d.data, `Xmenu ${d.data}`, d.fat_bruto, d.pessoas, ticket, categorias, pagamentos]);
          if (rowCount > 0) inseridos++; else atualizados++;
        }
        await client.query('COMMIT');
      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }

      // Atualiza meta do mês com realizado acumulado
      const mes = dias[0].data.slice(5,7) + '/' + dias[0].data.slice(0,4);
      const { rows: real } = await pool.query(`
        SELECT COALESCE(SUM(fat_bruto),0) AS total
        FROM faturamento_periodos
        WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1 AND tipo_periodo = 'dia'
      `, [mes]);

      res.json({
        ok: true, inseridos, atualizados,
        dias: dias.length,
        fat_total: dias.reduce((s,d) => s + d.fat_bruto, 0),
        pessoas_total: dias.reduce((s,d) => s + d.pessoas, 0),
        fat_real_mes: parseFloat(real.rows[0]?.total || 0),
        mes,
      });
    } catch(e) {
      console.error('[faturamento/import-listagem]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /meta/:mes — busca meta do mês ──────────────────────────────────
  r.get('/meta/:mes', async (req, res) => {
    try {
      const mes = decodeURIComponent(req.params.mes); // MM/YYYY
      const { rows } = await pool.query(
        `SELECT * FROM faturamento_metas WHERE mes_ref=$1`, [mes]
      );
      // Também retorna o faturamento real já lançado no mês
      const real = await pool.query(`
        SELECT COALESCE(SUM(fat_bruto),0) AS fat_bruto
        FROM faturamento_periodos
        WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1
      `, [mes]);
      res.json({ ok: true, data: rows[0]||null, fat_real: parseFloat(real.rows[0]?.fat_bruto||0) });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /meta — salva/atualiza meta do mês ───────────────────────────────
  r.post('/meta', async (req, res) => {
    const { mes_ref, meta, obs } = req.body;
    if (!mes_ref || meta === undefined) return res.status(400).json({ ok: false, erro: 'mes_ref e meta obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO faturamento_metas (mes_ref, meta, obs)
        VALUES ($1, $2, $3)
        ON CONFLICT (mes_ref) DO UPDATE SET
          meta = EXCLUDED.meta,
          obs  = COALESCE(EXCLUDED.obs, faturamento_metas.obs),
          atualizado_em = NOW()
        RETURNING *
      `, [mes_ref, parseFloat(meta), obs||null]);
      res.json({ ok: true, data: rows[0] });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /metas — lista todas as metas ────────────────────────────────────
  r.get('/metas', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT m.*,
          COALESCE((
            SELECT SUM(fat_bruto) FROM faturamento_periodos
            WHERE TO_CHAR(data_inicio,'MM/YYYY') = m.mes_ref
          ),0) AS fat_real
        FROM faturamento_metas m
        ORDER BY m.mes_ref DESC
        LIMIT 24
      `);
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
