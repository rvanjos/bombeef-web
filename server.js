/**
 * server.js — Bom Beef Sistema de Gestão Integrado
 * Entrada principal do app Express + PostgreSQL
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const morgan     = require('morgan');
const path       = require('path');
const { Pool }   = require('pg');

// ── Pool PostgreSQL ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[pool] erro inesperado:', err.message);
});

// Testa conexão na inicialização
pool.query('SELECT NOW()').then(r => {
  console.log('[db] conectado:', r.rows[0].now);
}).catch(e => {
  console.error('[db] FALHA na conexão:', e.message);
  process.exit(1);
});

// ── App Express ────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN || true
    : true,
  credentials: true,
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── Arquivos estáticos ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Rotas API ──────────────────────────────────────────────────────────────────
app.use('/auth',             require('./routes/auth')(pool));
app.use('/api/boletos',      require('./routes/boletos')(pool));
app.use('/api/dre',          require('./routes/dre')(pool));
app.use('/api/produtos',     require('./routes/produtos')(pool));
app.use('/api/kits',         require('./routes/kits')(pool));
app.use('/api/validade',     require('./routes/validade')(pool));
app.use('/api/perdas',       require('./routes/perdas')(pool));
app.use('/api/retiradas',    require('./routes/retiradas')(pool));
app.use('/api/config',       require('./routes/config')(pool));
app.use('/api/dashboard',    require('./routes/dashboard')(pool));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS ts, version() AS ver');
    res.json({ ok: true, ts: rows[0].ts, pg: rows[0].ver.split(' ')[1] });
  } catch (e) {
    res.status(503).json({ ok: false, erro: e.message });
  }
});

// ── SPA fallback — serve index.html para qualquer rota não-API ─────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ ok: false, erro: 'Rota não encontrada' });
  }
});

// ── Error handler global ───────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, erro: `Arquivo muito grande. Máx: ${process.env.UPLOAD_MAX_MB || 15}MB` });
  }
  res.status(500).json({ ok: false, erro: 'Erro interno do servidor' });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
});

module.exports = { app, pool };
