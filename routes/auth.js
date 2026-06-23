const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // ── POST /auth/login ─────────────────────────────────────
  router.post('/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha)
      return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });

    try {
      const { rows } = await pool.query(
        'SELECT * FROM usuarios WHERE email = $1 AND ativo = true',
        [email.trim().toLowerCase()]
      );
      const usuario = rows[0];

      if (!usuario || !(await bcrypt.compare(senha, usuario.senha_hash)))
        return res.status(401).json({ erro: 'Credenciais inválidas.' });

      await pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [usuario.id]);

      const token = jwt.sign(
        { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
      );

      res.json({
        token,
        usuario: { id: usuario.id, nome: usuario.nome, perfil: usuario.perfil, email: usuario.email },
      });
    } catch (err) {
      console.error('[auth/login]', err.message);
      res.status(500).json({ erro: 'Erro interno no servidor.' });
    }
  });

  // ── GET /auth/me ─────────────────────────────────────────
  router.get('/me', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, nome, email, perfil, ultimo_acesso FROM usuarios WHERE id = $1',
        [req.usuario.id]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'Usuário não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: 'Erro interno.' });
    }
  });

  // ── GET /auth/usuarios ───────────────────────────────────
  router.get('/usuarios', autenticar(['admin']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, nome, email, perfil, ativo, ultimo_acesso, criado_em FROM usuarios ORDER BY nome'
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar usuários.' });
    }
  });

  // ── POST /auth/usuarios ──────────────────────────────────
  router.post('/usuarios', autenticar(['admin']), async (req, res) => {
    const { nome, email, senha, perfil } = req.body;
    if (!nome || !email || !senha || !perfil)
      return res.status(400).json({ erro: 'nome, email, senha e perfil são obrigatórios.' });

    const perfisValidos = ['admin','gerente','financeiro','estoque','operacao'];
    if (!perfisValidos.includes(perfil))
      return res.status(400).json({ erro: 'Perfil inválido.' });

    try {
      const hash = await bcrypt.hash(senha, 12);
      const { rows } = await pool.query(
        `INSERT INTO usuarios (nome, email, senha_hash, perfil)
         VALUES ($1, $2, $3, $4) RETURNING id, nome, email, perfil`,
        [nome.trim(), email.trim().toLowerCase(), hash, perfil]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ erro: 'Email já cadastrado.' });
      console.error('[auth/usuarios POST]', err.message);
      res.status(500).json({ erro: 'Erro ao criar usuário.' });
    }
  });

  // ── PUT /auth/usuarios/:id ───────────────────────────────
  router.put('/usuarios/:id', autenticar(['admin']), async (req, res) => {
    const { nome, email, perfil, ativo, senha } = req.body;
    const id = parseInt(req.params.id);

    // CORRIGIDO: validação do ID antes de usar no banco
    if (!id || isNaN(id)) {
      return res.status(400).json({ erro: 'ID de usuário inválido.' });
    }

    try {
      if (senha) {
        const hash = await bcrypt.hash(senha, 12);
        await pool.query(
          `UPDATE usuarios SET nome=$1, email=$2, perfil=$3, ativo=$4, senha_hash=$5, atualizado_em=NOW() WHERE id=$6`,
          [nome, email?.toLowerCase(), perfil, ativo, hash, id]
        );
      } else {
        await pool.query(
          `UPDATE usuarios SET nome=$1, email=$2, perfil=$3, ativo=$4, atualizado_em=NOW() WHERE id=$5`,
          [nome, email?.toLowerCase(), perfil, ativo, id]
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[auth/usuarios PUT]', err.message);
      res.status(500).json({ erro: 'Erro ao atualizar usuário.' });
    }
  });

  return router;
};
