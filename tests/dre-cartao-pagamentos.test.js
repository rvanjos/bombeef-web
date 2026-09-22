'use strict';
const assert=require('assert');
const C=require('../public/js/dre-cartao-pagamentos.js');

const itens=[
  {id:'cc1',fonte:'CC',faturaCC:'CC_06_2026_Itau',mes:'06/2026',bandeira:'Itaú Empresas',valor:-8000},
  {id:'cc2',fonte:'CC',faturaCC:'CC_06_2026_Itau',mes:'06/2026',bandeira:'Itaú Empresas',valor:107.21},
  {id:'cc3',fonte:'CC',faturaCC:'CC_06_2026_Caixa',mes:'06/2026',bandeira:'Caixa',valor:-1930.01}
];
const fats=C.faturasDosLancamentos(itens);
const itau=fats.find(f=>f.faturaId==='CC_06_2026_Itau');
assert.strictEqual(Number(itau.total.toFixed(2)),7892.79,'crédito da fatura deve abater o total');

let r=C.decidir({fonte:'EXTRATO',valor:-7892.79,mes:'06/2026',lancamento:'FATURAITAU EMPRESAS VS I'},fats);
assert.strictEqual(r.acao,'vincular','texto forte + total exato deve vincular');
assert.strictEqual(r.fatura.faturaId,'CC_06_2026_Itau');

r=C.decidir({fonte:'EXTRATO',valor:-1930.01,mes:'06/2026',lancamento:'BUSINESS 0502-9639'},fats);
assert.strictEqual(r.acao,'vincular','texto genérico deve vincular quando há uma única fatura com total exato no período');
assert.strictEqual(r.fatura.faturaId,'CC_06_2026_Caixa');

r=C.decidir({fonte:'EXTRATO',valor:-500,mes:'06/2026',lancamento:'PAGAMENTO FORNECEDOR X'},fats);
assert.strictEqual(r.acao,'nenhuma','pagamento comum não pode virar cartão sem evidência');

r=C.decidir({fonte:'EXTRATO',valor:-2500,mes:'06/2026',lancamento:'PAGAMENTO FATURA CARTAO ITAU'},[]);
assert.strictEqual(r.acao,'pendente','pagamento claramente de cartão sem fatura importada deve ficar neutro aguardando vínculo');

r=C.decidir({fonte:'EXTRATO',valor:-7892.79,mes:'06/2026',lancamento:'FATURAITAU EMPRESAS',categoria:'Fornecedor / Mercadorias'},fats);
assert.strictEqual(r.acao,'nenhuma','não deve sobrescrever categoria manual de outra natureza');

r=C.decidir({fonte:'EXTRATO',valor:-7892.79,mes:'06/2026',lancamento:'OUTRO',categoria:'Pagamento de Cartão'},fats);
assert.strictEqual(r.acao,'vincular','classificação antiga deve continuar reconhecida e convergir para a categoria canônica');

console.log('dre-cartao-pagamentos.test.js: OK');

const dbFats=C.faturasDoBanco([
  {id:11,fatura_id_ref:'DRIVE:file123:9284',competencia:'01/2026',bandeira:'CAIXA',valor_total:3034.33,itens_total:11,status:'CLASSIFICADA'},
  {id:12,fatura_id_ref:'DRIVE:file123:7954',competencia:'01/2026',bandeira:'CAIXA',valor_total:10232.21,itens_total:8,status:'CLASSIFICADA'}
]);
const grupo=dbFats.find(f=>f.grupoPagamento);
assert.ok(grupo,'faturas do mesmo PDF do Drive devem formar um grupo de pagamento');
assert.strictEqual(Number(grupo.total.toFixed(2)),13266.54,'grupo deve somar todos os cartões da fatura');
assert.deepStrictEqual(grupo.refs.sort(),['DRIVE:file123:7954','DRIVE:file123:9284'].sort());

r=C.decidir({fonte:'EXTRATO',valor:-13266.54,mes:'01/2026',lancamento:'PAGAMENTO FATURA CARTAO CAIXA'},dbFats);
assert.strictEqual(r.acao,'vincular','pagamento total deve vincular ao grupo completo da fatura');
assert.strictEqual(r.fatura.grupoPagamento,true);

const combinadas=C.combinarFaturas(itens,dbFats);
assert.ok(combinadas.some(f=>f.faturaId==='CC_06_2026_Itau'),'deve manter faturas já presentes no DRE');
assert.ok(combinadas.some(f=>f.grupoPagamento),'deve incluir faturas importadas pelo Agente Financeiro');

console.log('dre-cartao-pagamentos.test.js: integração Agente Financeiro OK');
