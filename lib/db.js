'use strict';

const { Pool } = require('pg');
const { protegerPoolPorLoja } = require('./tenant-context');

const max = Math.max(2, Math.min(20, Number(process.env.DB_POOL_MAX || 8)));

const pool = protegerPoolPorLoja(new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max,
  min: 0,
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS || 10000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECT_MS || 10000),
  allowExitOnIdle: false,
}));

pool.on('error', (err) => {
  console.error('[pool] erro inesperado:', err.message);
});

console.log('[db] pool PostgreSQL compartilhado ativo', {
  max,
  idleTimeoutMillis: pool.options?.idleTimeoutMillis,
  connectionTimeoutMillis: pool.options?.connectionTimeoutMillis,
});

module.exports = pool;
