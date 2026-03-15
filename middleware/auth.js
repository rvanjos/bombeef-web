/**
 * middleware/auth.js
 * Verificação de token JWT em todas as rotas protegidas.
 *
 * Uso:
 *   const autenticar = require('../middleware/auth');
 *   router.use(autenticar());
 *   router.use(autenticar('admin'));          // só admin
 *   router.use(autenticar(['admin','gestor'])); // admin ou gestor
 */

const jwt = require('jsonwebtoken');

const PERFIS_ORDEM = ['caixa', 'estoque', 'financeiro', 'gestor', 'admin'];

function autenticar(perfisPermitidos = null) {
  return (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ ok: false, erro: 'Token não fornecido' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      const msg = e.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido';
      return res.status(401).json({ ok: false, erro: msg });
    }

    // Injeta dados do usuário no request
    req.user = {
      id:     payload.id,
      nome:   payload.nome,
      email:  payload.email,
      perfil: payload.perfil,
    };

    // Verifica perfil se exigido
    if (perfisPermitidos) {
      const permitidos = Array.isArray(perfisPermitidos)
        ? perfisPermitidos
        : [perfisPermitidos];

      if (!permitidos.includes(req.user.perfil)) {
        return res.status(403).json({
          ok: false,
          erro: `Acesso negado. Perfil necessário: ${permitidos.join(' ou ')}`,
        });
      }
    }

    next();
  };
}

/**
 * Verifica se o usuário tem nível igual ou superior ao exigido
 * Ex: requireNivel('gestor') → permite gestor e admin
 */
function requireNivel(nivelMinimo) {
  return (req, res, next) => {
    const idxUsuario = PERFIS_ORDEM.indexOf(req.user?.perfil);
    const idxMinimo  = PERFIS_ORDEM.indexOf(nivelMinimo);

    if (idxUsuario === -1 || idxUsuario < idxMinimo) {
      return res.status(403).json({
        ok: false,
        erro: `Acesso negado. Nível mínimo exigido: ${nivelMinimo}`,
      });
    }
    next();
  };
}

module.exports = autenticar;
module.exports.requireNivel = requireNivel;
