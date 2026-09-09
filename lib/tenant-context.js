'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();
let modoEstrito = false;

function executarNaLoja(lojaId, callback) {
  const id = Number(lojaId) || null;
  if (!id) throw new Error('Contexto de loja obrigatório');
  modoEstrito = true;
  return storage.run({ lojaId: id, sistema: false }, callback);
}

function executarComoSistema(callback) {
  return storage.run({ lojaId: null, sistema: true }, callback);
}

function lojaAtual() {
  return storage.getStore()?.lojaId || null;
}

function contextoAtual() {
  const ctx = storage.getStore();
  if (ctx?.sistema) return { lojaId: null, sistema: true };
  if (ctx?.lojaId) return { lojaId: Number(ctx.lojaId), sistema: false };
  return { lojaId: null, sistema: !modoEstrito };
}

function protegerPoolPorLoja(pool) {
  if (pool.__bbTenantProtected) return pool;
  pool.__bbTenantProtected = true;

  const conectarOriginal = pool.connect.bind(pool);

  async function aplicarContexto(queryOriginal, cache = {}) {
    const ctx = contextoAtual();
    const chave = `${ctx.sistema ? 1 : 0}:${ctx.lojaId || ''}`;
    if (cache.chave === chave) return;

    await queryOriginal(`SELECT set_config('app.bb_system',$1,false)`, [ctx.sistema ? '1' : '0']);
    await queryOriginal(`SELECT set_config('app.loja_id',$1,false)`, [ctx.lojaId ? String(ctx.lojaId) : '']);
    cache.chave = chave;
  }

  async function limparContexto(queryOriginal) {
    await queryOriginal(`SELECT set_config('app.loja_id','',false)`).catch(() => {});
    await queryOriginal(`SELECT set_config('app.bb_system','',false)`).catch(() => {});
  }

  async function prepararClient(client) {
    if (!client || typeof client.query !== 'function') return client;
    if (client.__bbTenantWrapped) return client;

    client.__bbTenantWrapped = true;
    const queryOriginal = client.query.bind(client);
    const releaseOriginal = client.release.bind(client);
    const cache = { chave: null };

    client.query = async (...queryArgs) => {
      await aplicarContexto(queryOriginal, cache);
      return queryOriginal(...queryArgs);
    };

    client.release = (...releaseArgs) => {
      Promise.resolve()
        .then(() => queryOriginal('ROLLBACK'))
        .catch(() => {})
        .then(() => limparContexto(queryOriginal))
        .finally(() => {
          client.query = queryOriginal;
          client.release = releaseOriginal;
          client.__bbTenantWrapped = false;
          releaseOriginal(...releaseArgs);
        });
    };

    return client;
  }

  pool.query = async function consultaComContexto(...args) {
    const client = await conectarOriginal();
    const queryOriginal = client.query.bind(client);
    try {
      await aplicarContexto(queryOriginal, { chave: null });
      return await queryOriginal(...args);
    } finally {
      await limparContexto(queryOriginal);
      client.release();
    }
  };

  // Compatível tanto com `await pool.connect()` quanto com `pool.connect(callback)`.
  pool.connect = function conexaoComContexto(...args) {
    const ultimo = args[args.length - 1];
    if (typeof ultimo === 'function') {
      const callback = args.pop();
      return conectarOriginal(...args, (err, client) => {
        if (err) return callback(err);
        prepararClient(client)
          .then(clientPreparado => callback(null, clientPreparado, (...doneArgs) => clientPreparado.release(...doneArgs)))
          .catch(callback);
      });
    }
    return conectarOriginal(...args).then(prepararClient);
  };

  return pool;
}

module.exports = {
  executarNaLoja,
  executarComoSistema,
  lojaAtual,
  contextoAtual,
  protegerPoolPorLoja,
};
