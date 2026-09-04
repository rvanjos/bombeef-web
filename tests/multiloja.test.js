const assert = require('node:assert/strict');
const {
  listarLojasDoUsuario,
  resolverLojaDoUsuario,
  contextoLojaPublico,
  payloadComLoja,
} = require('../lib/multiloja');

const lojas = [
  {
    vinculo_id: 10,
    perfil: 'admin',
    permissoes: {},
    principal: true,
    loja_id: 1,
    loja_codigo: 'valinhos',
    loja_nome: 'Bom Beef Valinhos',
    timezone: 'America/Sao_Paulo',
    empresa_id: 1,
    empresa_codigo: 'ar-boutique-carnes',
    empresa_nome: 'AR Boutique de Carnes LTDA',
  },
  {
    vinculo_id: 11,
    perfil: 'gestor',
    permissoes: {},
    principal: false,
    loja_id: 2,
    loja_codigo: 'segunda-loja',
    loja_nome: 'Segunda Loja',
    timezone: 'America/Sao_Paulo',
    empresa_id: 1,
    empresa_codigo: 'ar-boutique-carnes',
    empresa_nome: 'AR Boutique de Carnes LTDA',
  },
];

const pool = {
  async query(_sql, params) {
    assert.deepEqual(params, [7]);
    return { rows: lojas };
  },
};

(async () => {
  const lista = await listarLojasDoUsuario(pool, 7);
  assert.equal(lista.length, 2);

  const principal = await resolverLojaDoUsuario(pool, 7);
  assert.equal(principal.loja_codigo, 'valinhos');

  const segunda = await resolverLojaDoUsuario(pool, 7, 2);
  assert.equal(segunda.perfil, 'gestor');

  const negada = await resolverLojaDoUsuario(pool, 7, 999);
  assert.equal(negada, null);

  const publica = contextoLojaPublico(principal);
  assert.deepEqual(publica, {
    id: 1,
    codigo: 'valinhos',
    nome: 'Bom Beef Valinhos',
    timezone: 'America/Sao_Paulo',
    empresa: { id: 1, codigo: 'ar-boutique-carnes', nome: 'AR Boutique de Carnes LTDA' },
  });

  const payload = payloadComLoja(
    { id: 7, nome: 'Admin', email: 'admin@teste.com', perfil: 'admin' },
    55,
    segunda
  );
  assert.equal(payload.lojaId, 2);
  assert.equal(payload.vinculoLojaId, 11);
  assert.equal(payload.perfil, 'gestor');
  assert.equal(payload.sessaoId, 55);

  console.log('multiloja: testes concluídos');
})().catch(erro => {
  console.error(erro);
  process.exitCode = 1;
});
