/**
 * seed.js — Popula o banco com dados iniciais
 * Uso: node seed.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function seed() {
  console.log('🌱 Iniciando seed...');

  // Cria usuário admin
  const hash = await bcrypt.hash(process.env.ADMIN_SENHA || 'BomBeef@2024', 12);
  const { rows: [admin] } = await pool.query(`
    INSERT INTO usuarios (nome, email, senha_hash, perfil)
    VALUES ($1, $2, $3, 'admin')
    ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome
    RETURNING id, email
  `, [
    process.env.ADMIN_NOME  || 'Administrador',
    process.env.ADMIN_EMAIL || 'admin@bombeef.com.br',
    hash,
  ]);
  console.log('✅ Admin:', admin.email);

  // Cria funcionários de exemplo
  const funcs = [
    { nome: 'João Silva',   cargo: 'Açougueiro',   limite: 200 },
    { nome: 'Maria Costa',  cargo: 'Caixa',        limite: 150 },
    { nome: 'Pedro Santos', cargo: 'Estoquista',   limite: 150 },
  ];
  for (const f of funcs) {
    await pool.query(`
      INSERT INTO funcionarios (nome, cargo, limite_retirada)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
    `, [f.nome, f.cargo, f.limite]);
  }
  console.log('✅ Funcionários de exemplo criados');

  // Meta do mês atual
  const now = new Date();
  const mes = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  await pool.query(`
    INSERT INTO metas (mes, faturamento_meta, meta_perda_pct, meta_retiradas)
    VALUES ($1, 80000, 2, 1000)
    ON CONFLICT (mes) DO NOTHING
  `, [mes]);
  console.log('✅ Meta do mês criada:', mes);

  console.log('\n🎉 Seed concluído!');
  console.log(`📧 Login: ${process.env.ADMIN_EMAIL || 'admin@bombeef.com.br'}`);
  console.log(`🔑 Senha: ${process.env.ADMIN_SENHA || 'BomBeef@2024'}`);

  await pool.end();
}

seed().catch(e => {
  console.error('❌ Erro no seed:', e.message);
  process.exit(1);
});
