const jwt = require('jsonwebtoken');

/**
 * Middleware de autenticação JWT.
 * @param {string[]} perfisPermitidos  — lista de perfis aceitos; vazio = qualquer autenticado.
 */
function autenticar(perfisPermitidos = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido.' });
    }

    const token = header.split(' ')[1];
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.usuario = payload; // { id, nome, email, perfil }

      if (perfisPermitidos.length > 0 && !perfisPermitidos.includes(payload.perfil)) {
        return res.status(403).json({ erro: 'Sem permissão para esta operação.' });
      }
      next();
    } catch (err) {
      return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }
  };
}

module.exports = autenticar;
