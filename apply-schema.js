require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

async function run() {

  const sql = fs.readFileSync('schema.sql','utf8');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();

  try {

    console.log('Conectando ao banco...');

    await client.query(sql);

    console.log('Schema executado com sucesso.');

  } catch(err){

    console.log('Erro:', err.message);

  } finally {

    client.release();
    await pool.end();

  }

}

run();