/**
 * migrate.js — Migração DEFINITIVA Bom Beef
 *
 * Detecta colunas reais da tabela "boletos" (sistema anterior tinha nomes diferentes)
 * e executa todos os renomeia/ADD COLUMN necessários sem perder dados.
 *
 * Uso:  railway run node migrate.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function cols(table) {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [table]);
  return new Set(rows.map(r => r.column_name));
}

async function addCol(table, col, def) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    console.log(`  ✅  ${table}.${col}`);
  } catch (e) {
    console.log(`  ⚠️   ${table}.${col}: ${e.message}`);
  }
}

async function renameCol(table, oldName, newName) {
  try {
    await pool.query(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
    console.log(`  🔄  ${table}: ${oldName} → ${newName}`);
  } catch (e) {
    console.log(`  ⚠️   rename ${table}.${oldName}: ${e.message}`);
  }
}

async function run(sql, label = '') {
  try {
    await pool.query(sql);
    if (label) console.log(`  ✅  ${label}`);
  } catch (e) {
    if (label) console.log(`  ⚠️   ${label}: ${e.message}`);
  }
}

// ── BOLETOS ───────────────────────────────────────────────────────────────────
async function migrateBoletos() {
  console.log('\n📄 BOLETOS');

  // Verifica se tabela existe
  const { rows: tbls } = await pool.query(`
    SELECT to_regclass('public.boletos') AS exists
  `);
  if (!tbls[0].exists) {
    console.log('  ℹ️   Tabela não existe, será criada pelo servidor.');
    return;
  }

  const existing = await cols('boletos');
  console.log('  Colunas atuais:', [...existing].join(', '));

  // Mapeamentos de nomes antigos → novos
  const renames = [
    ['data_vencimento',   'vencimento'],
    ['dt_vencimento',     'vencimento'],
    ['data_nota',         'dt_nota'],
    ['numero_nota',       'nf'],
    ['num_nota',          'nf'],
    ['nota_fiscal',       'nf'],
    ['chave_nfe_acesso',  'chave_nfe'],
    ['fornecedor_nome',   'fornecedor'],
    ['produto_descricao', 'produto'],
    ['data_pagamento',    'dt_pagamento'],
    ['cod_barras',        'codigo_barras'],
    ['num_parcela',       'parcela'],
    ['total_parc',        'total_parcelas'],
    ['plano_contas',      'plano'],
    ['obs',               'observacao'],
  ];

  for (const [old, novo] of renames) {
    if (existing.has(old) && !existing.has(novo)) {
      await renameCol('boletos', old, novo);
    }
  }

  // Garante que todas as colunas necessárias existem
  const needed = [
    ['frontend_id',    'INTEGER'],
    ['fornecedor',     'TEXT'],
    ['produto',        'TEXT'],
    ['dt_nota',        'TEXT'],
    ['nf',             'TEXT'],
    ['chave_nfe',      'TEXT'],
    ['parcela',        "TEXT DEFAULT '1'"],
    ['total_parcelas', 'INTEGER DEFAULT 1'],
    ['plano',          'TEXT'],
    ['vencimento',     'DATE'],
    ['valor',          'NUMERIC(14,2) DEFAULT 0'],
    ['status',         "TEXT DEFAULT 'avencer'"],
    ['dt_pagamento',   'DATE'],
    ['observacao',     'TEXT'],
    ['origem',         "TEXT DEFAULT 'manual'"],
    ['codigo_barras',  'TEXT'],
    ['nf_id',          'INTEGER'],
    ['usuario_id',     'INTEGER'],
    ['atualizado_em',  'TIMESTAMPTZ DEFAULT NOW()'],
    // Campos para cruzamento DRE/Competencia/Caixa
    ['mes_competencia',     'TEXT'],
    ['mes_caixa',           'TEXT'],
    ['vinculado_extrato',   'BOOLEAN DEFAULT false'],
    ['extrato_lancamento',  'TEXT'],
  ];

  const freshCols = await cols('boletos'); // re-lê após renomeia
  for (const [col, def] of needed) {
    if (!freshCols.has(col)) await addCol('boletos', col, def);
  }

  // Popula mes_competencia e mes_caixa nos registros existentes
  await run(`
    UPDATE boletos
    SET mes_competencia = TO_CHAR(COALESCE(dt_nota::date, vencimento), 'MM/YYYY')
    WHERE mes_competencia IS NULL
      AND (dt_nota IS NOT NULL OR vencimento IS NOT NULL)
  `, 'boletos.mes_competencia populado');

  await run(`
    UPDATE boletos
    SET mes_caixa = TO_CHAR(COALESCE(dt_pagamento, vencimento), 'MM/YYYY')
    WHERE mes_caixa IS NULL
      AND (dt_pagamento IS NOT NULL OR vencimento IS NOT NULL)
  `, 'boletos.mes_caixa populado');

  // Remove constraints que podem dar conflito
  await run(`ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_status_check`, 'drop status check');
  await run(`ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_origem_check`, 'drop origem check');

  // Corrige valores inválidos de status
  await run(`UPDATE boletos SET status='avencer' WHERE status NOT IN ('avencer','pago','vencido','cancelado')`, 'fix status');

  await run(`
    CREATE INDEX IF NOT EXISTS idx_boletos_vencimento   ON boletos(vencimento);
    CREATE INDEX IF NOT EXISTS idx_boletos_status       ON boletos(status);
    CREATE INDEX IF NOT EXISTS idx_boletos_mes_comp     ON boletos(mes_competencia);
    CREATE INDEX IF NOT EXISTS idx_boletos_mes_caixa    ON boletos(mes_caixa);
  `, 'indexes boletos');

  console.log('  ✅  Boletos migrados');
}

// ── PERDAS ────────────────────────────────────────────────────────────────────
async function migratePerdas() {
  console.log('\n📉 PERDAS');
  const { rows: tbls } = await pool.query(`SELECT to_regclass('public.perdas') AS e`);
  if (!tbls[0].e) { console.log('  ℹ️   Será criada pelo servidor.'); return; }

  const cols_ = await cols('perdas');
  const needed = [
    ['mes',              'TEXT'],
    ['motivo',           "TEXT DEFAULT 'vencimento'"],
    ['validade_item_id', 'INTEGER'],
    ['produto_id',       'INTEGER'],
    ['funcionario_id',   'INTEGER'],
    ['qtd_unidades',     'INTEGER DEFAULT 0'],
    ['valor_perda',      'NUMERIC(10,2) DEFAULT 0'],
    ['usuario_id',       'INTEGER'],
    ['observacao',       'TEXT'],
  ];
  for (const [col, def] of needed) {
    if (!cols_.has(col)) await addCol('perdas', col, def);
  }
  await run(`
    UPDATE perdas SET mes = TO_CHAR(dt_perda, 'MM/YYYY')
    WHERE mes IS NULL AND dt_perda IS NOT NULL
  `, 'perdas.mes populado');
  await run(`CREATE INDEX IF NOT EXISTS idx_perdas_mes ON perdas(mes)`, 'idx perdas');
}

// ── KITS ──────────────────────────────────────────────────────────────────────
async function migrateKits() {
  console.log('\n🎁 KITS');
  const { rows: tbls } = await pool.query(`SELECT to_regclass('public.kits') AS e`);
  if (!tbls[0].e) { console.log('  ℹ️   Será criada pelo servidor.'); return; }

  const needed = [
    ['codigo',        'TEXT'],
    ['descricao',     'TEXT'],
    ['margem',        'NUMERIC(5,2) DEFAULT 0'],
    ['ativo',         'BOOLEAN DEFAULT true'],
    ['atualizado_em', 'TIMESTAMPTZ DEFAULT NOW()'],
  ];
  const cols_ = await cols('kits');
  for (const [col, def] of needed) {
    if (!cols_.has(col)) await addCol('kits', col, def);
  }

  // kit_itens
  const { rows: t2 } = await pool.query(`SELECT to_regclass('public.kit_itens') AS e`);
  if (t2[0].e) {
    const ki = await cols('kit_itens');
    const kiNeeded = [
      ['codigo_produto',       'TEXT'],
      ['descricao_produto',    'TEXT'],
      ['preco_custo_unitario', 'NUMERIC(10,4) DEFAULT 0'],
    ];
    for (const [col, def] of kiNeeded) {
      if (!ki.has(col)) await addCol('kit_itens', col, def);
    }
  }
}

// ── OUTRAS TABELAS ────────────────────────────────────────────────────────────
async function migrateOthers() {
  console.log('\n📋 OUTRAS TABELAS');

  // usuarios
  await addCol('usuarios', 'ultimo_login',  'TIMESTAMPTZ').catch(()=>{});
  await addCol('usuarios', 'atualizado_em', 'TIMESTAMPTZ DEFAULT NOW()').catch(()=>{});

  // validade_items — garante coluna dias_alerta
  const { rows: vt } = await pool.query(`SELECT to_regclass('public.validade_items') AS e`);
  if (vt[0].e) {
    await addCol('validade_items', 'dias_alerta', 'INTEGER DEFAULT 7').catch(()=>{});
    await addCol('validade_items', 'qtd_unidades','INTEGER DEFAULT 1').catch(()=>{});
  }

  // retiradas — garante coluna mes
  const { rows: rt } = await pool.query(`SELECT to_regclass('public.retiradas') AS e`);
  if (rt[0].e) {
    const rc = await cols('retiradas');
    if (!rc.has('mes')) {
      await addCol('retiradas', 'mes', 'TEXT');
      await run(`UPDATE retiradas SET mes=TO_CHAR(dt_retirada,'MM/YYYY') WHERE mes IS NULL`, 'retiradas.mes');
    }
    await addCol('retiradas', 'valor_total', 'NUMERIC(10,2) DEFAULT 0').catch(()=>{});
  }

  // dre_sessoes — garante atualizado_em e total_lancamentos
  const { rows: dt } = await pool.query(`SELECT to_regclass('public.dre_sessoes') AS e`);
  if (dt[0].e) {
    await addCol('dre_sessoes', 'atualizado_em',      'TIMESTAMPTZ DEFAULT NOW()').catch(()=>{});
    await addCol('dre_sessoes', 'total_lancamentos',  'INTEGER DEFAULT 0').catch(()=>{});
    await run(`
      UPDATE dre_sessoes SET total_lancamentos = jsonb_array_length(dados_json->'transactions')
      WHERE dados_json IS NOT NULL AND total_lancamentos IS NULL
    `, 'dre_sessoes.total_lancamentos').catch(()=>{});
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Bom Beef — Migração Definitiva          ║');
  console.log('╚══════════════════════════════════════════╝\n');
  try {
    await migrateBoletos();
    await migratePerdas();
    await migrateKits();
    await migrateOthers();
    console.log('\n✅ Migração concluída com sucesso!');
  } catch (e) {
    console.error('\n❌ Erro fatal na migração:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
