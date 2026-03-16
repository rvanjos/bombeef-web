/**
 * routes/boletos.js — Boletos & NF-e
 *
 * Lida com tabela "boletos" que pode ter vindo do sistema anterior com colunas
 * com nomes diferentes. O initTable usa ALTER TABLE ADD COLUMN IF NOT EXISTS
 * para todas as colunas necessárias.
 *
 * Campos importantes:
 *   mes_competencia  — mês da NF (para DRE)
 *   mes_caixa        — mês do pagamento (para fluxo de caixa)
 *   vinculado_extrato — true quando boleto foi cruzado com lançamento OFX
 */

const express    = require('express');
const multer     = require('multer');
const autenticar = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    // 1. Cria se não existir (sem NOT NULL para compatibilidade)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS boletos (
        id          SERIAL PRIMARY KEY,
        fornecedor  TEXT,
        valor       NUMERIC(14,2) DEFAULT 0,
        status      TEXT DEFAULT 'avencer',
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // 2. Adiciona TODAS as colunas que possam faltar
    const colunas = [
      ['frontend_id',        'INTEGER'],
      ['fornecedor',         'TEXT'],
      ['produto',            'TEXT'],
      ['dt_nota',            'TEXT'],
      ['nf',                 'TEXT'],
      ['chave_nfe',          'TEXT'],
      ['parcela',            "TEXT DEFAULT '1'"],
      ['total_parcelas',     'INTEGER DEFAULT 1'],
      ['plano',              'TEXT'],
      ['vencimento',         'DATE'],
      ['valor',              'NUMERIC(14,2) DEFAULT 0'],
      ['status',             "TEXT DEFAULT 'avencer'"],
      ['dt_pagamento',       'DATE'],
      ['observacao',         'TEXT'],
      ['origem',             "TEXT DEFAULT 'manual'"],
      ['codigo_barras',      'TEXT'],
      ['nf_id',              'INTEGER'],
      ['usuario_id',         'INTEGER'],
      ['mes_competencia',    'TEXT'],
      ['mes_caixa',          'TEXT'],
      ['vinculado_extrato',  'BOOLEAN DEFAULT false'],
      ['extrato_lancamento', 'TEXT'],
      ['atualizado_em',      'TIMESTAMPTZ DEFAULT NOW()'],
    ];

    for (const [col, def] of colunas) {
      await pool.query(
        `ALTER TABLE boletos ADD COLUMN IF NOT EXISTS ${col} ${def}`
      ).catch(() => {});
    }

    // 3. Remove constraints antigas que podem conflitar
    await pool.query(`ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_status_check`).catch(() => {});
    await pool.query(`ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_origem_check`).catch(() => {});

    // 4. Corrige valores inválidos
    await pool.query(`
      UPDATE boletos SET status = 'avencer'
      WHERE status NOT IN ('avencer','pago','vencido','cancelado')
        AND status IS NOT NULL
    `).catch(() => {});

    // 5. Popula mes_competencia/mes_caixa nos registros existentes
    await pool.query(`
      UPDATE boletos
      SET mes_competencia = TO_CHAR(
        COALESCE(NULLIF(dt_nota,'')::date, vencimento),
        'MM/YYYY'
      )
      WHERE mes_competencia IS NULL
        AND (dt_nota IS NOT NULL OR vencimento IS NOT NULL)
    `).catch(() => {});

    await pool.query(`
      UPDATE boletos
      SET mes_caixa = TO_CHAR(
        COALESCE(dt_pagamento, vencimento),
        'MM/YYYY'
      )
      WHERE mes_caixa IS NULL
        AND (dt_pagamento IS NOT NULL OR vencimento IS NOT NULL)
    `).catch(() => {});

    // 6. Índices
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_boletos_vencimento  ON boletos(vencimento);
      CREATE INDEX IF NOT EXISTS idx_boletos_status      ON boletos(status);
      CREATE INDEX IF NOT EXISTS idx_boletos_mes_comp    ON boletos(mes_competencia);
      CREATE INDEX IF NOT EXISTS idx_boletos_mes_caixa   ON boletos(mes_caixa);
    `).catch(() => {});
  }
  initTable().catch(e => console.error('[boletos] initTable:', e.message));

  // ── Helpers ────────────────────────────────────────────────────────────────
  const fmtDate = v => v ? String(v).slice(0, 10) : '';

  function rowToFrontend(b) {
    const dtNota = fmtDate(b.dt_nota);
    const venc   = fmtDate(b.vencimento);
    const dtPag  = fmtDate(b.dt_pagamento);
    // Deriva mes_competencia e mes_caixa se não existirem
    const mesComp = b.mes_competencia || (dtNota ? dtNota.slice(5,7)+'/'+dtNota.slice(0,4)
                    : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : '');
    const mesCaixa= b.mes_caixa || (dtPag ? dtPag.slice(5,7)+'/'+dtPag.slice(0,4)
                    : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : '');
    return {
      id:               b.frontend_id ?? b.id,
      dbId:             b.id,
      fornecedor:       b.fornecedor || '',
      produto:          b.produto || '',
      dtNota,
      nf:               b.nf || '',
      chaveNfe:         b.chave_nfe || '',
      parcela:          b.parcela || '1',
      totalParcelas:    parseInt(b.total_parcelas || 1),
      plano:            b.plano || '',
      vencimento:       venc,
      valor:            parseFloat(b.valor) || 0,
      status:           b.status || 'avencer',
      dtPagamento:      dtPag,
      obs:              b.observacao || '',
      origem:           b.origem || 'manual',
      codigoBarras:     b.codigo_barras || '',
      mesCompetencia:   mesComp,
      mesCaixa,
      vinculadoExtrato: b.vinculado_extrato || false,
      extratLancamento: b.extrato_lancamento || '',
    };
  }

  const PLANO_TO_DRE = {
    'Fornec - Proteínas':           'COMPRAS - REVENDA',
    'Fornec - Acompanhamentos':     'COMPRAS - REVENDA',
    'Fornec - Bebidas/Gelo/Sorvete':'COMPRAS - REVENDA',
    'Fornec - Empório (outros)':    'COMPRAS - REVENDA',
    'Fornec - Empório (carvão)':    'COMPRAS - REVENDA',
    'Fornec - Embalagens':          'Material de Embalagens',
    'Fornec - Acessórios':          'Materiais diversos',
    'Fornec - Outras Desp':         'Serviços prestados por terceiros',
  };

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COALESCE(COUNT(*) FILTER (WHERE status='avencer'),0) AS avencer,
          COALESCE(COUNT(*) FILTER (WHERE status='vencido'
            OR (status='avencer' AND vencimento IS NOT NULL AND vencimento < CURRENT_DATE)),0) AS vencidos,
          COALESCE(COUNT(*) FILTER (WHERE status='avencer' AND vencimento IS NOT NULL
            AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7),0) AS vence_7dias,
          COALESCE(SUM(valor) FILTER (WHERE status!='pago' AND status!='cancelado'),0) AS total_aberto,
          COALESCE(SUM(valor) FILTER (WHERE status='pago'
            AND dt_pagamento >= DATE_TRUNC('month',NOW())),0) AS pago_mes,
          COALESCE(SUM(valor) FILTER (WHERE status='avencer' AND vencimento IS NOT NULL
            AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE+7),0) AS valor_vence_7dias
        FROM boletos WHERE status!='cancelado'
      `);
      res.json({
        ok: true, data: {
          avencer:      parseInt(rows[0].avencer),
          vencidos:     parseInt(rows[0].vencidos),
          vence7dias:   parseInt(rows[0].vence_7dias),
          totalAberto:  parseFloat(rows[0].total_aberto),
          pagoMes:      parseFloat(rows[0].pago_mes),
          valorVence7d: parseFloat(rows[0].valor_vence_7dias),
        }
      });
    } catch (e) {
      console.error('[boletos/kpis]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /classificador — retorna boletos para o DRE ────────────────────────
  r.get('/classificador', async (req, res) => {
    try {
      const { mes } = req.query;
      let where = "WHERE status != 'cancelado'";
      const params = [];
      if (mes) {
        params.push(mes);
        where += ` AND COALESCE(mes_caixa, TO_CHAR(COALESCE(dt_pagamento,vencimento),'MM/YYYY')) = $1`;
      }
      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST`, params
      );
      const lancamentos = rows.map(b => {
        const v = rowToFrontend(b);
        return {
          id:         'boleto_'+b.id,
          lancamento: `${v.fornecedor}${v.produto?' — '+v.produto:''} (NF ${v.nf||'s/n'})`,
          valor:      -Math.abs(v.valor),
          data:       v.dtPagamento || v.vencimento,
          mes:        v.mesCompetencia,
          mesCaixa:   v.mesCaixa,
          fonte:      v.status === 'pago' ? 'BOLETO' : 'BOLETO_PREV',
          categoria:  PLANO_TO_DRE[v.plano] || 'COMPRAS - REVENDA',
          vinculado:  v.vinculadoExtrato,
        };
      });
      res.json({ ok: true, data: lancamentos });
    } catch (e) {
      console.error('[boletos/classificador]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { status, mes, vencimento_mes } = req.query;
      const conds = [], params = [];

      if (status === 'avencer') {
        conds.push(`(status = 'avencer' AND (vencimento IS NULL OR vencimento >= CURRENT_DATE))`);
      } else if (status === 'vencido') {
        conds.push(`(status = 'vencido' OR (status='avencer' AND vencimento IS NOT NULL AND vencimento < CURRENT_DATE))`);
      } else if (status) {
        params.push(status); conds.push(`status = $${params.length}`);
      }

      if (mes) {
        // Filtra pelo mês do vencimento
        const [mm, yyyy] = mes.split('/');
        if (mm && yyyy) {
          params.push(parseInt(mm), parseInt(yyyy));
          conds.push(`(vencimento IS NULL OR (EXTRACT(MONTH FROM vencimento)=$${params.length-1} AND EXTRACT(YEAR FROM vencimento)=$${params.length}))`);
        }
      }

      conds.push(`status != 'cancelado'`);
      const where = 'WHERE ' + conds.join(' AND ');

      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST, id DESC`, params
      );
      res.json({ ok: true, data: rows.map(rowToFrontend), total: rows.length });
    } catch (e) {
      console.error('[boletos/GET]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /:id ───────────────────────────────────────────────────────────────
  r.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM boletos WHERE id=$1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
      res.json({ ok: true, data: rowToFrontend(rows[0]) });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / — cria boleto manual ────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const b = req.body;
    if (!b.fornecedor && !b.produto) return res.status(400).json({ ok: false, erro: 'fornecedor ou produto obrigatório' });

    const venc = b.vencimento || null;
    const dtNota = b.dtNota || b.dt_nota || null;
    const dtPag  = b.dtPagamento || b.dt_pagamento || null;

    const mesComp  = b.mesCompetencia || (dtNota ? dtNota.slice(5,7)+'/'+dtNota.slice(0,4)
                     : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null);
    const mesCaixa = b.mesCaixa || (dtPag ? dtPag.slice(5,7)+'/'+dtPag.slice(0,4)
                     : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null);

    try {
      const { rows } = await pool.query(`
        INSERT INTO boletos
          (fornecedor,produto,dt_nota,nf,chave_nfe,parcela,total_parcelas,plano,
           vencimento,valor,status,dt_pagamento,observacao,origem,codigo_barras,
           mes_competencia,mes_caixa,usuario_id,atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        RETURNING id
      `, [
        b.fornecedor||null, b.produto||null, dtNota, b.nf||null, b.chaveNfe||b.chave_nfe||null,
        b.parcela||'1', parseInt(b.totalParcelas||1), b.plano||null,
        venc, parseFloat(b.valor)||0,
        b.status||'avencer', dtPag,
        b.obs||b.observacao||null, b.origem||'manual', b.codigoBarras||null,
        mesComp, mesCaixa, req.user.id,
      ]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      console.error('[boletos/POST]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── PUT /:id — atualiza boleto ─────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const b = req.body;
    const dtPag  = b.dtPagamento || b.dt_pagamento || null;
    const dtNota = b.dtNota || b.dt_nota || null;
    const venc   = b.vencimento || null;
    const mesComp  = b.mesCompetencia || (dtNota ? dtNota.slice(5,7)+'/'+dtNota.slice(0,4)
                     : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null);
    const mesCaixa = b.mesCaixa || (dtPag ? dtPag.slice(5,7)+'/'+dtPag.slice(0,4)
                     : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null);
    try {
      const { rowCount } = await pool.query(`
        UPDATE boletos SET
          fornecedor       = COALESCE($1, fornecedor),
          produto          = COALESCE($2, produto),
          dt_nota          = COALESCE($3, dt_nota),
          nf               = COALESCE($4, nf),
          parcela          = COALESCE($5, parcela),
          total_parcelas   = COALESCE($6, total_parcelas),
          plano            = COALESCE($7, plano),
          vencimento       = COALESCE($8::date, vencimento),
          valor            = COALESCE($9, valor),
          status           = COALESCE($10, status),
          dt_pagamento     = COALESCE($11::date, dt_pagamento),
          observacao       = COALESCE($12, observacao),
          codigo_barras    = COALESCE($13, codigo_barras),
          mes_competencia  = COALESCE($14, mes_competencia),
          mes_caixa        = COALESCE($15, mes_caixa),
          atualizado_em    = NOW()
        WHERE id = $16
      `, [
        b.fornecedor||null, b.produto||null, dtNota, b.nf||null,
        b.parcela||null, b.totalParcelas?parseInt(b.totalParcelas):null,
        b.plano||null, venc||null,
        b.valor !== undefined ? parseFloat(b.valor) : null,
        b.status||null, dtPag||null,
        b.obs !== undefined ? (b.obs||null) : null,
        b.codigoBarras||null, mesComp||null, mesCaixa||null,
        req.params.id,
      ]);
      if (!rowCount) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[boletos/PUT]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE boletos SET status='cancelado', atualizado_em=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /baixa/:id — registra pagamento ──────────────────────────────────
  r.post('/baixa/:id', async (req, res) => {
    const { dtPagamento, valor } = req.body;
    try {
      const dtPag = dtPagamento || new Date().toISOString().slice(0,10);
      const mc = dtPag.slice(5,7)+'/'+dtPag.slice(0,4);
      await pool.query(`
        UPDATE boletos SET
          status='pago',
          dt_pagamento = $1,
          mes_caixa    = $2,
          valor        = COALESCE($3, valor),
          atualizado_em= NOW()
        WHERE id=$4
      `, [dtPag, mc, valor ? parseFloat(valor) : null, req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[boletos/baixa]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /vincular-extrato/:id — vincula boleto com lançamento OFX ────────
  // Evita duplicação no DRE: quando o extrato tiver o mesmo pagamento
  r.post('/vincular-extrato/:id', async (req, res) => {
    const { lancamento, data, valor } = req.body;
    try {
      await pool.query(`
        UPDATE boletos SET
          vinculado_extrato   = true,
          extrato_lancamento  = $1,
          dt_pagamento        = COALESCE(dt_pagamento, $2::date),
          status              = 'pago',
          mes_caixa           = TO_CHAR($2::date, 'MM/YYYY'),
          atualizado_em       = NOW()
        WHERE id = $3
      `, [lancamento, data, req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[boletos/vincular]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /import-xml — preview da NF-e XML ────────────────────────────────
  r.post('/import-xml', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    try {
      const xml = req.file.buffer.toString('utf8');

      // Parser manual de NF-e (sem biblioteca externa)
      const getTag = (tag, src = xml) => {
        const ns = ['http://www.portalfiscal.inf.br/nfe'];
        for (const n of [...ns, '']) {
          const t = n ? `{${n}}${tag}` : tag;
          const re = new RegExp(`<(?:[\\w:]*:)?${tag}[^>]*>([^<]*)<`, 'i');
          const m = re.exec(src);
          if (m) return m[1].trim();
        }
        return '';
      };

      const emitente   = getTag('xNome');
      const nNF        = getTag('nNF');
      const dhEmi      = getTag('dhEmi');
      const chaveNfe   = (() => { const m = /NFe(\d{44})/.exec(xml)||/chNFe[^>]*>(\d{44})/.exec(xml); return m?m[1]:''; })();
      const vNF        = parseFloat(getTag('vNF') || getTag('vTotTrib') || '0');
      const dtNota     = dhEmi ? dhEmi.slice(0, 10) : '';
      const mesComp    = dtNota ? dtNota.slice(5,7)+'/'+dtNota.slice(0,4) : '';

      // Parcelas (cobr/dup)
      const dupBlocks = [...xml.matchAll(/<dup>([\s\S]*?)<\/dup>/gi)];
      let parcelas = [];

      if (dupBlocks.length > 0) {
        for (const [, block] of dupBlocks) {
          const nDup  = getTag('nDup', block);
          const dVenc = getTag('dVenc', block);
          const vDup  = parseFloat(getTag('vDup', block) || '0');
          if (vDup > 0) {
            const mesC = dVenc ? dVenc.slice(5,7)+'/'+dVenc.slice(0,4) : mesComp;
            parcelas.push({
              fornecedor:      emitente,
              produto:         '',
              dtNota,
              nf:              nNF,
              chaveNfe,
              parcela:         nDup || '1',
              totalParcelas:   dupBlocks.length,
              vencimento:      dVenc || dtNota,
              valor:           vDup,
              mesCompetencia:  mesComp,
              mesCaixa:        mesC,
              status:          'avencer',
              origem:          'nfe',
            });
          }
        }
      } else {
        // Sem parcelas — uma única
        parcelas = [{
          fornecedor:     emitente,
          produto:        '',
          dtNota,
          nf:             nNF,
          chaveNfe,
          parcela:        '1',
          totalParcelas:  1,
          vencimento:     dtNota,
          valor:          vNF,
          mesCompetencia: mesComp,
          mesCaixa:       mesComp,
          status:         'avencer',
          origem:         'nfe',
        }];
      }

      if (!emitente && !nNF) {
        return res.status(422).json({ ok: false, erro: 'Arquivo XML inválido ou sem dados de NF-e' });
      }

      res.json({
        ok: true,
        preview: {
          emitente,
          nNF,
          dtNota,
          chaveNfe,
          total: vNF,
          parcelas: parcelas.length,
        },
        boletos: parcelas,
      });
    } catch (e) {
      console.error('[boletos/import-xml]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /import-xml/confirmar — salva as parcelas do preview ─────────────
  r.post('/import-xml/confirmar', async (req, res) => {
    const { boletos = [] } = req.body;
    if (!boletos.length) return res.status(400).json({ ok: false, erro: 'Nenhum boleto para salvar' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = [];
      for (const b of boletos) {
        const venc   = b.vencimento || null;
        const dtNota = b.dtNota || b.dt_nota || null;
        const mesComp  = b.mesCompetencia || (dtNota ? dtNota.slice(5,7)+'/'+dtNota.slice(0,4)
                         : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null);
        const mesCaixa = b.mesCaixa || mesComp;

        // Evita duplicar NF-e já importada
        if (b.chaveNfe || b.chave_nfe) {
          const chave = b.chaveNfe || b.chave_nfe;
          const parc  = b.parcela || '1';
          const { rows: dup } = await client.query(
            `SELECT id FROM boletos WHERE chave_nfe=$1 AND parcela=$2 LIMIT 1`,
            [chave, parc]
          );
          if (dup.length) { ids.push(dup[0].id); continue; }
        }

        const { rows } = await client.query(`
          INSERT INTO boletos
            (fornecedor,produto,dt_nota,nf,chave_nfe,parcela,total_parcelas,plano,
             vencimento,valor,status,origem,mes_competencia,mes_caixa,usuario_id,atualizado_em)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'avencer','nfe',$11,$12,$13,NOW())
          RETURNING id
        `, [
          b.fornecedor||null, b.produto||null, dtNota, b.nf||null,
          b.chaveNfe||b.chave_nfe||null,
          b.parcela||'1', parseInt(b.totalParcelas||1),
          b.plano||null, venc||null, parseFloat(b.valor)||0,
          mesComp, mesCaixa, req.user.id,
        ]);
        ids.push(rows[0].id);
      }
      await client.query('COMMIT');

      // Notifica para atualizar dashboard
      res.json({ ok: true, ids, count: ids.length });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[boletos/confirmar]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── POST /import-csv — importa planilha de boletos (Controle Boletos) ─────
  r.post('/import-csv', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });

    try {
      const XLSX = require('xlsx');
      const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Encontra linha de cabeçalho
      let hIdx = 0;
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const l = rows[i].join(' ').toUpperCase();
        if (l.includes('FORNECEDOR') || l.includes('VENCIMENTO') || l.includes('VALOR')) {
          hIdx = i; break;
        }
      }

      const header = rows[hIdx].map(c => String(c).toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
      const ic = nomes => { for (const n of nomes) { const i=header.findIndex(h=>h.includes(n)); if(i>=0)return i; } return -1; };

      const cForn  = ic(['fornecedor','emitente']);
      const cProd  = ic(['produto','descricao','item']);
      const cDtNot = ic(['data nota','dt nota','data_nota','nota']);
      const cNF    = ic(['numero nota','numero_nota','nf','n nota']);
      const cParc  = ic(['parcela']);
      const cPlano = ic(['plano','categoria','plano de contas']);
      const cVenc  = ic(['vencimento','dt venc','data venc']);
      const cDtPag = ic(['pagamento','dt pag','data pag']);
      const cVal   = ic(['valor','total','r$']);

      const parseData = v => {
        if (!v) return null;
        if (v instanceof Date) return v.toISOString().slice(0,10);
        const s = String(v).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.split('/').reverse().join('-');
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
        return null;
      };

      const parseVal = v => {
        if (typeof v === 'number') return v;
        return parseFloat(String(v).replace(/[^\d.,]/g,'').replace(',','.')) || 0;
      };

      const client = await pool.connect();
      let inseridos=0, erros=0;
      try {
        await client.query('BEGIN');
        for (let i = hIdx+1; i < rows.length; i++) {
          const row = rows[i];
          const forn = cForn>=0?String(row[cForn]||'').trim():'';
          const val  = cVal>=0?parseVal(row[cVal]):0;
          if (!forn && !val) continue;

          const dtNota = parseData(cDtNot>=0?row[cDtNot]:null);
          const venc   = parseData(cVenc>=0?row[cVenc]:null);
          const dtPag  = parseData(cDtPag>=0?row[cDtPag]:null);
          const mesComp  = dtNota ? dtNota.slice(5,7)+'/'+dtNota.slice(0,4)
                           : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null;
          const mesCaixa = dtPag ? dtPag.slice(5,7)+'/'+dtPag.slice(0,4)
                           : venc ? venc.slice(5,7)+'/'+venc.slice(0,4) : null;
          const st = dtPag ? 'pago' : 'avencer';

          try {
            await client.query(`
              INSERT INTO boletos
                (fornecedor,produto,dt_nota,nf,parcela,plano,vencimento,valor,
                 status,dt_pagamento,origem,mes_competencia,mes_caixa,usuario_id,atualizado_em)
              VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10::date,'csv',$11,$12,$13,NOW())
            `, [
              forn||null,
              cProd>=0?String(row[cProd]||'').trim()||null:null,
              dtNota, cNF>=0?String(row[cNF]||'').trim()||null:null,
              cParc>=0?String(row[cParc]||'1').trim():'1',
              cPlano>=0?String(row[cPlano]||'').trim()||null:null,
              venc||null, val, st, dtPag||null, mesComp, mesCaixa, req.user.id,
            ]);
            inseridos++;
          } catch (e) { erros++; }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK'); throw e;
      } finally { client.release(); }

      res.json({ ok: true, inseridos, erros });
    } catch (e) {
      console.error('[boletos/import-csv]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /import-pdf — PDF OCR simplificado ────────────────────────────────
  r.post('/import-pdf', upload.single('arquivo'), async (req, res) => {
    // Por ora retorna orientação ao usuário
    res.json({
      ok: false,
      erro: 'Importação de PDF de boleto não disponível. Use a planilha CSV ou importe o XML da NF-e.',
    });
  });

  return r;
};
