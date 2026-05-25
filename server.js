/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
/**
 * server.js — Bom Beef Sistema de Gestão Integrado
 * Entrada principal do app Express + PostgreSQL
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const morgan     = require('morgan');
const path       = require('path');
const { Pool }   = require('pg');

// ── Pool PostgreSQL ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

pool.on('error', (err) => {
  console.error('[pool] erro inesperado:', err.message);
  // Não deixa o processo morrer por erro de pool
});

// ── Auto-migração na inicialização ────────────────────────────────────────────
// Roda sempre que o servidor inicia — ADD COLUMN IF NOT EXISTS é idempotente
async function autoMigrate() {
  console.log('[migrate] iniciando migração automática...');

  const addCol = async (table, col, def) => {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`)
      .catch(() => {});
  };

  // Descobre colunas reais da tabela boletos e renomeia se necessário
  const boletosExists = await pool.query(
    `SELECT to_regclass('public.boletos') AS e`
  ).then(r => !!r.rows[0].e).catch(() => false);

  if (boletosExists) {
    const { rows: bCols } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='boletos'
    `).catch(() => ({ rows: [] }));
    const bColSet = new Set(bCols.map(r => r.column_name));

    // Renomeia colunas do sistema anterior → novo nome
    const renames = [
      ['data_vencimento',   'vencimento'],
      ['dt_vencimento',     'vencimento'],
      ['data_nota',         'dt_nota'],
      ['numero_nota',       'nf'],
      ['nota_fiscal',       'nf'],
      ['data_pagamento',    'dt_pagamento'],
      ['cod_barras',        'codigo_barras'],
      ['num_parcela',       'parcela'],
      ['total_parc',        'total_parcelas'],
      ['plano_contas',      'plano'],
      ['fornecedor_nome',   'fornecedor'],
      ['produto_descricao', 'produto'],
    ];
    for (const [old, novo] of renames) {
      if (bColSet.has(old) && !bColSet.has(novo)) {
        await pool.query(`ALTER TABLE boletos RENAME COLUMN ${old} TO ${novo}`)
          .catch(() => {});
        bColSet.add(novo);
        bColSet.delete(old);
      }
    }

    // Garante todas as colunas necessárias
    const needed = [
      ['frontend_id','INTEGER'], ['fornecedor','TEXT'], ['produto','TEXT'],
      ['dt_nota','TEXT'], ['nf','TEXT'], ['chave_nfe','TEXT'],
      ['parcela',"TEXT DEFAULT '1'"], ['total_parcelas','INTEGER DEFAULT 1'],
      ['plano','TEXT'], ['vencimento','DATE'], ['dt_pagamento','DATE'],
      ['observacao','TEXT'], ['origem',"TEXT DEFAULT 'manual'"],
      ['codigo_barras','TEXT'], ['nf_id','INTEGER'], ['usuario_id','INTEGER'],
      ['mes_competencia','TEXT'], ['mes_caixa','TEXT'],
      ['vinculado_extrato','BOOLEAN DEFAULT false'],
      ['extrato_lancamento','TEXT'], ['atualizado_em','TIMESTAMPTZ DEFAULT NOW()'],
    ];
    for (const [col, def] of needed) await addCol('boletos', col, def);

    // Remove constraints problemáticas
    await pool.query(`ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_status_check`).catch(() => {});
    await pool.query(`ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_origem_check`).catch(() => {});

    // Remove NOT NULL de colunas que podem chegar nulas na importação
    const nullableCols = ['vencimento', 'data_vencimento', 'dt_nota', 'valor', 'fornecedor'];
    for (const col of nullableCols) {
      await pool.query(`ALTER TABLE boletos ALTER COLUMN ${col} DROP NOT NULL`).catch(() => {});
    }

    // Corrige status inválidos
    await pool.query(`
      UPDATE boletos SET status='avencer'
      WHERE status NOT IN ('avencer','pago','vencido','cancelado')
    `).catch(() => {});

    // Popula mes_competencia e mes_caixa
    await pool.query(`
      UPDATE boletos
      SET mes_competencia = TO_CHAR(
        COALESCE(NULLIF(dt_nota,'')::date, vencimento), 'MM/YYYY'
      )
      WHERE mes_competencia IS NULL AND (dt_nota IS NOT NULL OR vencimento IS NOT NULL)
    `).catch(() => {});

    await pool.query(`
      UPDATE boletos
      SET mes_caixa = TO_CHAR(COALESCE(dt_pagamento, vencimento), 'MM/YYYY')
      WHERE mes_caixa IS NULL AND (dt_pagamento IS NOT NULL OR vencimento IS NOT NULL)
    `).catch(() => {});
  }

  // Kits
  await addCol('kits','codigo','TEXT').catch(()=>{});
  await addCol('kits','descricao','TEXT').catch(()=>{});
  await addCol('kits','margem','NUMERIC(5,2) DEFAULT 0').catch(()=>{});
  await addCol('kits','ativo','BOOLEAN DEFAULT true').catch(()=>{});
  await addCol('kit_itens','codigo_produto','TEXT').catch(()=>{});
  await addCol('kit_itens','descricao_produto','TEXT').catch(()=>{});
  await addCol('kit_itens','preco_custo_unitario','NUMERIC(10,4) DEFAULT 0').catch(()=>{});

  // Kits — renomeia colunas legadas (nome_kit→nome, id_kit→id)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='nome_kit')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='nome')
      THEN ALTER TABLE kits RENAME COLUMN nome_kit TO nome;
           RAISE NOTICE '[migrate] kits.nome_kit renomeada para nome'; END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='id_kit')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kits' AND column_name='id')
      THEN ALTER TABLE kits RENAME COLUMN id_kit TO id;
           RAISE NOTICE '[migrate] kits.id_kit renomeada para id'; END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='id_kit')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kit_itens' AND column_name='kit_id')
      THEN ALTER TABLE kit_itens RENAME COLUMN id_kit TO kit_id;
           RAISE NOTICE '[migrate] kit_itens.id_kit renomeada para kit_id'; END IF;
    END $$;
  `).catch(e => console.warn('[migrate] kits rename:', e.message));

  // Perdas — garante coluna mes
  await addCol('perdas','mes','TEXT').catch(()=>{});
  await addCol('perdas','motivo',"TEXT DEFAULT 'vencimento'").catch(()=>{});
  await addCol('perdas','qtd_unidades','INTEGER DEFAULT 0').catch(()=>{});
  await addCol('perdas','valor_perda','NUMERIC(10,2) DEFAULT 0').catch(()=>{});
  await pool.query(`
    UPDATE perdas SET mes = TO_CHAR(dt_perda, 'MM/YYYY')
    WHERE mes IS NULL AND dt_perda IS NOT NULL
  `).catch(() => {});

  // Retiradas
  await addCol('retiradas','mes','TEXT').catch(()=>{});
  await addCol('retiradas','valor_total','NUMERIC(10,2) DEFAULT 0').catch(()=>{});
  await pool.query(`
    UPDATE retiradas SET mes = TO_CHAR(dt_retirada, 'MM/YYYY')
    WHERE mes IS NULL AND dt_retirada IS NOT NULL
  `).catch(() => {});

  // DRE sessões
  await addCol('dre_sessoes','atualizado_em','TIMESTAMPTZ DEFAULT NOW()').catch(()=>{});
  await addCol('dre_sessoes','total_lancamentos','INTEGER DEFAULT 0').catch(()=>{});
  await pool.query(`
    UPDATE dre_sessoes
    SET total_lancamentos = COALESCE(jsonb_array_length(dados_json->'transactions'), 0)
    WHERE dados_json IS NOT NULL
      AND (total_lancamentos IS NULL OR total_lancamentos = 0)
  `).catch(() => {});

  // validade_items
  await addCol('validade_items','dias_alerta','INTEGER DEFAULT 7').catch(()=>{});
  await addCol('validade_items','qtd_unidades','INTEGER DEFAULT 1').catch(()=>{});

  // usuarios
  await addCol('usuarios','ultimo_login','TIMESTAMPTZ').catch(()=>{});
  await addCol('usuarios','atualizado_em','TIMESTAMPTZ DEFAULT NOW()').catch(()=>{});

  console.log('[migrate] ✅ migração automática concluída');
}

// Conecta ao banco e roda migração — em background, não bloqueia o listen
async function conectarComRetry() {
  for (let i = 1; i <= 8; i++) {
    try {
      const r = await pool.query('SELECT NOW()');
      console.log('[db] conectado:', r.rows[0].now);
      await autoMigrate();
      return;
    } catch(e) {
      console.error(`[db] tentativa ${i}/8:`, e.message);
      if (i < 8) await new Promise(r => setTimeout(r, Math.min(3000 * i, 15000)));
    }
  }
}

// ── App Express ────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN || true
    : true,
  credentials: true,
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── Arquivos estáticos — sem cache para garantir versão mais recente ──────────
app.use((req, res, next) => {
  const p = req.path;
  const isNoCache = p === '/' || p.endsWith('.html') || p.endsWith('.js') || !p.includes('.');
  if (isNoCache) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
}));

// ── SSE — Server-Sent Events (atualização em tempo real) ─────────────────────
// Clientes conectados: Map<string, Set<res>>
const sseClients = new Map();

function ssePublish(canal, dados) {
  const set = sseClients.get(canal);
  if (!set || !set.size) return;
  const payload = 'data: ' + JSON.stringify(dados) + '\n\n';
  for (const res of set) {
    try { res.write(payload); }
    catch(_) { set.delete(res); }
  }
}
// Expõe para uso nas rotas
app.locals.ssePublish = ssePublish;

// Endpoint SSE — o front-end conecta aqui para receber eventos
app.get('/api/events', (req, res) => {
  const canal = req.query.canal || 'geral';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Railway / nginx
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  if (!sseClients.has(canal)) sseClients.set(canal, new Set());
  sseClients.get(canal).add(res);

  // Heartbeat a cada 25s para manter conexão viva
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch(_) { clearInterval(hb); }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.get(canal)?.delete(res);
  });
});

// ── Rotas API ──────────────────────────────────────────────────────────────────
app.use('/auth',             require('./routes/auth')(pool));
// Fix temporário: corrige constraint de ponto_auditoria
app.get('/fix-ponto', async (req, res) => {
  const r = [];
  const run = async (n, sql) => {
    try { await pool.query(sql); r.push('✅ '+n); }
    catch(e) { r.push('⚠️ '+n+': '+e.message); }
  };
  // Recria ponto_auditoria sem FK para ponto_registros (evita constraint issues)
  await run('drop auditoria', `DROP TABLE IF EXISTS ponto_auditoria CASCADE`);
  await run('ponto_auditoria', `CREATE TABLE IF NOT EXISTS ponto_auditoria (
    id              SERIAL PRIMARY KEY,
    ponto_id        INTEGER,
    funcionario_id  INTEGER NOT NULL,
    tipo            TEXT NOT NULL,
    horario_batida  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    usuario_login   TEXT,
    usuario_nome    TEXT,
    usuario_perfil  TEXT,
    ip_address      TEXT,
    user_agent      TEXT,
    manual          BOOLEAN DEFAULT FALSE,
    obs             TEXT
  )`);
  // Garante que ponto_registros não tem FK quebrada
  await run('idx ponto', `CREATE UNIQUE INDEX IF NOT EXISTS ponto_func_data_idx ON ponto_registros(funcionario_id, data_ref)`);
  res.send('<div style="font-family:sans-serif;padding:20px">'+r.map(x=>`<div>${x}</div>`).join('')+'<p>Pronto! Pode fechar.</p></div>');
});

app.use('/api/boletos',      require('./routes/boletos')(pool, app));
app.use('/api/faturamento',  require('./routes/faturamento')(pool, app));
app.use('/api/dre',          require('./routes/dre')(pool, app));
app.use('/api/produtos',     require('./routes/produtos')(pool, app));
app.use('/api/kits',         require('./routes/kits')(pool));
app.use('/api/kits-campanha',require('./routes/kits_campanha')(pool, app));
app.use('/api/validade',     require('./routes/validade')(pool));
app.use('/api/compras_pendentes', require('./routes/fiado')(pool));
app.use('/api/fiado',        require('./routes/fiado')(pool)); // alias legado
app.use('/api/ponto',        require('./routes/ponto')(pool));

// ── POST /api/dre/exportar-excel — gera XLSX formatado via Python/openpyxl ──
app.post('/api/dre/exportar-excel', require('./middleware/auth')(), async (req, res) => {
  const { spawn } = require('child_process');
  const path = require('path');
  const scriptPath = path.join(__dirname, 'utils', 'gerar_dre_excel.py');
  const payload = JSON.stringify(req.body);
  const py = spawn('python3', [scriptPath]);
  let out = '', err = '';
  py.stdin.write(payload); py.stdin.end();
  py.stdout.on('data', d => out += d);
  py.stderr.on('data', d => err += d);
  py.on('close', code => {
    if (code !== 0 || !out.trim()) {
      console.error('[dre-excel]', err);
      return res.status(500).json({ ok: false, erro: err || 'Erro ao gerar Excel' });
    }
    const buf = Buffer.from(out.trim(), 'base64');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="DRE_BomBeef.xlsx"');
    res.send(buf);
  });
});
app.use('/api/perdas',       require('./routes/perdas')(pool));
app.use('/api/retiradas',    require('./routes/retiradas')(pool));
app.use('/api/config',       require('./routes/config')(pool));
app.use('/api/rh',           require('./routes/rh')(pool));
app.use('/api/dashboard',    require('./routes/dashboard')(pool));
app.use('/api/fornecedores', require('./routes/fornecedores')(pool));
app.use('/api/cortes',       require('./routes/cortes')(pool));
app.use('/api/vendas-produto', require('./routes/vendas_produto')(pool));
// ── Rota seed CorteMaster (executa uma vez para popular dados iniciais) ─────
app.get('/api/admin/seed-cortes', async (req, res) => {
  try {
    // Registros de corte
    const cortes = [
      { data:'2026-02-27', fornecedor:'3gFoods', corte:'Patinho',    peso_bruto:4.404, peso_limpo:3.460, custo_por_kg:35.00, margem:0.30, estoque:12.0 },
      { data:'2026-03-05', fornecedor:'3gFoods', corte:'Coxão Duro', peso_bruto:6.220, peso_limpo:5.544, custo_por_kg:33.70, margem:0.30, estoque:20.0 },
      { data:'2026-03-06', fornecedor:'Frigol',  corte:'Alcatra',    peso_bruto:8.500, peso_limpo:7.820, custo_por_kg:48.00, margem:0.35, estoque:15.5 },
      { data:'2026-03-06', fornecedor:'3gFoods', corte:'Picanha',    peso_bruto:3.200, peso_limpo:2.950, custo_por_kg:89.00, margem:0.40, estoque:8.0  },
      { data:'2026-03-07', fornecedor:'Frigol',  corte:'Fraldinha',  peso_bruto:5.100, peso_limpo:4.600, custo_por_kg:42.00, margem:0.35, estoque:10.0 },
    ];
    let cr = 0;
    for (const c of cortes) {
      const ex = await pool.query('SELECT id FROM cortes_registros WHERE corte=$1 AND data=$2', [c.corte, c.data]);
      if (!ex.rows.length) {
        await pool.query(
          'INSERT INTO cortes_registros (data,fornecedor,corte,peso_bruto,peso_limpo,custo_por_kg,margem,estoque) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [c.data, c.fornecedor, c.corte, c.peso_bruto, c.peso_limpo, c.custo_por_kg, c.margem, c.estoque]
        );
        cr++;
      }
    }

    // Insumos
    const insumos = [
      { nome:'Alho em Pó',         categoria:'Tempero',     preco_unit:18.90, unidade:'kg',   estoque:2.5,  fornecedor:'Distsab'   },
      { nome:'Sal Grosso',          categoria:'Tempero',     preco_unit:3.50,  unidade:'kg',   estoque:10.0, fornecedor:'Distsab'   },
      { nome:'Pimenta do Reino',    categoria:'Tempero',     preco_unit:62.00, unidade:'kg',   estoque:0.8,  fornecedor:'Distsab'   },
      { nome:'Azeite Extra Virgem', categoria:'Molho',       preco_unit:32.00, unidade:'L',    estoque:3.0,  fornecedor:'Distsab'   },
      { nome:'Bandeja PP3',         categoria:'Embalagem',   preco_unit:0.45,  unidade:'un',   estoque:500,  fornecedor:'Embalpak'  },
      { nome:'Filme PVC Rolo',      categoria:'Embalagem',   preco_unit:28.00, unidade:'rolo', estoque:4.0,  fornecedor:'Embalpak'  },
      { nome:'Luva Descartável',    categoria:'Descartável', preco_unit:22.00, unidade:'cx',   estoque:3.0,  fornecedor:'Cirúrgica' },
      { nome:'Detergente 500ml',    categoria:'Limpeza',     preco_unit:4.80,  unidade:'un',   estoque:6.0,  fornecedor:'Limpmax'   },
    ];
    let ir = 0;
    for (const i of insumos) {
      await pool.query(
        `INSERT INTO cortes_insumos (nome,categoria,preco_unit,unidade,estoque,fornecedor)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (nome) DO NOTHING`,
        [i.nome, i.categoria, i.preco_unit, i.unidade, i.estoque, i.fornecedor]
      );
      ir++;
    }

    res.json({ ok:true, cortes_inseridos:cr, insumos_inseridos:ir });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});


app.use('/api/admin/backup', require('./routes/backup')(pool));

// Limpa duplicatas de validade — mantém o mais recente por (descricao, data_validade)
app.get('/api/admin/fix-validade-duplicatas', async (req, res) => {
  try {
    let removidos = 0;

    // 1. Duplicatas por descricao + data_validade
    const { rows: dups1 } = await pool.query(`
      SELECT descricao, data_validade, COUNT(*) as total,
             array_agg(id ORDER BY id DESC) as ids
      FROM validade_items
      WHERE status NOT IN ('vendido','descartado')
      GROUP BY descricao, data_validade
      HAVING COUNT(*) > 1
    `);
    for (const row of dups1) {
      const [, ...remove] = row.ids;
      if (remove.length) {
        await pool.query(
          `UPDATE validade_items SET status='descartado', resolucao='duplicata',
           dt_resolucao=CURRENT_DATE, atualizado_em=NOW() WHERE id=ANY($1::int[])`,
          [remove]
        );
        removidos += remove.length;
      }
    }

    // 2. Duplicatas por codigo + data_validade (quando codigo não é nulo)
    const { rows: dups2 } = await pool.query(`
      SELECT codigo, data_validade, COUNT(*) as total,
             array_agg(id ORDER BY id DESC) as ids
      FROM validade_items
      WHERE status NOT IN ('vendido','descartado')
        AND codigo IS NOT NULL AND codigo != ''
      GROUP BY codigo, data_validade
      HAVING COUNT(*) > 1
    `);
    for (const row of dups2) {
      const [, ...remove] = row.ids;
      if (remove.length) {
        await pool.query(
          `UPDATE validade_items SET status='descartado', resolucao='duplicata',
           dt_resolucao=CURRENT_DATE, atualizado_em=NOW() WHERE id=ANY($1::int[])`,
          [remove]
        );
        removidos += remove.length;
      }
    }

    res.json({ ok: true, duplicatasEncontradas: dups1.length + dups2.length, removidos });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Limpa sessões duplicadas do DRE — mantém apenas a mais recente por mês
app.get('/api/admin/fix-dre-sessions', async (req, res) => {
  try {
    // Encontra meses com múltiplas sessões
    const { rows: dups } = await pool.query(`
      SELECT mes_ref, COUNT(*) as total, array_agg(id ORDER BY atualizado_em DESC) as ids
      FROM dre_sessoes GROUP BY mes_ref HAVING COUNT(*) > 1
    `);
    const results = [];
    for (const row of dups) {
      const [keep, ...remove] = row.ids;
      // Antes de remover, merge todos os lançamentos na sessão mais recente
      const allTxs = [];
      const seenFitid = new Set(), seenHash = new Set();
      for (const id of row.ids) {
        const { rows: sr } = await pool.query(`SELECT dados_json FROM dre_sessoes WHERE id=$1`, [id]);
        const txs = sr[0]?.dados_json?.transactions || [];
        for (const t of txs) {
          const key = t.fitid || `${t.data}_${t.valor}_${(t.lancamento||'').slice(0,30)}`;
          if (seenFitid.has(key)) continue;
          seenFitid.add(key);
          allTxs.push(t);
        }
      }
      // Atualiza sessão mais recente com todos os lançamentos únicos
      await pool.query(`UPDATE dre_sessoes SET dados_json=$1, atualizado_em=NOW() WHERE id=$2`,
        [JSON.stringify({ transactions: allTxs }), keep]);
      // Remove duplicatas
      await pool.query(`DELETE FROM dre_sessoes WHERE id = ANY($1::int[])`, [remove]);
      results.push(`✅ ${row.mes_ref}: ${allTxs.length} lançamentos únicos, removidas ${remove.length} sessões duplicadas`);
    }
    if (!results.length) results.push('✅ Nenhuma sessão duplicada encontrada');
    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Limpa categorias inválidas (ex: "BOLETO PAGO") do supplierMem nas sessões DRE
app.get('/api/admin/fix-dre-supermem', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, mes_ref, dados_json FROM dre_sessoes`);
    let sessoes_limpas = 0, entradas_removidas = 0;
    for (const row of rows) {
      const dados = row.dados_json || {};
      const mem = dados.supplierMem || {};
      // Categorias válidas = subgrupos do DRE (qualquer valor que tenha espaço ou seja uma descrição real)
      // Remove entradas onde o valor parece status de boleto, não categoria DRE
      const invalidas = ['BOLETO PAGO', 'PAGO', 'PENDENTE', 'VENCIDO', 'CANCELADO'];
      const memLimpo = {};
      let removeu = false;
      for (const [k, v] of Object.entries(mem)) {
        if (invalidas.includes(String(v).toUpperCase().trim())) {
          removeu = true;
          entradas_removidas++;
        } else {
          memLimpo[k] = v;
        }
      }
      // Também limpa categorias das transactions
      const txs = (dados.transactions || []).map(t => {
        if (invalidas.includes(String(t.categoria||'').toUpperCase().trim())) {
          removeu = true;
          return { ...t, categoria: '' };
        }
        return t;
      });
      if (removeu) {
        await pool.query(
          `UPDATE dre_sessoes SET dados_json=$1, atualizado_em=NOW() WHERE id=$2`,
          [JSON.stringify({ ...dados, supplierMem: memLimpo, transactions: txs }), row.id]
        );
        sessoes_limpas++;
      }
    }
    res.json({ ok: true, sessoes_limpas, entradas_removidas });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Rota de migration manual — acessa uma vez para renomear colunas legadas
app.get('/api/admin/fix-kits', async (req, res) => {
  try {
    const results = [];
    const client = await pool.connect();
    try {
      // 1. Rename legados em kits — cada um isolado
      for (const { from, to } of [{from:'nome_kit',to:'nome'},{from:'id_kit',to:'id'}]) {
        const { rows: hasFrom } = await client.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='kits' AND column_name=$1`, [from]
        );
        const { rows: hasTo } = await client.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='kits' AND column_name=$1`, [to]
        );
        if (hasFrom.length && !hasTo.length) {
          await client.query(`ALTER TABLE kits RENAME COLUMN ${from} TO ${to}`);
          results.push(`✅ kits.${from} → ${to}`);
        } else if (hasFrom.length && hasTo.length) {
          results.push(`⏭ kits: ambas ${from} e ${to} existem — sem rename`);
        } else {
          results.push(`⏭ kits.${from} não existe (OK)`);
        }
      }

      // 2. Fix kit_itens: garantir que kit_id existe e tem dados corretos
      const { rows: cols } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='kit_itens'
          AND column_name IN ('kit_id','id_kit')
      `);
      const hasKitId  = cols.some(r => r.column_name === 'kit_id');
      const hasIdKit  = cols.some(r => r.column_name === 'id_kit');
      results.push(`kit_itens: kit_id=${hasKitId} id_kit=${hasIdKit}`);

      if (!hasKitId && hasIdKit) {
        // Só id_kit existe — renomeia
        await client.query(`ALTER TABLE kit_itens RENAME COLUMN id_kit TO kit_id`);
        results.push('✅ kit_itens.id_kit → kit_id (rename)');
      } else if (hasKitId && hasIdKit) {
        // Ambas existem — copia id_kit → kit_id onde kit_id é nulo, depois dropa id_kit
        await client.query(`UPDATE kit_itens SET kit_id = id_kit WHERE kit_id IS NULL AND id_kit IS NOT NULL`);
        await client.query(`ALTER TABLE kit_itens DROP COLUMN id_kit`);
        results.push('✅ kit_itens: copiou id_kit→kit_id e dropou id_kit');
      } else if (hasKitId) {
        results.push('⏭ kit_itens.kit_id já existe sem id_kit (OK)');
      }

      // 3. Garante NOT NULL em kit_itens.kit_id
      await client.query(`ALTER TABLE kit_itens ALTER COLUMN kit_id SET NOT NULL`).catch(e => {
        results.push(`⚠️ NOT NULL falhou: ${e.message}`);
      });
      results.push('✅ kit_itens.kit_id NOT NULL garantido');

      // 4. Remove FK desnecessária em codigo_produto (se existir)
      const { rows: fks } = await client.query(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name='kit_itens' AND constraint_type='FOREIGN KEY'
          AND constraint_name LIKE '%codigo_produto%'
      `);
      for (const fk of fks) {
        await client.query(`ALTER TABLE kit_itens DROP CONSTRAINT ${fk.constraint_name}`);
        results.push(`✅ FK removida: ${fk.constraint_name}`);
      }
      if (!fks.length) results.push('⏭ Nenhuma FK de codigo_produto encontrada');

      // 5. Listar todas as FKs restantes em kit_itens para diagnóstico
      const { rows: allFks } = await client.query(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name='kit_itens' AND constraint_type='FOREIGN KEY'
      `);
      results.push(`FKs restantes em kit_itens: ${allFks.map(r=>r.constraint_name).join(', ') || 'nenhuma'}`);

      // 6. Dropar triggers em kit_itens que referenciam id_kit
      const { rows: triggers } = await client.query(`
        SELECT trigger_name, event_object_table
        FROM information_schema.triggers
        WHERE event_object_table = 'kit_itens'
      `);
      results.push(`Triggers em kit_itens: ${triggers.map(t=>t.trigger_name).join(', ') || 'nenhuma'}`);
      for (const t of triggers) {
        await client.query(`DROP TRIGGER IF EXISTS ${t.trigger_name} ON kit_itens CASCADE`);
        results.push(`✅ Trigger dropada: ${t.trigger_name}`);
      }

      // 7. Ver funções de trigger que mencionam id_kit
      const { rows: funcs } = await client.query(`
        SELECT p.proname, p.oid
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND prosrc ILIKE '%id_kit%'
      `);
      results.push(`Funções com id_kit: ${funcs.map(f=>f.proname).join(', ') || 'nenhuma'}`);
      for (const f of funcs) {
        await client.query(`DROP FUNCTION IF EXISTS public.${f.proname}() CASCADE`).catch(async () => {
          // tenta com CASCADE via oid
          await client.query(`DROP ROUTINE IF EXISTS public.${f.proname} CASCADE`).catch(()=>{});
        });
        results.push(`✅ Função dropada: ${f.proname}`);
      }

    } finally { client.release(); }
    res.json({ ok: true, results });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS ts, version() AS ver');
    res.json({ ok: true, ts: rows[0].ts, pg: rows[0].ver.split(' ')[1] });
  } catch (e) {
    res.status(503).json({ ok: false, erro: e.message });
  }
});

// ── SPA fallback — serve index.html para qualquer rota não-API ─────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ ok: false, erro: 'Rota não encontrada' });
  }
});

// ── Error handler global ───────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, erro: `Arquivo muito grande. Máx: ${process.env.UPLOAD_MAX_MB || 15}MB` });
  }
  res.status(500).json({ ok: false, erro: 'Erro interno do servidor' });
});

// ── Start (restarted 1775504041) ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
  // Conecta ao banco em background após o listen
  conectarComRetry();
});

// ── Proteção contra crash ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack?.slice(0,300));
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM — encerrando graciosamente');
  pool.end().catch(() => {}).finally(() => process.exit(0));
});

module.exports = { app, pool };
