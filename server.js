require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const path     = require('path');
const { Pool } = require('pg');

// ── Pool PostgreSQL ───────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err.message);
});

pool.connect()
  .then(client => { client.release(); console.log('[DB] PostgreSQL conectado com sucesso.'); })
  .catch(err  => console.error('[DB] Falha na conexão inicial:', err.message));

// ── App ───────────────────────────────────────────────────────
const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.APP_URL,
  'https://bombeef-web-production.up.railway.app',
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Permite chamadas sem Origin (Postman, curl, healthchecks internos, apps instalados)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origem não permitida por CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

app.use(helmet({
  contentSecurityPolicy: false, // desativado para facilitar iframes dos sub-módulos
  crossOriginEmbedderPolicy: false,
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Servir frontend estático ──────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────
app.use('/auth',             require('./routes/auth')(pool));
app.use('/api/produtos',     require('./routes/produtos')(pool));
app.use('/api/totvs',        require('./routes/totvs')(pool));
app.use('/api/lotes',        require('./routes/lotes')(pool));
app.use('/api/perdas',       require('./routes/perdas')(pool));
app.use('/api/kits',         require('./routes/kits')(pool));
app.use('/api/boletos',      require('./routes/boletos')(pool));
app.use('/api/fornecedores', require('./routes/fornecedores')(pool));
app.use('/api/dashboard',    require('./routes/dashboard')(pool));
app.use('/api/validade',     require('./routes/validade')(pool));
app.use('/api/classificador',require('./routes/classificador')(pool));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── SPA fallback ─────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup ───────────────────────────────────────────────────
async function startup() {
  try {
    await pool.query('SELECT atualizar_status_boletos_vencidos()');
    console.log('[Startup] Boletos vencidos atualizados.');
  } catch (e) {
    console.warn('[Startup] Função de boletos ainda não existe no banco:', e.message);
  }
}
startup();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Bom Beef rodando na porta ${PORT} — ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
