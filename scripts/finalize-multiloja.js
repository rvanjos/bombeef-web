'use strict';

/**
 * Finalização defensiva do esquema multi-loja.
 *
 * Este script é idempotente e nunca pode impedir o servidor de subir.
 * Ele corrige diferenças entre bancos legados e o esquema multi-loja atual
 * antes do server.js iniciar.
 */
const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

async function existeTabela(client, tabela) {
  const { rows } = await client.query('SELECT to_regclass($1) AS tabela', [`public.${tabela}`]);
  return !!rows[0]?.tabela;
}

async function existeColuna(client, tabela, coluna) {
  const { rows } = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2
  `, [tabela, coluna]);
  return rows.length > 0;
}

async function lojaPadrao(client) {
  if (!(await existeTabela(client, 'lojas'))) return null;
  const { rows } = await client.query(`
    SELECT id FROM lojas
    ORDER BY CASE WHEN codigo='valinhos' THEN 0 ELSE 1 END,
             CASE WHEN pronta_operacao THEN 0 ELSE 1 END,
             CASE WHEN ativa THEN 0 ELSE 1 END,
             id
    LIMIT 1
  `);
  return rows[0]?.id || null;
}

async function removerUniqueLegado(client, tabela, coluna) {
  const { rows } = await client.query(`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=$1 AND c.contype='u'
      AND (
        SELECT array_agg(a.attname ORDER BY x.ord)
        FROM unnest(c.conkey) WITH ORDINALITY x(attnum, ord)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=x.attnum
      ) = ARRAY[$2]::name[]
  `, [tabela, coluna]);
  for (const row of rows) {
    await client.query(`ALTER TABLE ${tabela} DROP CONSTRAINT IF EXISTS ${row.conname}`);
  }
}

async function garantirLojaId(client, tabela, lojaId, { uniqueCom = null } = {}) {
  if (!(await existeTabela(client, tabela))) return;
  await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
  await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaId]);
  await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
  await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja ON ${tabela}(loja_id)`);
  if (uniqueCom) {
    await removerUniqueLegado(client, tabela, uniqueCom);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_${tabela}_loja_${uniqueCom} ON ${tabela}(loja_id, ${uniqueCom})`);
  }
}

async function completarColunasLegadas(client) {
  if (await existeTabela(client, 'kit_campanhas')) {
    await client.query(`ALTER TABLE kit_campanhas ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true`);
    if (await existeColuna(client, 'kit_campanhas', 'status')) {
      await client.query(`UPDATE kit_campanhas SET ativo = (LOWER(COALESCE(status,'')) NOT IN ('encerrada','cancelada','finalizada'))`);
    }
  }
  if (await existeTabela(client, 'clientes_fiado')) {
    await client.query(`ALTER TABLE clientes_fiado ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lojaId = await lojaPadrao(client);
    if (!lojaId) {
      await client.query('ROLLBACK');
      console.warn('[multiloja/finalize] nenhuma loja encontrada; validação adiada');
      return;
    }

    await garantirLojaId(client, 'config_sistema', lojaId, { uniqueCom: 'chave' });
    await garantirLojaId(client, 'validade_acoes', lojaId);
    await garantirLojaId(client, 'funcionarios', lojaId);
    await garantirLojaId(client, 'metas', lojaId, { uniqueCom: 'mes' });
    await completarColunasLegadas(client);

    await client.query('COMMIT');
    console.log('[multiloja/finalize] esquema operacional validado');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // Nunca impedir o server.js de iniciar por uma correção auxiliar.
    console.error('[multiloja/finalize] aviso:', err.message);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('[multiloja/finalize] aviso fatal tratado:', err.message);
  process.exitCode = 0;
});
