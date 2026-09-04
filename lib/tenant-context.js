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

  pool.connect = async function conexaoComLoja(...args) {
    const client = await conectarOriginal(...args);
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
    client.release = () => {
      client.query = queryOriginal;
      return queryOriginal('ROLLBACK').catch(() => {})
        .then(() => queryOriginal(`SELECT set_config('app.loja_id','',false)`))
        .catch(() => {})
        .finally(() => releaseOriginal());
    };
    return client;
  };
  return pool;
}

module.exports = { executarNaLoja, lojaAtual, protegerPoolPorLoja };
