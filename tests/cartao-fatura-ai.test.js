const assert = require('assert');
const { normalizarRespostaIa } = require('../lib/cartao-fatura-ai');

const r = normalizarRespostaIa({
  banco:'CAIXA', competencia:'01/2026', vencimento:'2026-01-12', valor_total_fatura:13266.54,
  cartoes:[
    { final:'9284', cartao:'Caixa final 9284', itens:[
      {data_original:'02/01',descricao:'CASHBACK ANUIDADE GASTOS TIT',valor:6.90,tipo:'CASHBACK'},
      {data_original:'24/11',descricao:'PAYU *Marfrig Sao Paulo',valor:2829.55,tipo:'CREDITO'},
      {descricao:'ANUIDADE DIFERENCIADA TIT 04/12',valor:6.90,tipo:'DEBITO',parcela_atual:4,parcelas_total:12},
      {data_original:'16/12',descricao:'CLUBE DA PICANHA SUMARE',valor:4656.71,tipo:'DEBITO'},
      {data_original:'21/11',descricao:'JIM.COM ANNA CAROLINA ALO',valor:1207.17,tipo:'DEBITO',parcela_atual:2,parcelas_total:2}
    ]},
    { final:'7954', cartao:'Caixa final 7954', itens:[
      {data_original:'10/12',descricao:'PRIME CATER COMERCIAL SAO PAULO',valor:7593.82,tipo:'DEBITO'},
      {data_original:'12/11',descricao:'V4 COMPANY',valor:534.00,tipo:'DEBITO',parcela_atual:2,parcelas_total:4},
      {data_original:'11/12',descricao:'ASSIST CARD',valor:97.39,tipo:'DEBITO',parcela_atual:1,parcelas_total:2}
    ]}
  ]
}, 'Fatura 01-2026.pdf');

assert.equal(r.ok,true);
assert.equal(r.cartoes.length,2);
assert.equal(r.cartoes[0].itens[0].valor,-6.90);
assert.equal(r.cartoes[0].itens[1].valor,-2829.55);
assert.equal(r.valor_total_fatura,13266.54);
assert.equal(r.conferencia_ok,true);
assert.equal(r.diferenca,0);
assert.equal(r.metodo_extracao, undefined);
console.log('cartao-fatura-ai.test.js: OK');
