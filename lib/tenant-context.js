'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();

function executarNaLoja(lojaId, callback) {
  return storage.run({ lojaId: Number(lojaId) || null }, callback);
}

function lojaAtual() {
  return storage.getStore()?.lojaId || null;
}

function protegerPoolPorLoja(pool) {
  if (pool.__bbTenantProtected) return pool;
  pool.__bbTenantProtected = true;

  const conectarOriginal = pool.connect.bind(pool);
  const consultarOriginal = pool.query.bind(pool);

  async function prepararClient(client) {
    if (!client || typeof client.query !== 'function') return client;
    if (client.__bbTenantWrapped) return client;

    client.__bbTenantWrapped = true;
    const queryOriginal = client.query.bind(client);
    const releaseOriginal = client.release.bind(client);
    let contextoAplicado = null;

    client.query = async (...queryArgs) => {
      const lojaId = lojaAtual();
      if (lojaId && contextoAplicado !== lojaId) {
        await queryOriginal(`SELECT set_config('app.loja_id',$1,false)`, [String(lojaId)]);
        contextoAplicado = lojaId;
      }
      return queryOriginal(...queryArgs);
    };

    client.release = (...releaseArgs) => {
      // A limpeza é assíncrona, mas nunca pode impedir a devolução do client ao pool.
      Promise.resolve()
        .then(() => queryOriginal('ROLLBACK'))
        .catch(() => {})
        .then(() => queryOriginal(`SELECT set_config('app.loja_id','',false)`))
        .catch(() => {})
        .finally(() => {
          client.query = queryOriginal;
          client.release = releaseOriginal;
          client.__bbTenantWrapped = false;
          releaseOriginal(...releaseArgs);
        });
    };

    return client;
  }

  pool.query = async function consultaComLoja(...args) {
    const lojaId = lojaAtual();
    if (!lojaId) return consultarOriginal(...args);
    const client = await conectarOriginal();
    try {
      await client.query(`SELECT set_config('app.loja_id',$1,false)`, [String(lojaId)]);
      return await client.query(...args);
    } finally {
      await client.query(`SELECT set_config('app.loja_id','',false)`).catch(() => {});
      client.release();
    }
  };

  // Compatível tanto com `await pool.connect()` quanto com `pool.connect(callback)`.
  pool.connect = function conexaoComLoja(...args) {
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

module.exports = { executarNaLoja, lojaAtual, protegerPoolPorLoja };
