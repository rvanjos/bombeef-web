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

  // Helper: executa query com retry automático para ECONNRESET/banco reiniciando
  async function queryComRetry(sql, params = [], tentativas = 3) {
    for (let i = 1; i <= tentativas; i++) {
      try {
        return await pool.query(sql, params);
      } catch(e) {
        if (i < tentativas && (e.code === 'ECONNRESET' || e.message?.includes('accepting'))) {
          await new Promise(r => setTimeout(r, 1500 * i));
          continue;
        }
        throw e;
      }
    }
  }

// ── PUT /usuarios/:id/reativar ──────────────────────────────────────────────
r.put('/usuarios/:id/reativar', autenticar('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    await pool.query(
      `UPDATE usuarios SET ativo = true, atualizado_em = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id          SERIAL PRIMARY KEY,
        nome        TEXT NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        senha_hash  TEXT NOT NULL,
        perfil      TEXT NOT NULL DEFAULT 'caixa'
                    CHECK (perfil IN ('admin','gestor','financeiro','estoque','caixa','contabil')),
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

  // Atualiza constraint de perfil para incluir 'contabil' (bancos existentes)
  pool.query(`
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
      CHECK (perfil IN ('admin','gestor','financeiro','estoque','caixa','contabil'));
  `).catch(() => {}); // silencia se tabela ainda não existe

  // ── POST /refresh — renova token sem precisar fazer login novamente ────────
  r.post('/refresh', async (req, res) => {
    const auth = req.headers.authorization || '';
    const oldToken = auth.replace('Bearer ', '');
    if (!oldToken) return res.status(401).json({ ok: false, erro: 'Token não fornecido' });
    try {
      // Verifica mesmo expirado (ignoreExpiration) para permitir renovação
      const payload = jwt.verify(oldToken, process.env.JWT_SECRET, { ignoreExpiration: true });
      // Só renova se expirou há menos de 1 dia (segurança)
      const expiredAgo = Math.floor(Date.now()/1000) - payload.exp;
      if (expiredAgo > 86400) return res.status(401).json({ ok: false, erro: 'Token muito antigo' });
      // Verifica se usuário ainda existe e está ativo
      const { rows } = await pool.query('SELECT id,nome,email,perfil FROM usuarios WHERE id=$1 AND ativo=true', [payload.id]);
      if (!rows.length) return res.status(401).json({ ok: false, erro: 'Usuário inativo' });
      const newToken = jwt.sign(
        { id: rows[0].id, nome: rows[0].nome, email: rows[0].email, perfil: rows[0].perfil },
        process.env.JWT_SECRET, { expiresIn: '24h' }
      );
      res.json({ ok: true, token: newToken, usuario: rows[0] });
    } catch(e) {
      res.status(401).json({ ok: false, erro: 'Token inválido' });
    }
  });

  // ── POST /login ────────────────────────────────────────────────────────────
  r.post('/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'E-mail e senha são obrigatórios' });
    }

    try {
      const { rows } = await queryComRetry(
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
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
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
    const id = parseInt(req.params.id);

    if (id === req.user.id) {
      return res.status(400).json({ ok: false, erro: 'Não é possível inativar o próprio usuário' });
    }

    await pool.query(
      `UPDATE usuarios SET ativo = false, atualizado_em = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── DELETE /usuarios/:id/permanente → excluir definitivamente ──────────────
r.delete('/usuarios/:id/permanente', autenticar('admin'), async (req, res) => {
  const client = await pool.connect();

  try {
    const id = parseInt(req.params.id);

    if (id === req.user.id) {
      return res.status(400).json({ ok: false, erro: 'Não é possível excluir o próprio usuário' });
    }

    await client.query('BEGIN');

    // desvincula referências conhecidas
    await client.query(
      `UPDATE funcionarios SET usuario_id = NULL WHERE usuario_id = $1`,
      [id]
    );

    await client.query(
      `DELETE FROM usuarios WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, erro: e.message });
  } finally {
    client.release();
  }
});

  // ── PUT /usuarios/:id/senha — admin troca senha de qualquer usuário ─────────
  r.put('/usuarios/:id/senha', autenticar('admin'), async (req, res) => {
    const { senha_nova } = req.body;
    if (!senha_nova || senha_nova.length < 6)
      return res.status(400).json({ ok: false, erro: 'Senha deve ter no mínimo 6 caracteres' });
    try {
      const hash = await bcrypt.hash(senha_nova, 12);
      await pool.query(`UPDATE usuarios SET senha_hash=$1, atualizado_em=NOW() WHERE id=$2`,
        [hash, parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
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

  // ── GET /reset-admin — recuperação de senha de emergência ──────────────────
  // Token: bb@Reset2024! — acesso apenas via URL direta
  r.get('/reset-admin', async (req, res) => {
    const TOKEN = 'bb@Reset2024!';
    const { tk, pwd, email } = req.query;
    if (tk !== TOKEN)
      return res.status(403).send('<h2>❌ Token inválido</h2>');
    // Se não passar pwd, mostra formulário
    if (!pwd) {
      return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:400px">
        <h2>🔑 Reset de Senha — Bom Beef</h2>
        <form method="GET">
          <input type="hidden" name="tk" value="${TOKEN}">
          <p><label>E-mail do admin (opcional):<br>
          <input name="email" style="width:100%;padding:8px;margin-top:4px"></label></p>
          <p><label>Nova senha:<br>
          <input name="pwd" type="password" style="width:100%;padding:8px;margin-top:4px" required minlength="6"></label></p>
          <button type="submit" style="background:#8B0000;color:#fff;padding:10px 20px;border:none;border-radius:6px;font-size:14px;cursor:pointer">
            Alterar Senha
          </button>
        </form>
      </body></html>`);
    }
    if (pwd.length < 6)
      return res.send('<h2>❌ Senha deve ter no mínimo 6 caracteres</h2>');
    try {
      const hash = await bcrypt.hash(pwd, 12);
      const where = email ? `email=$2` : `perfil='admin'`;
      const params = email ? [hash, email] : [hash];
      const { rows } = await queryComRetry(
        `UPDATE usuarios SET senha_hash=$1, atualizado_em=NOW() WHERE ${where} RETURNING id, nome, email, perfil`,
        params
      );
      if (!rows.length) return res.send('<h2>❌ Usuário não encontrado</h2>');
      res.send(`<h2>✅ Senha atualizada!</h2><p>Usuário: <b>${rows[0].nome}</b> (${rows[0].email})</p>
        <p><a href="/auth/reset-admin?tk=${TOKEN}">Alterar outra senha</a></p>
        <p><a href="/">Voltar ao sistema</a></p>`);
    } catch(e) { res.status(500).send('Erro: '+e.message); }
  });

  return r;
};
