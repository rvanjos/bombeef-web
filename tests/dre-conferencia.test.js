'use strict';

const assert = require('assert');
const DREConferencia = require('../public/js/dre-conferencia.js');

const giroOriginal = {
  id: '1784577143607_0.38684793821594665',
  data: '2026-07-20',
  mes: '07/2026',
  mesCaixa: '07/2026',
  fonte: 'EXTRATO',
  lancamento: 'PARCELA GIRO  23/48',
  valor: -2535.38,
  categoria: 'Empréstimo'
};

const giroReimportado = {
  ...giroOriginal,
  id: '1785267170341_0.5765614766540783',
  lancamento: 'PARCELA GIRO    23/48'
};

const analiseGiro = DREConferencia.analisar([giroOriginal, giroReimportado]);
assert.strictEqual(analiseGiro.reimportacoes.length, 1, 'deve detectar o giro reimportado mesmo com espaços diferentes');
assert.strictEqual(analiseGiro.reimportacoes[0].quantidade, 2);
assert.strictEqual(analiseGiro.reimportacoes[0].impactoPotencial, 2535.38);
assert.strictEqual(analiseGiro.pagamentosParecidos.length, 0, 'não deve repetir a ocorrência também como pagamento parecido');
assert.strictEqual(analiseGiro.reimportacoes[0].transacoes[0].entradaEm, '2026-07-20T19:52:23.607Z');

const analiseIgnorado = DREConferencia.analisar([giroOriginal, {...giroReimportado, ignorar: true}]);
assert.strictEqual(analiseIgnorado.reimportacoes[0].impactoPotencial, 0, 'registro já ignorado não deve compor impacto potencial');

const pagamentosProximos = DREConferencia.analisar([
  {id:'a', data:'2026-08-01', fonte:'EXTRATO', lancamento:'BOLETO', razaoSocial:'Fornecedor Teste Ltda', valor:-500},
  {id:'b', data:'2026-08-03', fonte:'OFX', lancamento:'PAGAMENTO FORNECEDOR', razaoSocial:'Fornecedor Teste Ltda', valor:-500}
]);
assert.strictEqual(pagamentosProximos.reimportacoes.length, 0);
assert.strictEqual(pagamentosProximos.pagamentosParecidos.length, 1, 'deve separar pagamentos apenas parecidos');

const conciliacao = DREConferencia.analisar([
  {id:'c', data:'2026-08-05', fonte:'EXTRATO', lancamento:'BOLETO', valor:-300, boletoId:77, mes:'08/2026'},
  {id:'d', data:'2026-08-06', fonte:'EXTRATO', lancamento:'FATURA', valor:-900, faturaCC:'CC_08_2026', vinculadoFaturaCC:true, mes:'08/2026'},
  {id:'e', data:'2026-08-07', fonte:'MANUAL', lancamento:'Ajuste', valor:-1, mes:'.9/4605'}
]);
assert.strictEqual(conciliacao.conciliacoes.length, 2);
assert.strictEqual(conciliacao.mesesInvalidos.length, 1);
assert.strictEqual(conciliacao.mesesInvalidos[0].valor, '.9/4605');

assert.strictEqual(DREConferencia.normalizarTexto('  Parcela  Giro   23/48 '), 'PARCELA GIRO 23/48');

const categorias = DREConferencia.analisar([
  {id:'f1', data:'2026-07-01', mes:'07/2026', fonte:'EXTRATO', razaoSocial:'Fornecedor Único', lancamento:'Compra 1', categoria:'Suíno', valor:-100},
  {id:'f2', data:'2026-07-02', mes:'07/2026', fonte:'EXTRATO', razaoSocial:'FORNECEDOR UNICO', lancamento:'Compra 2', categoria:'Bovino', valor:-200},
  {id:'f3', data:'2026-08-02', mes:'08/2026', fonte:'EXTRATO', razaoSocial:'Fornecedor Único', lancamento:'Compra 3', categoria:'Bovino', valor:-300}
]);
assert.strictEqual(categorias.categoriasInconsistentes.length, 1, 'deve apontar fornecedor em categorias diferentes no mesmo mês');
assert.deepStrictEqual(categorias.categoriasInconsistentes[0].categorias, ['Bovino', 'Suíno']);

console.log('dre-conferencia.test.js: OK');
