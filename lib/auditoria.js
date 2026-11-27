'use strict';

const crypto=require('node:crypto');
const CAMPOS_SENSIVEIS = new Set([
  'senha', 'password', 'senha_hash', 'token', 'authorization', 'access_token',
  'refresh_token', 'secret', 'segredo', 'api_key', 'apikey',
]);

function limpar(valor, profundidade = 0) {
  if (profundidade > 5) return '[limite]';
  if (valor == null || typeof valor !== 'object') {
    return typeof valor === 'string' && valor.length > 2000 ? valor.slice(0, 2000) + '…' : valor;
  }
  if (Array.isArray(valor)) return valor.slice(0, 100).map(v => limpar(v, profundidade + 1));
  const saida = {};
  for (const [chave, item] of Object.entries(valor).slice(0,80)) {
    const normalizada=chave.toLowerCase().replace(/[^a-z0-9]/g,'');
    if (CAMPOS_SENSIVEIS.has(chave.toLowerCase()) || normalizada==='codigo' || /password|senha|secret|token|privatekey|apikey|databaseurl|authorization|cookie|emailcodigo|otp|verification|storagekey|base64/.test(normalizada)) saida[chave] = '[PROTEGIDO]';
    else saida[chave] = limpar(item, profundidade + 1);
  }
  return saida;
}

function moduloDaRota(path = '') {
  const partes = String(path).split('?')[0].split('/').filter(Boolean);
  if (partes[0] === 'api') return partes[1] || 'sistema';
  if (partes[0] === 'auth') return 'acessos';
  return partes[0] || 'sistema';
}

function acaoDoMetodo(method, path) {
  const p = String(path).toLowerCase();
  if(p.startsWith('/auth/login'))return 'LOGIN';
  if(p.startsWith('/auth/logout'))return 'LOGOUT';
  if(p.includes('/pagamentos/')&&p.endsWith('/correcao'))return 'CORRIGIR_PAGAMENTO';
  if(p.includes('/senha'))return 'ALTERAR_SENHA';
  if(p.includes('/usuarios/'))return 'ALTERAR_USUARIO';
  if (p.includes('aprovar')) return 'APROVAR';
  if (p.includes('rejeitar')) return 'REJEITAR';
  if (p.includes('import')) return 'IMPORTAR';
  if (p.includes('pagar') || p.includes('pago')) return 'MARCAR_PAGO';
  if (p.includes('reativar')) return 'REATIVAR';
  if (method === 'POST') return 'CRIAR';
  if (method === 'PUT' || method === 'PATCH') return 'ALTERAR';
  if (method === 'DELETE') return 'EXCLUIR';
  return method;
}

const initPromises = new WeakMap();

