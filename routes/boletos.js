/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
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

module.exports = function (pool, app) {
  const publish = (canal, dados) => {
    try { app?.locals?.ssePublish?.(canal, dados); } catch(_) {}
  };
  // Middleware: publica evento SSE automaticamente após mutações bem-sucedidas
  const autoPublish = (canal, tipo) => (req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (body) => {
      if (body?.ok !== false && ['POST','PUT','DELETE','PATCH'].includes(req.method)) {
        publish(canal, { type: tipo });
      }
      return orig(body);
    };
    next();
  };
  const r = express.Router();
  r.use(autenticar());

  // Perfil contabil: somente leitura — bloqueia qualquer escrita
  r.use((req, res, next) => {
    if (req.user?.perfil === 'contabil' && req.method !== 'GET') {
      return res.status(403).json({ ok: false, erro: 'Perfil contábil tem acesso somente leitura' });
    }
    next();
  });

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
      ['cartao_credito',     'TEXT'],   // ex: 'Itaú Visa', 'Nubank', 'BB Mastercard'
      ['dt_programado',      'DATE'],   // data em que o pagamento foi programado no banco
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
  // Sugere categoria DRE pelo nome do fornecedor — retorna diretamente a categoria DRE
  function guessPlano(nome) {
    const n = (nome||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (/CARVAO|BRASA/.test(n))                                              return 'Carvão';
    if (/EMBALA|SACOLA|ETIQUETA|ADESIVO|GRAFICA|ALPACK|LABELBEER|SR GRAV/.test(n)) return 'Material de Embalagens';
    if (/SPAL|COCA.COLA|AMBEV|BEBIDA|CERVEJA|GELATO|SORVETE|FRONERI|GELO|MISTER GELO/.test(n)) return 'Bebidas';
    if (/QUEIJO|CAMBUIENSE|CAMPO VERDE|MIOTTO|PRONI|GUIDARA|BRASEIRO|CICERO|NOVA MIX|LATICINIO|SABOR MOR|QBRAZA/.test(n)) return 'Acompanhamentos';
    if (/MDK FRANCHISING|ROYALTIES|FRANQUIA/.test(n))                        return 'Royalties';
    if (/CONTAB|M M M SERV/.test(n))                                         return 'Assistencia Contábil';
    if (/SEGURANCA|SECURITY|ASI CAMPINAS/.test(n))                           return 'Serviços com Segurança';
    if (/DEDETIZ|MANUTENCAO|HIGIENE|LIMPEZA|PORTO SEGURO/.test(n))           return 'Serviços de Manutenção e Higiene';
    if (/SOFTWARE|INTERNET|TRADEMASTER|V4 COMPANY/.test(n))                  return 'Serviços com Internet/Software';
    if (/ALUGUEL|CREDCAMP/.test(n))                                          return 'Alugueis de imoveis';
    if (/CPFL|ENERGIA|ELETRICA/.test(n))                                     return 'Energia eletrica';
    if (/AGUA|ESGOTO|SABESP|SANASA|DAE /.test(n))                            return 'Agua e esgoto';
    if (/VIVO|CLARO|TIM|OI |TELEFONE|TELEFONICA/.test(n))                    return 'Telefone';
    if (/FRIGO|FRIGOL|MINERVA|AURORA|CARNES|BOVINO|SUINO|AVES|FRANGO|AGROPECUARIA|INTERLAGOS|CABANHA|WEW|ALSSABAK|HUMAITA|SPECIALLI|FABENE|CANTAGALLO|BARRA MANSA|COMERCIAL TUDO/.test(n)) return 'COMPRAS - REVENDA';
    return 'COMPRAS - REVENDA'; // default para NF-e de fornecedores
  }

  const fmtDate = v => {
    if (!v) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  };

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
      cartaoCredito:    b.cartao_credito || '',
    };
  }

  // Mapeamento Plano de Contas → Categoria DRE (alinhado com dre.html CATS)
  // Mapeia plano de contas (campo plano do boleto) → categoria DRE
  // Aceita tanto os nomes antigos ("Fornec - Proteínas") quanto categorias DRE diretas
  const PLANO_TO_DRE = {
    // Nomes antigos → DRE
    'Fornec - Proteínas':            'COMPRAS - REVENDA',
    'Fornec - Acompanhamentos':      'COMPRAS - REVENDA',
    'Fornec - Bebidas/Gelo/Sorvete': 'COMPRAS - REVENDA',
    'Fornec - Bebidas':              'COMPRAS - REVENDA',
    'Fornec - Gelo/Sorvete':         'COMPRAS - REVENDA',
    'Fornec - Empório (outros)':     'COMPRAS - REVENDA',
    'Fornec - Empório (carvão)':     'COMPRAS - REVENDA',
    'Fornec - Embalagens':           'Material de Embalagens',
    'Fornec - Acessórios':           'Materiais diversos',
    'Fornec - EPI/Uniformes':        'EPI / Uniformes',
    'Fornec - Outras Desp':          'Serviços prestados por terceiros',
    'Fornec - Contabilidade':        'Assistencia Contábil',
    'Fornec - Segurança':            'Serviços com Segurança',
    'Fornec - Manutenção':           'Serviços de Manutenção e Higiene',
    'Fornec - Software/Internet':    'Serviços com Internet/Software',
    'Fornec - Aluguel':              'Alugueis de imoveis',
    'Fornec - Energia':              'Energia eletrica',
    'Fornec - Água':                 'Agua e esgoto',
    'Fornec - Telefone':             'Telefone',
    'Fornec - Royalties':            'Royalties',
    'Fornec - Frete':                'Fretes com vendas',
    'Fornec - Impostos':             'Simples Nacional',
  };

  // Se o plano já é uma categoria DRE direta, usa direto; senão tenta mapear
  function resolveCategoria(plano) {
    if (!plano) return 'COMPRAS - REVENDA';
    if (PLANO_TO_DRE[plano]) return PLANO_TO_DRE[plano];
    // Se não está no mapa, assume que já é uma categoria DRE direta
    return plano;
  }

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
        // Usa mes_competencia (data da NF) para provisão DRE — é a data de competência
        where += ` AND COALESCE(mes_competencia, TO_CHAR(COALESCE(NULLIF(dt_nota,'')::date, vencimento), 'MM/YYYY')) = $1`;
      }
      const { rows } = await pool.query(
        `SELECT * FROM boletos ${where} ORDER BY vencimento ASC NULLS LAST`, params
      );
      const hoje = new Date(); hoje.setHours(0,0,0,0);
      const lancamentos = rows.map(b => {
        const v = rowToFrontend(b);
        const isPago   = v.status === 'pago';
        const vencDate = v.vencimento ? new Date(v.vencimento + 'T12:00:00') : null;
        // needsReview: boleto não pago, vencido, sem vinculação com extrato
        const needsReview = !isPago && vencDate && vencDate < hoje && !v.vinculadoExtrato;
        return {
          id:           'boleto_'+b.id,
          boletoId:     b.id,
          lancamento:   `${isPago?'BOLETO PAGO':'BOLETO PREV'} (NF ${v.nf||'s/n'}, Parc. ${v.parcela||'1'})`,
          razaoSocial:  v.fornecedor || '',
          valor:        -Math.abs(v.valor),
          data:         v.dtPagamento || v.vencimento,
          mes:          v.mesCompetencia,
          mesCaixa:     v.mesCaixa,
          fonte:        isPago ? 'BOLETO' : 'BOLETO_PREV',
          categoria:    resolveCategoria(v.plano),
          plano:        v.plano || '',
          vinculado:    v.vinculadoExtrato,
          needsReview,  // true = vencido sem baixa → sinalizar no DRE
          parcela:      v.parcela || '1',
          totalParcelas:v.totalParcelas || 1,
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
      const { status, mes, de, ate } = req.query;
      const conds = [], params = [];

      if (status === 'avencer') {
        conds.push(`(status = 'avencer' AND (vencimento IS NULL OR vencimento >= CURRENT_DATE))`);
      } else if (status === 'vencido') {
        conds.push(`(status = 'vencido' OR (status='avencer' AND vencimento IS NOT NULL AND vencimento < CURRENT_DATE))`);
      } else if (status && status !== 'todos') {
        params.push(status); conds.push(`status = $${params.length}`);
      }

      if (mes) {
        const [mm, yyyy] = mes.split('/');
        if (mm && yyyy) {
          params.push(parseInt(mm), parseInt(yyyy));
          conds.push(`(vencimento IS NULL OR (EXTRACT(MONTH FROM vencimento)=$${params.length-1} AND EXTRACT(YEAR FROM vencimento)=$${params.length}))`);
        }
      }

      if (de) {
        params.push(de);
        conds.push(`(vencimento IS NULL OR vencimento >= $${params.length}::date)`);
      }
      if (ate) {
        params.push(ate);
        conds.push(`(vencimento IS NULL OR vencimento <= $${params.length}::date)`);
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
  // ── POST /desvincular-extrato/:id — remove vínculo com lançamento OFX ─────
  r.post('/desvincular-extrato/:id', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
    try {
      await pool.query(`
        UPDATE boletos SET
          vinculado_extrato  = false,
          extrato_lancamento = NULL,
          status             = CASE
            WHEN vencimento < CURRENT_DATE THEN 'vencido'
            ELSE 'avencer'
          END,
          dt_pagamento       = NULL,
          mes_caixa          = mes_competencia,
          atualizado_em      = NOW()
        WHERE id = $1
      `, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM boletos WHERE id=$1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
      res.json({ ok: true, data: rowToFrontend(rows[0]) });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / — cria boleto manual ────────────────────────────────────────────
  r.post('/', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
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
           mes_competencia,mes_caixa,usuario_id,cartao_credito,atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
        RETURNING id
      `, [
        b.fornecedor||null, b.produto||null, dtNota, b.nf||null, b.chaveNfe||b.chave_nfe||null,
        b.parcela||'1', parseInt(b.totalParcelas||1), b.plano||null,
        venc, parseFloat(b.valor)||0,
        b.status||'avencer', dtPag,
        b.obs||b.observacao||null, b.origem||'manual', b.codigoBarras||null,
        mesComp, mesCaixa, req.user.id, b.cartaoCredito||null,
      ]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      console.error('[boletos/POST]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── PUT /:id — atualiza boleto ─────────────────────────────────────────────
  r.put('/:id', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
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
          cartao_credito   = $16,
          dt_programado    = $17,
          atualizado_em    = NOW()
        WHERE id = $18
      `, [
        b.fornecedor||null, b.produto||null, dtNota, b.nf||null,
        b.parcela||null, b.totalParcelas?parseInt(b.totalParcelas):null,
        b.plano||null, venc||null,
        b.valor !== undefined ? parseFloat(b.valor) : null,
        b.status||null, dtPag||null,
        b.obs !== undefined ? (b.obs||null) : null,
        b.codigoBarras||null, mesComp||null, mesCaixa||null,
        b.cartaoCredito||null,
        b.dtProgramado !== undefined ? (b.dtProgramado||null) : null,
        req.params.id,
      ]);
      if (!rowCount) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[boletos/PUT]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── PATCH /:id/programar — marcar/desmarcar programação de pagamento ────────
  r.patch('/:id/programar', async (req, res) => {
    const { dtProgramado } = req.body; // null para desmarcar
    try {
      await pool.query(
        `UPDATE boletos SET dt_programado=$1, atualizado_em=NOW() WHERE id=$2`,
        [dtProgramado || null, req.params.id]
      );
      res.json({ ok: true, dt_programado: dtProgramado || null });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
    try {
      await pool.query(`UPDATE boletos SET status='cancelado', atualizado_em=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /baixa/:id — registra pagamento ──────────────────────────────────
  r.post('/baixa/:id', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
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
  r.post('/vincular-extrato/:id', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
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

      // ── Parcelas: tenta <cobr/dup>, depois detPag (prazo em dias), depois infCpl, depois parcela única ───────
      const dupBlocks = [...xml.matchAll(/<dup>([\s\S]*?)<\/dup>/gi)];
      let parcelas = [];

      // Helper: detecta condição de pagamento parcelada via <xCond> e <detPag><nDias>
      // Ex.: xCond = "Parcelado 21/28 dias" → calcula vencimentos a partir da dtNota
      const xCond = getTag('xCond');
      const detPagBlocks = [...xml.matchAll(/<detPag>([\s\S]*?)<\/detPag>/gi)];

      // Helper: parseia data no formato DD/MM/YYYY ou YYYY-MM-DD → YYYY-MM-DD
      const parseDateStr = s => {
        if (!s) return '';
        s = s.trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
          const [d,m,y] = s.split('/'); return `${y}-${m}-${d}`;
        }
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
        return '';
      };

      if (dupBlocks.length > 0) {
        // Fonte 1: tag <cobr><dup> — mais confiável
        for (const [, block] of dupBlocks) {
          const nDup  = getTag('nDup', block);
          const dVenc = getTag('dVenc', block);
          const vDup  = parseFloat(getTag('vDup', block) || '0');
          if (vDup > 0) {
            const mesC = dVenc ? dVenc.slice(5,7)+'/'+dVenc.slice(0,4) : mesComp;
            parcelas.push({
              fornecedor:     emitente,
              produto:        '',
              dtNota,
              nf:             nNF,
              chaveNfe,
              parcela:        nDup || String(parcelas.length + 1),
              totalParcelas:  dupBlocks.length,
              vencimento:     dVenc || dtNota,
              valor:          vDup,
              mesCompetencia: mesComp,
              mesCaixa:       mesC,
              status:         'avencer',
              origem:         'nfe',
            });
          }
        }
      }

      // Fonte 1b: detPag com nDias — "Parcelado 21/28 dias" ou similar
      // Usado quando <cobr/dup> está ausente mas <detPag> contém prazos em dias
      if (parcelas.length === 0 && detPagBlocks.length > 0 && dtNota) {
        const baseDate = new Date(dtNota + 'T12:00:00');
        const fromDetPag = [];
        for (const [, block] of detPagBlocks) {
          const tPag  = getTag('tPag', block);   // ex: "15" = boleto
          const vPag  = parseFloat(getTag('vPag', block) || '0');
          const nDias = parseInt(getTag('nDias', block) || '0', 10);
          if (vPag > 0 && nDias > 0) {
            const vencDate = new Date(baseDate);
            vencDate.setDate(vencDate.getDate() + nDias);
            const vencISO = vencDate.toISOString().slice(0, 10);
            fromDetPag.push({ vencISO, vPag, nDias });
          }
        }
        // Validação extra: se xCond indica parcelamento (ex.: "Parcelado") confiar mais
        const isParcelado = /parc|prazo/i.test(xCond);
        if (fromDetPag.length > 0 && (isParcelado || fromDetPag.length > 1)) {
          fromDetPag.forEach((p, i) => {
            const mesC = p.vencISO.slice(5,7)+'/'+p.vencISO.slice(0,4);
            parcelas.push({
              fornecedor:     emitente,
              produto:        '',
              dtNota,
              nf:             nNF,
              chaveNfe,
              parcela:        String(i+1)+'/'+fromDetPag.length,
              totalParcelas:  fromDetPag.length,
              vencimento:     p.vencISO,
              valor:          p.vPag,
              mesCompetencia: mesComp,
              mesCaixa:       mesC,
              status:         'avencer',
              origem:         'nfe',
              origemParcela:  'detPag',
            });
          });
        }
      }

      // Fonte 2: infCpl / infAdFisco — informações complementares
      // Padrões comuns: "VENCTO 20/03/2026 R$ 502,00" ou "PARC 1/2: 20/03/26 R$250,00"
      if (parcelas.length === 0) {
        const infCpl = getTag('infCpl') || getTag('infAdFisco') || '';
        if (infCpl) {
          // Padrão: data seguida de valor (ou valor seguido de data)
          const reVenc = /(?:venc(?:imento)?|vto|parc\.?\s*\d+[^\/]*\/\d+)[:\s.-]*([\d]{2}[\/\-][\d]{2}[\/\-][\d]{2,4})[^\d]*(R\$)?\s*([\d]{1,3}(?:[.,][\d]{3})*(?:[.,][\d]{2}))/gi;
          let m;
          const fromCpl = [];
          while ((m = reVenc.exec(infCpl)) !== null) {
            const dt  = parseDateStr(m[1]);
            const val = parseFloat((m[3]||'0').replace(/\./g,'').replace(',','.'));
            if (dt && val > 0) fromCpl.push({ dt, val });
          }
          if (fromCpl.length > 0) {
            fromCpl.forEach((p, i) => {
              const mesC = p.dt.slice(5,7)+'/'+p.dt.slice(0,4);
              parcelas.push({
                fornecedor:     emitente,
                produto:        '',
                dtNota,
                nf:             nNF,
                chaveNfe,
                parcela:        String(i+1)+'/'+fromCpl.length,
                totalParcelas:  fromCpl.length,
                vencimento:     p.dt,
                valor:          p.val,
                mesCompetencia: mesComp,
                mesCaixa:       mesC,
                status:         'avencer',
                origem:         'nfe',
                origemParcela:  'infCpl',
              });
            });
          }
        }
      }

      // Fonte 3: parcela única com valor total da NF
      if (parcelas.length === 0) {
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
        // Campos esperados pelo frontend (boletos.html)
        fornecedor:    emitente,
        nf:            nNF,
        totalParcelas: parcelas.length,
        valorTotal:    vNF,
        preview:       parcelas,   // array — d.preview.map() no frontend
        // Mantém também o formato anterior para compatibilidade
        boletos:       parcelas,
      });
    } catch (e) {
      console.error('[boletos/import-xml]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /import-xml/confirmar — salva as parcelas do preview ─────────────
  r.post('/import-xml/confirmar', autoPublish('boletos', 'boletos_atualizado'), async (req, res) => {
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
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,'avencer','nfe',$11,$12,$13,NOW())
          RETURNING id
        `, [
          b.fornecedor||null, b.produto||null, dtNota, b.nf||null,
          b.chaveNfe||b.chave_nfe||null,
          b.parcela||'1', parseInt(b.totalParcelas||1),
          b.plano||guessPlano(b.fornecedor),
          venc || dtNota || null,   // fallback: usa dtNota se vencimento for null
          parseFloat(b.valor)||0,
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

  // ── POST /import-pdf — Extrai boleto de PDF via IA (Anthropic proxy) ─────────
  r.post('/import-pdf', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        erro: 'ANTHROPIC_API_KEY não configurada no servidor. Configure a variável de ambiente.',
      });
    }

    try {
      const base64 = req.file.buffer.toString('base64');

      const prompt = `Você é um sistema de extração de dados de boletos bancários brasileiros.
Analise o PDF e extraia os dados do boleto.
Retorne APENAS JSON válido, sem texto adicional, sem markdown.
Formato esperado (objeto único):
{
  "fornecedor": "Nome do beneficiário/credor",
  "cnpj": "CNPJ do beneficiário ou vazio",
  "vencimento": "AAAA-MM-DD",
  "valor": 1234.56,
  "codigoBarras": "linha digitável ou código de barras numérico",
  "obs": "observações relevantes ou número do documento"
}
Se não encontrar dados suficientes, retorne {}.
Datas no formato ISO AAAA-MM-DD. Valores como número decimal sem símbolo.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      const text = (data.content || []).map(c => c.text || '').join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const preview = JSON.parse(clean || '{}');

      if (!preview.fornecedor && !preview.valor) {
        return res.status(422).json({ ok: false, erro: 'Não foi possível extrair dados do PDF.' });
      }

      // Verifica duplicata por código de barras
      let duplicata = false;
      if (preview.codigoBarras) {
        const { rows } = await pool.query(
          `SELECT id FROM boletos WHERE codigo_barras=$1 LIMIT 1`,
          [preview.codigoBarras]
        );
        duplicata = rows.length > 0;
      }

      res.json({ ok: true, preview, duplicata });
    } catch (e) {
      console.error('[boletos/import-pdf]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /nfe-extract-pdf — Extrai NF-e/boletos de PDF via IA (usado pelo nfe_boletos_bombeef.html) ──
  r.post('/nfe-extract-pdf', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        erro: 'ANTHROPIC_API_KEY não configurada no servidor. Configure a variável de ambiente no Railway.',
      });
    }

    try {
      const base64 = req.file.buffer.toString('base64');

      const prompt = `Você é um sistema de extração de dados de notas fiscais e boletos brasileiros.
Analise o documento PDF e extraia TODAS as notas fiscais, boletos ou cobranças presentes.
Retorne APENAS JSON válido, sem texto adicional, sem markdown.
Formato esperado (array):
[
  {
    "emitente": "Nome do emitente/fornecedor",
    "cnpj": "CNPJ formatado ou vazio",
    "numero": "Número da NF ou boleto",
    "emissao": "AAAA-MM-DD",
    "vencimento": "AAAA-MM-DD",
    "valor": 1234.56,
    "status": "pendente",
    "obs": "observações relevantes",
    "itens": [{"desc":"descrição","qtd":1,"un":"UN","vunit":100.00,"vtotal":100.00}]
  }
]
Se não encontrar dados suficientes, retorne [].
Datas no formato ISO AAAA-MM-DD. Valores como número decimal.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      const text = (data.content || []).map(c => c.text || '').join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const notas = JSON.parse(clean || '[]');

      res.json({ ok: true, notas: Array.isArray(notas) ? notas : [] });
    } catch (e) {
      console.error('[boletos/nfe-extract-pdf]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
