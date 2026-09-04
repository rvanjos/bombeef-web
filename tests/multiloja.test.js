const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  listarLojasDoUsuario,
  resolverLojaDoUsuario,
  contextoLojaPublico,
  payloadComLoja,
} = require('../lib/multiloja');
const { executarNaLoja, lojaAtual, protegerPoolPorLoja } = require('../lib/tenant-context');

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

  const contextos = await Promise.all([
    executarNaLoja(1, async () => { await Promise.resolve(); return lojaAtual(); }),
    executarNaLoja(2, async () => { await Promise.resolve(); return lojaAtual(); }),
  ]);
  assert.deepEqual(contextos, [1, 2]);
  assert.equal(lojaAtual(), null);

  const comandos = [];
  const fakeClient = {
    async query(sql, params) { comandos.push({ sql, params }); return { rows: [{ ok: true }] }; },
    release() { comandos.push({ sql: 'RELEASE' }); },
  };
  const fakePool = {
    async connect() { return fakeClient; },
    async query(sql, params) { comandos.push({ sql: 'POOL:'+sql, params }); return { rows: [] }; },
  };
  protegerPoolPorLoja(fakePool);
  await executarNaLoja(8, () => fakePool.query('SELECT * FROM produtos'));
  assert.equal(comandos[0].params[0], '8');
  assert.equal(comandos[1].sql, 'SELECT * FROM produtos');
  assert.match(comandos[2].sql, /set_config/);
  assert.equal(comandos[3].sql, 'RELEASE');

  const migracao = fs.readFileSync(path.join(__dirname, '../lib/multiloja.js'), 'utf8');
  for (const tabela of ['boletos','dre_sessoes','dre_lancamentos','faturamento_periodos','cartao_faturas','cartao_fatura_itens']) {
    assert.match(migracao, new RegExp(`['"]${tabela}['"]`));
  }
  assert.match(migracao, /FORCE ROW LEVEL SECURITY/);
  assert.match(migracao, /uq_faturamento_dia_loja/);
  assert.match(migracao, /idx_cf_hash_loja/);
  for (const tabela of ['kits','kit_pedidos','cortes_registros','retiradas','clientes_fiado','vendas_fiado','vendas_produto']) {
    assert.match(migracao, new RegExp(`['"]${tabela}['"]`));
  }
  assert.match(migracao, /2026-09-producao-comercial-v1/);
  assert.match(migracao, /uq_kit_pedidos_loja_numero/);
  assert.match(migracao, /uq_clientes_fiado_loja_func/);
  for (const tabela of ['funcionarios','rh_fichas','rh_apontamentos','rh_escalas','ponto_registros','ponto_auditoria','ponto_jornada_dia','login_sessoes']) {
    assert.match(migracao, new RegExp(`['"]${tabela}['"]`));
  }
  assert.match(migracao, /2026-09-pessoas-v1/);
  assert.match(migracao, /uq_ponto_loja_func_data/);
  assert.match(migracao, /uq_rh_meta_fds_loja/);

  console.log('multiloja: testes concluídos');
})().catch(erro => {
  console.error(erro);
  process.exitCode = 1;
});
