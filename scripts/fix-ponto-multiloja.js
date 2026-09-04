const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

async function existeTabela(client, tabela) {
  const { rows } = await client.query('SELECT to_regclass($1) AS tabela', [`public.${tabela}`]);
  return !!rows[0]?.tabela;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lojasExiste = await existeTabela(client, 'lojas');
    if (!lojasExiste) {
      console.log('[hotfix-ponto] tabela lojas ainda não existe; nada a corrigir');
      await client.query('ROLLBACK');
      return;
    }

    const { rows: lojas } = await client.query(`
      SELECT id
      FROM lojas
      ORDER BY CASE WHEN slug='valinhos' THEN 0 ELSE 1 END,
               CASE WHEN ativa THEN 0 ELSE 1 END,
               id
      LIMIT 1
    `);
    const lojaPadrao = lojas[0]?.id;
    if (!lojaPadrao) throw new Error('Nenhuma loja disponível para vincular os dados existentes');

    const tabelas = [
      'funcionarios',
      'ponto_registros',
      'ponto_auditoria',
      'ponto_jornada_dia',
      'rh_fichas',
      'rh_apontamentos',
      'rh_pagamentos',
      'rh_meta_fds_config',
      'rh_escalas',
      'login_sessoes'
    ];

    for (const tabela of tabelas) {
      if (!(await existeTabela(client, tabela))) continue;

      await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
      await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaPadrao]);
      await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
      await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja ON ${tabela}(loja_id)`);

      await client.query(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON ${tabela}`);
      await client.query(`
        CREATE POLICY bb_isolamento_loja ON ${tabela}
        USING (
          NULLIF(current_setting('app.loja_id', true),'') IS NULL
          OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
        WITH CHECK (
          NULLIF(current_setting('app.loja_id', true),'') IS NULL
          OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
      `);
    }

    if (await existeTabela(client, 'ponto_registros')) {
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_ponto_loja_func_data ON ponto_registros(loja_id, funcionario_id, data_ref)');
    }
    if (await existeTabela(client, 'ponto_jornada_dia')) {
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_ponto_jornada_loja_func_dia ON ponto_jornada_dia(loja_id, funcionario_id, dia_semana)');
    }

    await client.query('COMMIT');
    console.log('[hotfix-ponto] loja_id verificado/corrigido nas tabelas de Pessoas');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[hotfix-ponto] erro:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
