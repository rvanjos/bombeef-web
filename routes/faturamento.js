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
    // Adicionar coluna atualizado_em se não existir (migração)
    await pool.query(`
      ALTER TABLE faturamento_periodos ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ DEFAULT NOW()
    `).catch(()=>{});
    // Tabela de metas mensais de faturamento
    // Tabela para registrar destino do dinheiro (reconciliação)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS faturamento_caixa (
        id            SERIAL PRIMARY KEY,
        mes_ref       TEXT NOT NULL,
        data          DATE,
        tipo          TEXT NOT NULL, -- 'pagamento', 'retirada', 'deposito', 'caixa_fisico'
        descricao     TEXT,
        valor         NUMERIC(12,2) NOT NULL DEFAULT 0,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

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

  // ── Parser Xmenu Formas de Pagamento ───────────────────────────────────────
  function parseXMenuFormasPagamento(buffer) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // Corrige !ref percorrendo todas as células
    let mR = 0, mC = 0;
    for (const addr of Object.keys(sheet)) {
      if (addr[0] === '!') continue;
      const c = XLSX.utils.decode_cell(addr);
      if (c.r > mR) mR = c.r;
      if (c.c > mC) mC = c.c;
    }
    sheet['!ref'] = XLSX.utils.encode_range({ s: {r:0,c:0}, e: { r: mR, c: mC } });

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
    if (rows.length < 2) return { dias: [], totais: {} };

    // Encontrar linha de cabeçalho (tem "DINHEIRO" ou "PIX" ou "REDE")
    let headerRow = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const r = rows[i];
      if (r && r.some(c => c && /DINHEIRO|PIX|REDE|PAGSEGURO|VOUCHER/i.test(String(c)))) {
        headerRow = i; break;
      }
    }

    const formas = [];
    const headerCols = rows[headerRow] || [];
    // Encontrar col de início das formas (pular cols de label/data)
    let startCol = 2;
    for (let c = 0; c < headerCols.length; c++) {
      if (headerCols[c] && /DINHEIRO|PIX|REDE|PAGSEGURO|VOUCHER/i.test(String(headerCols[c]))) {
        startCol = c; break;
      }
    }
    for (let c = startCol; c < headerCols.length; c++) {
      const v = headerCols[c];
      if (v && String(v).trim()) formas.push(String(v).trim().toUpperCase());
    }

    const resultado = { dias: [], totais: {} };

    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const cel0 = String(row[0] || '').trim();
      const cel1 = row[1];

      // Linha de total — captura e pula
      if (/total|grande/i.test(cel0)) {
        formas.forEach((f, idx) => {
          const v = parseFloat(String(row[startCol + idx] || '').replace(',', '.')) || 0;
          if (v > 0) resultado.totais[f] = (resultado.totais[f] || 0) + v;
        });
        continue;
      }

      // Linha de dia — detectar data na col 1 (DD/MM/YYYY, YYYY-MM-DD, ou Date obj)
      if (!cel1 && cel1 !== 0) continue;
      let data = null;
      const dtStr = String(cel1).trim();

      // Tenta DD/MM/YYYY
      const m1 = dtStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m1) data = m1[3] + '-' + m1[2] + '-' + m1[1];

      // Tenta YYYY-MM-DD
      if (!data) { const m2 = dtStr.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m2) data = m2[0]; }

      // Tenta número serial Excel (dias desde 1900)
      if (!data && /^\d+(\.\d+)?$/.test(dtStr)) {
        try {
          const d = XLSX.SSF.parse_date_code(parseFloat(dtStr));
          if (d) data = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
        } catch(e) {}
      }

      if (!data) continue;

      const dia = { data, formas: {}, total: 0 };
      formas.forEach((f, idx) => {
        const raw = row[startCol + idx];
        const v = parseFloat(String(raw || '').replace(',', '.')) || 0;
        if (v > 0) { dia.formas[f] = v; dia.total += v; }
      });
      if (dia.total > 0 || Object.keys(dia.formas).length > 0) resultado.dias.push(dia);
    }
    return resultado;
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
          // Upsert: remove dia existente e reinsere com dados atualizados
          const existing = await client.query(
            `SELECT id FROM faturamento_periodos WHERE data_inicio=$1 AND tipo_periodo='dia'`, [d.data]
          );
          if (existing.rows.length) {
            await client.query(`DELETE FROM faturamento_periodos WHERE id=$1`, [existing.rows[0].id]);
            atualizados++;
          } else {
            inseridos++;
          }
          await client.query(`
            INSERT INTO faturamento_periodos
              (data_inicio, data_fim, tipo_periodo, label, fat_bruto, fat_liquido,
               total_pessoas, ticket_medio, descontos, categorias, pagamentos)
            VALUES ($1,$1,'dia',$2,$3,$3,$4,$5,0,$6,$7)
          `, [d.data, 'Xmenu ' + d.data, d.fat_bruto, d.pessoas, ticket, categorias, pagamentos]);
        }
        await client.query('COMMIT');
      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }

      const mes = dias[0].data.slice(5,7) + '/' + dias[0].data.slice(0,4);
      const realQ = await pool.query(`
        SELECT COALESCE(SUM(fat_bruto),0) AS total
        FROM faturamento_periodos
        WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1 AND tipo_periodo = 'dia'
      `, [mes]);

      res.json({
        ok: true, inseridos, atualizados,
        dias: dias.length,
        fat_total: dias.reduce((s,d) => s + d.fat_bruto, 0),
        pessoas_total: dias.reduce((s,d) => s + d.pessoas, 0),
        fat_real_mes: parseFloat(realQ.rows[0]?.total || 0),
        mes,
      });
    } catch(e) {
      console.error('[faturamento/import-listagem]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /import-formas — importa relatório de formas de pagamento Xmenu ───
  r.post('/import-formas', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    try {
      const result = parseXMenuFormasPagamento(req.file.buffer);
      if (!result.dias.length) return res.status(422).json({ ok: false, erro: 'Nenhum dia encontrado' });

      const client = await pool.connect();
      let atualizados = 0;
      try {
        await client.query('BEGIN');
        for (const d of result.dias) {
          // Merge com o registro do dia existente — atualiza só o campo pagamentos
          const existing = await client.query(
            `SELECT id, pagamentos FROM faturamento_periodos WHERE data_inicio=$1 AND tipo_periodo='dia'`,
            [d.data]
          );
          // Normaliza sempre para snake_case (evita chaves duplicadas DINHEIRO/dinheiro)
          const formasNorm = {
            dinheiro:     d.formas['DINHEIRO']       || d.formas['dinheiro']      || 0,
            pix_conta:    d.formas['PIX NA CONTA']   || d.formas['pix_conta']     || 0,
            pix_pag:      d.formas['PIX PAGSEGURO']  || d.formas['pix_pag']       || 0,
            pagseguro:    d.formas['PAGSEGURO']      || d.formas['pagseguro']     || 0,
            rede_credito: d.formas['REDE CREDITO']   || d.formas['rede_credito']  || 0,
            rede_debito:  d.formas['REDE DEBITO']    || d.formas['rede_debito']   || 0,
            voucher:      d.formas['VOUCHER']         || d.formas['voucher']       || 0,
            clube:        d.formas['CLUBE DA PICANHA']|| d.formas['clube']         || 0,
          };
          if (existing.rows.length) {
            const pagAtual = existing.rows[0].pagamentos || {};
            // Preserva nfce/mei da Listagem, substitui formas com dados normalizados
            const pagMerge = {
              ...(pagAtual.nfce ? { nfce: pagAtual.nfce } : {}),
              ...(pagAtual.mei  ? { mei:  pagAtual.mei  } : {}),
              ...formasNorm,
            };
            await client.query(
              `UPDATE faturamento_periodos SET pagamentos=$1, atualizado_em=NOW() WHERE id=$2`,
              [JSON.stringify(pagMerge), existing.rows[0].id]
            );
            atualizados++;
          } else {
            await client.query(`
              INSERT INTO faturamento_periodos
                (data_inicio, data_fim, tipo_periodo, label, fat_bruto, fat_liquido,
                 total_pessoas, ticket_medio, descontos, categorias, pagamentos)
              VALUES ($1,$1,'dia',$2,$3,$3,0,0,0,'{}', $4)
            `, [d.data, 'Xmenu ' + d.data, d.total, JSON.stringify(formasNorm)]);
            atualizados++;
          }
        }
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }

      const mes = result.dias[0].data.slice(5,7) + '/' + result.dias[0].data.slice(0,4);
      res.json({ ok: true, dias: result.dias.length, atualizados, totais: result.totais, mes });
    } catch(e) {
      console.error('[faturamento/import-formas]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /caixa/:mes — busca lançamentos de caixa do mês ────────────────────
  r.get('/caixa/:mes', async (req, res) => {
    try {
      const mes = decodeURIComponent(req.params.mes);
      const { rows } = await pool.query(
        `SELECT * FROM faturamento_caixa WHERE mes_ref=$1 ORDER BY data ASC, criado_em ASC`,
        [mes]
      );
      const totais = { pagamento: 0, retirada: 0, deposito: 0, caixa_fisico: 0 };
      rows.forEach(r => { if (totais[r.tipo] !== undefined) totais[r.tipo] += parseFloat(r.valor); });
      res.json({ ok: true, data: rows, totais });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /caixa — adiciona lançamento de caixa ────────────────────────────
  r.post('/caixa', async (req, res) => {
    const { mes_ref, data, tipo, descricao, valor } = req.body;
    if (!mes_ref || !tipo || !valor) return res.status(400).json({ ok: false, erro: 'mes_ref, tipo e valor obrigatórios' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO faturamento_caixa (mes_ref, data, tipo, descricao, valor)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [mes_ref, data || null, tipo, descricao || null, parseFloat(valor)]
      );
      res.json({ ok: true, data: rows[0] });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /caixa/:id — remove lançamento de caixa ───────────────────────
  r.delete('/caixa/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM faturamento_caixa WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /reconciliacao/:mes — cruza Xmenu (listagem) vs Extrato (DRE) ─────
  r.get('/reconciliacao/:mes', async (req, res) => {
    try {
      const mes = decodeURIComponent(req.params.mes); // MM/YYYY

      // 1. Faturamento Xmenu por dia
      const { rows: diasXmenu } = await pool.query(`
        SELECT
          data_inicio::text AS data,
          fat_bruto,
          total_pessoas,
          ticket_medio,
          pagamentos
        FROM faturamento_periodos
        WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1 AND tipo_periodo = 'dia'
        ORDER BY data_inicio
      `, [mes]);

      // 2. Receitas do extrato DRE no mês (sessões salvas)
      const { rows: sessDRE } = await pool.query(`
        SELECT dados_json
        FROM dre_sessoes
        WHERE mes_ref = $1
        ORDER BY atualizado_em DESC LIMIT 1
      `, [mes]);

      let recebidoExtrato = 0;
      let recebidoPix = 0;
      let recebidoCartao = 0;
      let recebidoOutros = 0;
      const lancamentosReceita = [];

      if (sessDRE.length) {
        const txs = sessDRE[0].dados_json?.transactions || [];
        for (const t of txs) {
          if (t.ignorar) continue;
          if (t.categoria !== 'VENDAS DE MERCADORIAS') continue;
          const v = parseFloat(t.valor || 0);
          if (v <= 0) continue;
          recebidoExtrato += v;
          const lanc = (t.lancamento || '').toUpperCase();
          if (/PIX|TED|DOC/.test(lanc)) recebidoPix += v;
          else if (/REDE|VISA|MAST|ELO|AMEX|HIPER|TICKET|ALELO|VR |SWILE|PLUXEE/.test(lanc)) recebidoCartao += v;
          else recebidoOutros += v;
          lancamentosReceita.push({ data: t.data, lancamento: t.lancamento, valor: v, fonte: t.fonte });
        }
      }

      const totalXmenu = diasXmenu.reduce((s, d) => s + parseFloat(d.fat_bruto || 0), 0);
      const totalPessoas = diasXmenu.reduce((s, d) => s + parseInt(d.total_pessoas || 0), 0);
      const diferenca = recebidoExtrato - totalXmenu; // negativo = ainda a receber
      const taxaEfetiva = totalXmenu > 0 ? ((totalXmenu - recebidoExtrato) / totalXmenu * 100) : 0;

      // 3. Formas de pagamento (dos dias importados)
      const { rows: diasFormas } = await pool.query(`
        SELECT
          pagamentos,
          COALESCE((pagamentos->>'dinheiro')::numeric, 0) AS dinheiro,
          COALESCE((pagamentos->>'pix_conta')::numeric, 0) AS pix_conta,
          COALESCE((pagamentos->>'pix_pag')::numeric, 0) AS pix_pag,
          COALESCE((pagamentos->>'pagseguro')::numeric, 0) AS pagseguro,
          COALESCE((pagamentos->>'rede_credito')::numeric, 0) AS rede_credito,
          COALESCE((pagamentos->>'rede_debito')::numeric, 0) AS rede_debito,
          COALESCE((pagamentos->>'voucher')::numeric, 0) AS voucher
        FROM faturamento_periodos
        WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1 AND tipo_periodo = 'dia'
      `, [mes]);

      const somaFormas = {
        dinheiro: 0, pix_conta: 0, pix_pag: 0, pagseguro: 0,
        rede_credito: 0, rede_debito: 0, voucher: 0
      };
      diasFormas.forEach(r => {
        Object.keys(somaFormas).forEach(k => { somaFormas[k] += parseFloat(r[k] || 0); });
      });
      const temFormas = Object.values(somaFormas).some(v => v > 0);

      // 4. Lançamentos de caixa registrados
      const { rows: caixaRows } = await pool.query(
        `SELECT tipo, SUM(valor) AS total FROM faturamento_caixa
         WHERE mes_ref=$1 GROUP BY tipo`, [mes]
      );
      const caixa = { pagamento: 0, retirada: 0, deposito: 0, caixa_fisico: 0 };
      caixaRows.forEach(r => { if (caixa[r.tipo] !== undefined) caixa[r.tipo] = parseFloat(r.total); });
      const totalExplicado = caixa.pagamento + caixa.retirada + caixa.deposito + caixa.caixa_fisico;

      res.json({
        ok: true,
        mes,
        caixa,
        total_explicado: Math.round(totalExplicado * 100) / 100,
        xmenu: {
          total: Math.round(totalXmenu * 100) / 100,
          dias: diasXmenu.length,
          pessoas: totalPessoas,
          ticket_medio: totalPessoas > 0 ? Math.round(totalXmenu / totalPessoas * 100) / 100 : 0,
          por_dia: diasXmenu,
        },
        extrato: {
          total: Math.round(recebidoExtrato * 100) / 100,
          pix: Math.round(recebidoPix * 100) / 100,
          cartao: Math.round(recebidoCartao * 100) / 100,
          outros: Math.round(recebidoOutros * 100) / 100,
          lancamentos: lancamentosReceita.length,
        },
        formas: temFormas ? {
          dinheiro:     Math.round(somaFormas.dinheiro * 100) / 100,
          pix_conta:    Math.round(somaFormas.pix_conta * 100) / 100,
          pix_pag:      Math.round(somaFormas.pix_pag * 100) / 100,
          pagseguro:    Math.round(somaFormas.pagseguro * 100) / 100,
          rede_credito: Math.round(somaFormas.rede_credito * 100) / 100,
          rede_debito:  Math.round(somaFormas.rede_debito * 100) / 100,
          voucher:      Math.round(somaFormas.voucher * 100) / 100,
        } : null,
        tem_formas: temFormas,
        diferenca: Math.round(diferenca * 100) / 100,
        taxa_efetiva_pct: Math.round(taxaEfetiva * 100) / 100,
        tem_dre: sessDRE.length > 0,
      });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /limpar — apaga todos os registros de faturamento ───────────────
  r.delete('/limpar', async (req, res) => {
    try {
      const { rows } = await pool.query(`DELETE FROM faturamento_periodos RETURNING id`);
      res.json({ ok: true, removidos: rows.length });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /limpar/:mes — apaga registros de um mês específico ──────────
  r.delete('/limpar/:mes', async (req, res) => {
    try {
      const mes = decodeURIComponent(req.params.mes); // MM/YYYY
      const { rows } = await pool.query(`
        DELETE FROM faturamento_periodos
        WHERE TO_CHAR(data_inicio,'MM/YYYY') = $1
        RETURNING id
      `, [mes]);
      res.json({ ok: true, removidos: rows.length, mes });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
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
