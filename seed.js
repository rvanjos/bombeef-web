/**
 * seed.js — cria o usuário admin inicial com hash bcrypt correto
 * Uso: node seed.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const USUARIOS = [
  { nome: 'Administrador',   email: 'admin@bombeef.com.br',      senha: 'gabriel1306', perfil: 'admin'      },
  { nome: 'Financeiro',      email: 'financeiro@bombeef.com.br',  senha: 'bombeef2026', perfil: 'financeiro' },
  { nome: 'Estoque',         email: 'estoque@bombeef.com.br',     senha: 'estoque123',  perfil: 'estoque'    },
];

async function seed() {
  console.log('Conectando ao banco...');
  const client = await pool.connect();
  try {
    for (const u of USUARIOS) {
      const hash = await bcrypt.hash(u.senha, 12);
      const { rows } = await client.query(
        `INSERT INTO usuarios (nome, email, senha_hash, perfil)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET senha_hash = $3, perfil = $4
         RETURNING id, nome, email, perfil`,
        [u.nome, u.email, hash, u.perfil]
      );
      console.log(`✅ ${rows[0].perfil.toUpperCase()} — ${rows[0].email} (id ${rows[0].id})`);
    }
    console.log('\n✅ Seed concluído. Credenciais de acesso:');
    USUARIOS.forEach(u => console.log(`   ${u.email}  /  ${u.senha}`));
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => { console.error('Erro no seed:', err.message); process.exit(1); });
