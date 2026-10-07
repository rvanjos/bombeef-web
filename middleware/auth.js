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
const { executarNaLoja } = require('../lib/tenant-context');

let poolAutenticacao=null;
function configurarPool(pool){poolAutenticacao=pool;}

const PERFIS_ORDEM = ['contabil', 'caixa', 'estoque', 'financeiro', 'gestor', 'admin'];

function autenticar(perfisPermitidos = null) {
  return async (req, res, next) => {
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
    if (!Number.isSafeInteger(Number(payload.lojaId)) || Number(payload.lojaId)<=0) {
      return res.status(401).json({ ok: false, erro: 'Sessão anterior à implantação multi-loja. Renove o acesso.' });
    }

    // Injeta dados do usuário no request (ambos req.user e req.usuario para compatibilidade)
    req.user = {
      id:     payload.id,
      nome:   payload.nome,
      email:  payload.email,
      perfil: payload.perfil,
      sessaoId: payload.sessaoId || null,
      lojaId: payload.lojaId || null,
      lojaCodigo: payload.lojaCodigo || null,
      empresaId: payload.empresaId || null,
      vinculoLojaId: payload.vinculoLojaId || null,
    };
    req.usuario = req.user; // alias — algumas rotas usam req.usuario

    return executarNaLoja(req.user.lojaId,async()=>{
      if(!poolAutenticacao)return res.status(503).json({ok:false,erro:'Autenticação inicializando. Tente novamente.'});
      try{
        const {rows}=await poolAutenticacao.query(`SELECT ul.perfil,ul.permissoes
          FROM usuario_lojas ul JOIN usuarios u ON u.id=ul.usuario_id AND u.ativo=true
          JOIN lojas l ON l.id=ul.loja_id AND l.ativa=true AND l.pronta_operacao=true
          JOIN empresas e ON e.id=l.empresa_id AND e.ativa=true
          WHERE ul.usuario_id=$1 AND ul.loja_id=$2 AND ul.ativo=true
            AND ($3::bigint IS NULL OR ul.id=$3)
            AND ($4::bigint IS NULL OR EXISTS(SELECT 1 FROM login_sessoes s
              WHERE s.id=$4 AND s.usuario_id=u.id AND s.loja_id=l.id AND s.encerrado_em IS NULL))`,
          [req.user.id,req.user.lojaId,req.user.vinculoLojaId,req.user.sessaoId]);
        if(!rows.length)return res.status(401).json({ok:false,erro:'Acesso à loja ou sessão encerrado. Entre novamente.'});
        req.user.perfil=rows[0].perfil;req.user.permissoes=rows[0].permissoes||{};
        if(perfisPermitidos){
          const permitidos=Array.isArray(perfisPermitidos)?perfisPermitidos:[perfisPermitidos];
          if(!permitidos.includes(req.user.perfil))return res.status(403).json({ok:false,erro:'Acesso negado. Perfil necessário: '+permitidos.join(' ou ')});
        }
        return next();
      }catch(e){return res.status(503).json({ok:false,erro:'Não foi possível validar o acesso à loja. Tente novamente.'});}
    });
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

module.exports.configurarPool=configurarPool;