function init(pool) {
  if (initPromises.has(pool)) return initPromises.get(pool);
  const promise = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria_eventos (
      id             BIGSERIAL PRIMARY KEY,
      criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      usuario_id     INTEGER,
      usuario_nome   TEXT,
      usuario_perfil TEXT,
      modulo         TEXT NOT NULL,
      acao           TEXT NOT NULL,
      entidade       TEXT,
      entidade_id    TEXT,
      rota           TEXT,
      metodo         TEXT,
      dados_antes    JSONB,
      dados_depois   JSONB,
      justificativa  TEXT,
      ip_address     TEXT,
      user_agent     TEXT,
      request_id     TEXT,
      sucesso        BOOLEAN NOT NULL DEFAULT TRUE,
      status_http    INTEGER,
      erro           TEXT,
      loja_id        INTEGER NOT NULL DEFAULT bb_loja_padrao() REFERENCES lojas(id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_loja_data ON auditoria_eventos(loja_id,criado_em DESC,id DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_data ON auditoria_eventos(criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_modulo ON auditoria_eventos(modulo, criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_usuario ON auditoria_eventos(usuario_id, criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_acao ON auditoria_eventos(acao, criado_em DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria_dre_conflitos_resolvidos (
      id               BIGSERIAL PRIMARY KEY,
      mes_ref          TEXT NOT NULL,
      chave_fornecedor TEXT NOT NULL,
      categoria_atual  TEXT NOT NULL,
      decisao          TEXT NOT NULL DEFAULT 'MANTER',
      usuario_id       INTEGER,
      usuario_nome     TEXT,
      justificativa    TEXT,
      resolvido_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      loja_id          INTEGER NOT NULL DEFAULT bb_loja_padrao() REFERENCES lojas(id),
      UNIQUE (loja_id, mes_ref, chave_fornecedor, categoria_atual)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_conflitos_mes ON auditoria_dre_conflitos_resolvidos(mes_ref)`);
  })().catch(e => { initPromises.delete(pool); throw e; });
  initPromises.set(pool, promise);
  return promise;
}

async function registrar(pool, evento) {
  try {
    await init(pool);
    await pool.query(`
      INSERT INTO auditoria_eventos
        (usuario_id, usuario_nome, usuario_perfil, modulo, acao, entidade, entidade_id,
         rota, metodo, dados_antes, dados_depois, justificativa, ip_address, user_agent,
         request_id, sucesso, status_http, erro, loja_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,bb_loja_padrao()))
    `, [
      evento.usuario_id || null, evento.usuario_nome || null, evento.usuario_perfil || null,
      evento.modulo || 'sistema', evento.acao || 'EVENTO', evento.entidade || null,
      evento.entidade_id != null ? String(evento.entidade_id) : null,
      evento.rota || null, evento.metodo || null,
      evento.dados_antes ? JSON.stringify(limpar(evento.dados_antes)) : null,
      evento.dados_depois ? JSON.stringify(limpar(evento.dados_depois)) : null,
      evento.justificativa || null, evento.ip_address || null,
      String(evento.user_agent || '').slice(0, 500) || null, evento.request_id || null,
      evento.sucesso !== false, evento.status_http || null,
      evento.erro ? String(evento.erro).slice(0, 2000) : null,
      evento.loja_id || null,
    ]);
  } catch (e) {
    console.error('[auditoria] falha ao registrar evento:', e.message);
  }
}

function middleware(pool) {
  return (req, res, next) => {
    const mutacao=['POST','PUT','PATCH','DELETE'].includes(req.method);
    const rota=String(req.originalUrl||'').split('?')[0];
    const documento=req.method==='GET'&&/^\/api\/rh\/documentos\/\d+\/arquivo$/.test(rota);
    if(!rota.startsWith('/api/')&&!rota.startsWith('/auth/'))return next();
    if (mutacao&&rota.startsWith('/api/auditoria')) return next();
    if (req.originalUrl?.startsWith('/auth/heartbeat') || req.originalUrl?.startsWith('/auth/refresh')) return next();

    const inicio = Date.now();
    const originalJson = res.json.bind(res);
    let respostaJson = null;
    res.json = body => {
      respostaJson = body;
      return originalJson(body);
    };
    res.once('finish', () => {
      if(!mutacao&&!documento&&![401,403].includes(res.statusCode))return;
      const loja=req.user?.lojaId||respostaJson?.usuario?.loja?.id;
      if(!loja)return; // Não atribua acesso anônimo a uma loja arbitrária.
      const entidadeId = req.params?.id || respostaJson?.id || respostaJson?.data?.id || respostaJson?.sessao_id || rota.split('/').reverse().find(p=>/^\d+$/.test(p)) || null;
      setImmediate(() => registrar(pool, {
        usuario_id: req.user?.id || respostaJson?.usuario?.id,
        usuario_nome: req.user?.nome || respostaJson?.usuario?.nome,
        usuario_perfil: req.user?.perfil || respostaJson?.usuario?.perfil,
        loja_id:loja,
        modulo: moduloDaRota(req.originalUrl),
        acao: !mutacao?(documento&&res.statusCode<400?'VISUALIZAR_DOCUMENTO':'ACESSO_NEGADO'):respostaJson?.repetido?'REPETICAO_SEM_ALTERACAO':acaoDoMetodo(req.method,rota),
        entidade: moduloDaRota(req.originalUrl),
        entidade_id: entidadeId,
        rota,
        metodo: req.method,
        dados_antes:req.auditoria?.antes||null,
        dados_depois: { entrada: limpar(req.body), resposta: limpar(respostaJson), duracao_ms: Date.now() - inicio },
        justificativa: req.body?.justificativa || req.body?.motivo || req.body?.observacao || null,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        request_id:String(req.headers['x-request-id']||crypto.randomUUID()).slice(0,120),
        sucesso: res.statusCode < 400 && respostaJson?.ok !== false,
        status_http: res.statusCode,
        erro: res.statusCode >= 400 || respostaJson?.ok === false ? (respostaJson?.erro || respostaJson?.message || 'Operação recusada') : null,
      }));
    });
    next();
  };
}

module.exports = { init, registrar, middleware, limpar,acaoDoMetodo };
