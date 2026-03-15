/**
 * routes/auth.js
 * Autenticação JWT, gestão de usuários e perfis.
 *
 * Rotas:
 *   POST /auth/login              → autentica, retorna token
 *   POST /auth/logout             → invalida sessão (cliente apaga token)
 *   GET  /auth/me                 → dados do usuário logado
 *   GET  /auth/usuarios           → lista usuários (admin)
 *   POST /auth/usuarios           → cria usuário (admin)
 *   PUT  /auth/usuarios/:id       → edita usuário (admin)
 *   DELETE /auth/usuarios/:id     → inativa usuário (admin)
 *   PUT  /auth/senha              → troca senha (próprio usuário)
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id          SERIAL PRIMARY KEY,
        nome        TEXT NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        senha_hash  TEXT NOT NULL,
        perfil      TEXT NOT NULL DEFAULT 'caixa'
                    CHECK (perfil IN ('admin','gestor','financeiro','estoque','caixa')),
        ativo       BOOLEAN DEFAULT true,
        ultimo_login TIMESTAMPTZ,
        criado_em   TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Cria admin padrão se não existir
    const { rows } = await pool.query(`SELECT id FROM usuarios WHERE perfil='admin' LIMIT 1`);
    if (rows.length === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_SENHA || 'BomBeef@2024', 12);
      await pool.query(`
        INSERT INTO usuarios (nome, email, senha_hash, perfil)
        VALUES ($1, $2, $3, 'admin')
        ON CONFLICT (email) DO NOTHING
      `, [
        process.env.ADMIN_NOME  || 'Administrador',
        process.env.ADMIN_EMAIL || 'admin@bombeef.com.br',
        hash,
      ]);
      console.log('[auth] usuário admin criado:', process.env.ADMIN_EMAIL || 'admin@bombeef.com.br');
    }
  }
  initTable().catch(e => console.error('[auth] initTable:', e.message));

  // ── POST /login ────────────────────────────────────────────────────────────
  r.post('/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'E-mail e senha são obrigatórios' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT * FROM usuarios WHERE email = $1 AND ativo = true`,
        [email.toLowerCase().trim()]
      );

      if (rows.length === 0) {
        return res.status(401).json({ ok: false, erro: 'E-mail ou senha incorretos' });
      }

      const usuario = rows[0];
      const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
      if (!senhaOk) {
        return res.status(401).json({ ok: false, erro: 'E-mail ou senha incorretos' });
      }

      // Atualiza último login
      await pool.query(`UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1`, [usuario.id]);

      const token = jwt.sign(
        { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );

      res.json({
        ok: true,
        token,
        usuario: {
          id:     usuario.id,
          nome:   usuario.nome,
          email:  usuario.email,
          perfil: usuario.perfil,
        },
      });
    } catch (e) {
      console.error('[auth/login]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro interno' });
    }
  });

  // ── GET /me ────────────────────────────────────────────────────────────────
  r.get('/me', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, nome, email, perfil, ultimo_login, criado_em FROM usuarios WHERE id = $1`,
        [req.user.id]
      );
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Usuário não encontrado' });
      res.json({ ok: true, data: rows[0] });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /logout ───────────────────────────────────────────────────────────
  r.post('/logout', autenticar(), (req, res) => {
    // Com JWT stateless, o logout é feito no cliente (apaga o token)
    res.json({ ok: true });
  });

  // ── GET /usuarios ──────────────────────────────────────────────────────────
  r.get('/usuarios', autenticar(['admin', 'gestor']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, nome, email, perfil, ativo, ultimo_login, criado_em
         FROM usuarios ORDER BY nome ASC`
      );
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /usuarios ─────────────────────────────────────────────────────────
  r.post('/usuarios', autenticar('admin'), async (req, res) => {
    const { nome, email, senha, perfil } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, erro: 'nome, email e senha são obrigatórios' });
    }
    try {
      const hash = await bcrypt.hash(senha, 12);
      const { rows } = await pool.query(`
        INSERT INTO usuarios (nome, email, senha_hash, perfil)
        VALUES ($1, $2, $3, $4)
        RETURNING id, nome, email, perfil
      `, [nome.trim(), email.toLowerCase().trim(), hash, perfil || 'caixa']);
      res.json({ ok: true, data: rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ ok: false, erro: 'E-mail já cadastrado' });
      }
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── PUT /usuarios/:id ──────────────────────────────────────────────────────
  r.put('/usuarios/:id', autenticar('admin'), async (req, res) => {
    const { nome, email, perfil, ativo } = req.body;
    try {
      await pool.query(`
        UPDATE usuarios SET
          nome  = COALESCE($1, nome),
          email = COALESCE($2, email),
          perfil = COALESCE($3, perfil),
          ativo  = COALESCE($4, ativo),
          atualizado_em = NOW()
        WHERE id = $5
      `, [nome || null, email?.toLowerCase() || null, perfil || null,
          ativo !== undefined ? ativo : null, parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── DELETE /usuarios/:id ───────────────────────────────────────────────────
  r.delete('/usuarios/:id', autenticar('admin'), async (req, res) => {
    try {
      // Não permite inativar o próprio usuário
      if (parseInt(req.params.id) === req.user.id) {
        return res.status(400).json({ ok: false, erro: 'Não é possível inativar o próprio usuário' });
      }
      await pool.query(
        `UPDATE usuarios SET ativo = false, atualizado_em = NOW() WHERE id = $1`,
        [parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── PUT /senha ─────────────────────────────────────────────────────────────
  r.put('/senha', autenticar(), async (req, res) => {
    const { senha_atual, senha_nova } = req.body;
    if (!senha_atual || !senha_nova) {
      return res.status(400).json({ ok: false, erro: 'Senha atual e nova são obrigatórias' });
    }
    if (senha_nova.length < 6) {
      return res.status(400).json({ ok: false, erro: 'Senha nova deve ter no mínimo 6 caracteres' });
    }
    try {
      const { rows } = await pool.query(`SELECT senha_hash FROM usuarios WHERE id = $1`, [req.user.id]);
      const ok = await bcrypt.compare(senha_atual, rows[0].senha_hash);
      if (!ok) return res.status(401).json({ ok: false, erro: 'Senha atual incorreta' });

      const hash = await bcrypt.hash(senha_nova, 12);
      await pool.query(
        `UPDATE usuarios SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2`,
        [hash, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
