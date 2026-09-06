'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function extrairFornecedores() {
  const arquivo = path.join(__dirname, '..', 'routes', 'dre.js');
  const src = fs.readFileSync(arquivo, 'utf8');
  const inicio = src.indexOf('INSERT INTO fornecedores_lookup (cnpj_num, cnpj, nome) VALUES');
  const fim = src.indexOf('ON CONFLICT (cnpj_num)', inicio);
  if (inicio < 0 || fim < 0) throw new Error('Bloco de seed de fornecedores não encontrado em routes/dre.js');

  const bloco = src.slice(inicio, fim);
  const re = /\('([^']*)',\s*'([^']*)',\s*'((?:''|[^'])*)'\)/g;
  const mapa = new Map();
  let m;
  while ((m = re.exec(bloco))) {
    const cnpjNum = m[1].trim();
    const cnpj = m[2].trim();
    const nome = m[3].replace(/''/g, "'").trim();
    if (!cnpjNum || mapa.has(cnpjNum)) continue;
    mapa.set(cnpjNum, { cnpj_num: cnpjNum, cnpj, nome });
  }
  return [...mapa.values()];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn('[dre/seed-safe] DATABASE_URL ausente; seguindo sem bloquear o servidor');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const itens = extrairFornecedores();
    if (itens.length < 10) throw new Error(`Seed extraído com poucos fornecedores (${itens.length})`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fornecedores_lookup (
        id SERIAL PRIMARY KEY,
        cnpj_num TEXT UNIQUE NOT NULL,
        cnpj TEXT,
        nome TEXT NOT NULL,
        categoria TEXT
      )
    `);

    const cnpjNums = itens.map(x => x.cnpj_num);
    const cnpjs = itens.map(x => x.cnpj);
    const nomes = itens.map(x => x.nome);

    const result = await pool.query(`
      INSERT INTO fornecedores_lookup (cnpj_num, cnpj, nome)
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
      ON CONFLICT (cnpj_num) DO NOTHING
    `, [cnpjNums, cnpjs, nomes]);

    const total = await pool.query('SELECT COUNT(*)::int AS total FROM fornecedores_lookup');
    console.log(`[dre/seed-safe] fornecedores validados: ${total.rows[0].total}; novos: ${result.rowCount}`);
  } catch (e) {
    console.error('[dre/seed-safe] aviso:', e.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
