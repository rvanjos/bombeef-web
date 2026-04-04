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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
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

// ── Rotas API ──────────────────────────────────────────────────────────────────
app.use('/auth',             require('./routes/auth')(pool));
app.use('/api/boletos',      require('./routes/boletos')(pool));
app.use('/api/faturamento',  require('./routes/faturamento')(pool));
app.use('/api/dre',          require('./routes/dre')(pool));
app.use('/api/produtos',     require('./routes/produtos')(pool));
app.use('/api/kits',         require('./routes/kits')(pool));
app.use('/api/validade',     require('./routes/validade')(pool));
app.use('/api/perdas',       require('./routes/perdas')(pool));
app.use('/api/retiradas',    require('./routes/retiradas')(pool));
app.use('/api/config',       require('./routes/config')(pool));
app.use('/api/dashboard',    require('./routes/dashboard')(pool));
app.use('/api/fornecedores', require('./routes/fornecedores')(pool));

app.use('/api/admin/backup', require('./routes/backup')(pool));

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

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
  // Conecta ao banco em background após o listen
  conectarComRetry();
});

module.exports = { app, pool };
