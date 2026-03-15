/**
 * migrate.js — Migração segura do sistema anterior para o novo
 * Adiciona colunas novas sem apagar dados existentes.
 * Uso: node migrate.js
 * Railway: railway run node migrate.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function addColumnIfNotExists(table, column, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    console.log(`  ✅ ${table}.${column}`);
  } catch (e) {
    console.log(`  ⚠️  ${table}.${column} — ${e.message}`);
  }
}

async function migrate() {
  console.log('🔄 Iniciando migração segura...\n');

  // ── boletos: colunas novas ─────────────────────────────────────────────
  console.log('📄 boletos');
  await addColumnIfNotExists('boletos', 'chave_nfe',      'TEXT');
  await addColumnIfNotExists('boletos', 'total_parcelas', 'INTEGER DEFAULT 1');
  await addColumnIfNotExists('boletos', 'codigo_barras',  'TEXT');

  // Garante constraint de status compatível (só adiciona se não existir)
  try {
    await pool.query(`
      ALTER TABLE boletos DROP CONSTRAINT IF EXISTS boletos_status_check;
      ALTER TABLE boletos ADD CONSTRAINT boletos_status_check
        CHECK (status IN ('avencer','pago','vencido','cancelado'));
    `);
    console.log('  ✅ boletos.status constraint atualizada');
  } catch (e) {
    console.log('  ⚠️  boletos status constraint:', e.message);
  }

  // ── usuarios: coluna ultimo_login ──────────────────────────────────────
  console.log('\n👤 usuarios');
  await addColumnIfNotExists('usuarios', 'ultimo_login',   'TIMESTAMPTZ');
  await addColumnIfNotExists('usuarios', 'atualizado_em',  'TIMESTAMPTZ DEFAULT NOW()');

  // ── Cria tabelas novas que podem não existir ───────────────────────────
  console.log('\n🆕 Criando tabelas novas (se não existirem)...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      id                SERIAL PRIMARY KEY,
      nome              TEXT NOT NULL,
      cargo             TEXT,
      email             TEXT,
      telefone          TEXT,
      limite_retirada   NUMERIC(10,2) DEFAULT 0,
      usuario_id        INTEGER,
      ativo             BOOLEAN DEFAULT true,
      criado_em         TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ funcionarios');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metas (
      id                  SERIAL PRIMARY KEY,
      mes                 TEXT UNIQUE NOT NULL,
      faturamento_meta    NUMERIC(14,2) DEFAULT 0,
      faturamento_real    NUMERIC(14,2) DEFAULT 0,
      meta_perda_pct      NUMERIC(5,2) DEFAULT 2,
      meta_retiradas      NUMERIC(14,2) DEFAULT 0,
      observacao          TEXT,
      criado_em           TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ metas');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias_dre (
      id              SERIAL PRIMARY KEY,
      grupo           TEXT NOT NULL,
      subgrupo        TEXT NOT NULL,
      label_exibicao  TEXT,
      ordem           INTEGER DEFAULT 0,
      ativo           BOOLEAN DEFAULT true
    )
  `);
  console.log('  ✅ categorias_dre');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_sistema (
      chave     TEXT PRIMARY KEY,
      valor     TEXT,
      descricao TEXT
    )
  `);
  console.log('  ✅ config_sistema');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS retiradas (
      id                SERIAL PRIMARY KEY,
      funcionario_id    INTEGER NOT NULL,
      produto_id        INTEGER,
      descricao         TEXT NOT NULL,
      qtd               NUMERIC(10,3) DEFAULT 1,
      preco_unitario    NUMERIC(10,4) DEFAULT 0,
      desconto_pct      NUMERIC(5,2) DEFAULT 100,
      valor_total       NUMERIC(10,2) DEFAULT 0,
      mes               TEXT NOT NULL,
      dt_retirada       DATE DEFAULT CURRENT_DATE,
      observacao        TEXT,
      autorizado_por    INTEGER,
      usuario_id        INTEGER,
      criado_em         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ retiradas');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id            SERIAL PRIMARY KEY,
      codigo        TEXT UNIQUE NOT NULL,
      descricao     TEXT NOT NULL,
      fornecedor    TEXT,
      preco_custo   NUMERIC(10,4) DEFAULT 0,
      preco_venda   NUMERIC(10,4) DEFAULT 0,
      unidade       TEXT DEFAULT 'un',
      categoria     TEXT,
      ativo         BOOLEAN DEFAULT true,
      origem        TEXT DEFAULT 'manual',
      criado_em     TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ produtos');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kits (
      id            SERIAL PRIMARY KEY,
      codigo        TEXT UNIQUE NOT NULL,
      nome          TEXT NOT NULL,
      descricao     TEXT,
      preco_venda   NUMERIC(10,4) DEFAULT 0,
      margem        NUMERIC(5,2) DEFAULT 0,
      ativo         BOOLEAN DEFAULT true,
      criado_em     TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ kits');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kit_itens (
      id                    SERIAL PRIMARY KEY,
      kit_id                INTEGER NOT NULL,
      produto_id            INTEGER,
      codigo_produto        TEXT,
      descricao_produto     TEXT,
      quantidade            NUMERIC(10,3) DEFAULT 1,
      preco_custo_unitario  NUMERIC(10,4) DEFAULT 0
    )
  `);
  console.log('  ✅ kit_itens');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS validade_items (
      id                  SERIAL PRIMARY KEY,
      produto_id          INTEGER,
      codigo              TEXT,
      descricao           TEXT NOT NULL,
      data_validade       DATE,
      lote                TEXT,
      acao_antes_vencer   TEXT,
      ultima_conferencia  DATE,
      responsavel         TEXT,
      qtd_unidades        INTEGER DEFAULT 0,
      status              TEXT DEFAULT 'ok',
      dias_alerta         INTEGER DEFAULT 7,
      localizacao         TEXT,
      observacao          TEXT,
      criado_em           TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ validade_items');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS perdas (
      id                SERIAL PRIMARY KEY,
      validade_item_id  INTEGER,
      produto_id        INTEGER,
      descricao         TEXT NOT NULL,
      motivo            TEXT DEFAULT 'vencimento',
      qtd_unidades      INTEGER DEFAULT 0,
      valor_perda       NUMERIC(10,2) DEFAULT 0,
      funcionario_id    INTEGER,
      dt_perda          DATE DEFAULT CURRENT_DATE,
      mes               TEXT,
      observacao        TEXT,
      usuario_id        INTEGER,
      criado_em         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('  ✅ perdas');

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
  console.log('  ✅ dre_sessoes');

  // ── Popula config padrão ───────────────────────────────────────────────
  console.log('\n⚙️  Inserindo configurações padrão (se não existirem)...');
  await pool.query(`
    INSERT INTO config_sistema (chave, valor, descricao) VALUES
      ('nome_empresa',    'Bom Beef',          'Nome da empresa'),
      ('logo_emoji',      '🥩',                'Emoji do logo'),
      ('dias_alerta_val', '7',                 'Dias de antecedência para alerta de validade'),
      ('taxa_desconto_fun','100',              'Desconto padrão retiradas (%)'),
      ('fuso_horario',    'America/Sao_Paulo', 'Fuso horário')
    ON CONFLICT (chave) DO NOTHING
  `);
  console.log('  ✅ config_sistema populado');

  // ── Popula categorias DRE padrão ───────────────────────────────────────
  const { rows } = await pool.query('SELECT COUNT(*) FROM categorias_dre');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem) VALUES
        ('RECEITAS',   'Faturamento Bruto',               'Faturamento Bruto', 1),
        ('RECEITAS',   'Outros Créditos',                 'Outros Créditos', 2),
        ('CMV',        'COMPRAS - REVENDA',               'Compras para Revenda', 10),
        ('CMV',        'Material de Embalagens',          'Embalagens', 11),
        ('DESPESAS',   'Salários e Encargos',             'Salários', 20),
        ('DESPESAS',   'Aluguel',                         'Aluguel', 21),
        ('DESPESAS',   'Energia e Água',                  'Energia e Água', 22),
        ('DESPESAS',   'Marketing e Publicidade',         'Marketing', 23),
        ('DESPESAS',   'Serviços prestados por terceiros','Terceiros', 24),
        ('DESPESAS',   'Materiais diversos',              'Materiais', 25),
        ('DESPESAS',   'Taxas e Impostos',                'Taxas/Impostos', 26),
        ('DESPESAS',   'Manutenção',                      'Manutenção', 27),
        ('DESPESAS',   'Outras Despesas',                 'Outras Desp.', 28),
        ('FINANCEIRO', 'Empréstimos e Financiamentos',    'Empréstimos', 30),
        ('FINANCEIRO', 'Juros e Tarifas Bancárias',       'Juros/Tarifas', 31)
    `);
    console.log('  ✅ categorias_dre populadas');
  } else {
    console.log('  ℹ️  categorias_dre já tem dados, pulando');
  }

  console.log('\n🎉 Migração concluída! Seus dados estão intactos.');
  await pool.end();
}

migrate().catch(e => {
  console.error('\n❌ Erro na migração:', e.message);
  process.exit(1);
});
