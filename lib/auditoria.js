'use strict';

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
  for (const [chave, item] of Object.entries(valor)) {
    if (CAMPOS_SENSIVEIS.has(chave.toLowerCase())) saida[chave] = '[PROTEGIDO]';
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
      erro           TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_data ON auditoria_eventos(criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_modulo ON auditoria_eventos(modulo, criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_usuario ON auditoria_eventos(usuario_id, criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_acao ON auditoria_eventos(acao, criado_em DESC)`);
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
         request_id, sucesso, status_http, erro)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
    ]);
  } catch (e) {
    console.error('[auditoria] falha ao registrar evento:', e.message);
  }
}

function middleware(pool) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.originalUrl?.startsWith('/api/auditoria')) return next();
    if (req.originalUrl?.startsWith('/auth/heartbeat') || req.originalUrl?.startsWith('/auth/refresh')) return next();

    const inicio = Date.now();
    const originalJson = res.json.bind(res);
    let respostaJson = null;
    res.json = body => {
      respostaJson = body;
      return originalJson(body);
    };
    res.once('finish', () => {
      const entidadeId = req.params?.id || respostaJson?.id || respostaJson?.data?.id || respostaJson?.sessao_id || null;
      setImmediate(() => registrar(pool, {
        usuario_id: req.user?.id || respostaJson?.usuario?.id,
        usuario_nome: req.user?.nome || respostaJson?.usuario?.nome,
        usuario_perfil: req.user?.perfil || respostaJson?.usuario?.perfil,
        modulo: moduloDaRota(req.originalUrl),
        acao: acaoDoMetodo(req.method, req.originalUrl),
        entidade: moduloDaRota(req.originalUrl),
        entidade_id: entidadeId,
        rota: req.originalUrl,
        metodo: req.method,
        dados_depois: { entrada: limpar(req.body), resposta: limpar(respostaJson), duracao_ms: Date.now() - inicio },
        justificativa: req.body?.justificativa || req.body?.motivo || req.body?.observacao || null,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        request_id: req.headers['x-request-id'],
        sucesso: res.statusCode < 400 && respostaJson?.ok !== false,
        status_http: res.statusCode,
        erro: res.statusCode >= 400 || respostaJson?.ok === false ? (respostaJson?.erro || respostaJson?.message || 'Operação recusada') : null,
      }));
    });
    next();
  };
}

module.exports = { init, registrar, middleware, limpar };
