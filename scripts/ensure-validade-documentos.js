const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS validade_documentos (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        descricao TEXT,
        data_emissao DATE,
        data_validade DATE NOT NULL,
        dias_alerta INTEGER NOT NULL DEFAULT 30 CHECK (dias_alerta >= 0),
        nome_arquivo TEXT,
        mime_type TEXT,
        tamanho_bytes INTEGER,
        conteudo BYTEA,
        criado_por TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        loja_id INTEGER NOT NULL DEFAULT bb_loja_padrao() REFERENCES lojas(id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_validade_documentos_data ON validade_documentos(data_validade)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_validade_documentos_loja ON validade_documentos(loja_id)`);
    await client.query(`ALTER TABLE validade_documentos ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE validade_documentos FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON validade_documentos`);
    await client.query(`
      CREATE POLICY bb_isolamento_loja ON validade_documentos
      USING (
        current_setting('app.bb_system', true) = '1'
        OR (
          NULLIF(current_setting('app.loja_id', true),'') IS NOT NULL
          AND loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
      )
      WITH CHECK (
        current_setting('app.bb_system', true) = '1'
        OR (
          NULLIF(current_setting('app.loja_id', true),'') IS NOT NULL
          AND loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
      )
    `);
    await client.query('COMMIT');
    console.log('[validade-documentos] estrutura verificada');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[validade-documentos] falha na migração:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('[validade-documentos] falha fatal:', error.message);
  process.exitCode = 1;
});
