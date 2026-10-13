const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(require.resolve('../public/dre.html'), 'utf8');
function extrair(nome) {
  const inicio = html.indexOf('function ' + nome + '(');
  const fim = html.indexOf('\nfunction ', inicio + 1);
  return html.slice(inicio, fim);
}
const ctx = vm.createContext({autoClassificar: () => 'Outros', Date});
vm.runInContext(extrair('converterPreviewCaixa'), ctx);
vm.runInContext(extrair('parseCCCaixaCSV'), ctx);
const cab = 'data;cartao_final;tipo;descricao;cidade;parcela;valor;natureza';
const csv = '\uFEFF' + cab + '\n' + [
  '08/09/2026;9835;Compra;FORNECEDOR;;;1.866,05;Débito',
  '03/09/2026;9284;Ajuste;AJUSTE CRED PARC S/ JUROS;;;0,08;Crédito',
  '01/10/2026;9284;Ajuste;AJUSTE CREDITO PARC;;;0,02;C',
  '12/10/2026;9284;Pagamento;OBRIGADO PELO PAGAMENTO;;;4.902,65;Crédito',
  '12/10/2026;9284;Resumo;TOTAL DA FATURA ANTERIOR;;;4.902,65;Débito',
  '12/10/2026;9284;Anuidade;ANUIDADE;;;0,00;Débito',
  '03/08/2026;9835;Compra;PARCELADA;;2/12;499.99;Débito'
].join('\n');
const itens = ctx.parseCCCaixaCSV(csv);
assert.equal(itens.length, 4);
assert.equal(itens[0].valor, -1866.05);
assert.equal(itens[1].valor, .08);
assert.equal(itens[2].valor, .02);
assert.equal(itens[3].valor, -499.99);
assert.equal(itens[3].parcela, '2/12');
const preview = {vencimento: '2026-10-12', competencia: '10/2026', cartoes: [{final: '9284', itens: [
  {hash_item: 'a', data_compra: '2026-09-03', descricao: 'AJUSTE', valor: -.08},
  {hash_item: 'b', descricao: 'ANUIDADE', valor: 6.90, parcela_atual: 1, parcelas_total: 12},
  {hash_item: 'c', descricao: 'ANUIDADE', valor: 0}
]}]};
const convertidos = ctx.converterPreviewCaixa(preview, '10/2026');
assert.equal(convertidos.length, 2);
assert.equal(convertidos[0].valor, .08);
assert.equal(convertidos[0].mes, '09/2026');
assert.equal(convertidos[0].mesCaixa, '10/2026');
assert.equal(convertidos[1].data, '2026-10-12');
assert.equal(convertidos[1].dataReferencia, true);
assert.equal(convertidos[1].parcela, '1/12');
assert.equal(convertidos[0].id, ctx.converterPreviewCaixa(preview, '10/2026')[0].id);
if (process.env.CAIXA_PDF_FIXTURE) {
  const {interpretarCaixaPdfV3} = require('../lib/cartao-caixa-pdf-v3');
  interpretarCaixaPdfV3(fs.readFileSync(process.env.CAIXA_PDF_FIXTURE), '', 'fixture.pdf').then(p => {
    assert.equal(p.ok, true);
    assert.equal(p.conferencia_ok, true);
    const l = ctx.converterPreviewCaixa(p, '10/2026');
    assert.equal(l.length, 8);
    assert.equal(Math.round(l.reduce((s,i) => s-i.valor, 0)*100), 285262);
    assert.equal(l.filter(i => i.valor > 0).length, 2);
    console.log('PDF real: 8 movimentos, créditos preservados e total conferido');
  }).catch(e => {console.error(e); process.exitCode = 1;});
}
console.log('dre-cartao-caixa-importacao.test.js: OK');
