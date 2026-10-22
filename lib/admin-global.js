'use strict';
// Administração de identidades e lojas afeta toda a instalação, não só a loja ativa.
function exigirAdminGlobal(pool) {
  return async (req, res, next) => {
    try {
      const { rows } = await pool.query("SELECT id FROM usuarios WHERE id=$1 AND ativo=true AND perfil='admin'", [req.user.id]);
      if (!rows.length) return res.status(403).json({ ok: false, erro: 'Esta operação exige administrador geral do sistema' });
      return next();
    } catch (_) {
      return res.status(503).json({ ok: false, erro: 'Não foi possível validar a permissão administrativa' });
    }
  };
}
module.exports = { exigirAdminGlobal };
