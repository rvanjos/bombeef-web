const assert = require('assert');
const { acharCabecalho, interpretarLinhasFinanceiras } = require('../lib/cartao-caixa-pdf-v3');

function tok(str,x,y){ return {str,transform:[1,0,0,1,x,y]}; }
function linha(textos,y){
  let x=300;
  const tokens=textos.map(t=>{ const o={texto:t,x,y,idx:x}; x+=Math.max(14,t.length*4); return o; });
  return {y,tokens,texto:textos.join(' ')};
}

const pagina1 = [
  tok('cartões',20,800),tok('CAIXA',70,800),tok('VENCIMENTO',390,760),tok('12/01/2026',470,760),
  tok('VALOR',350,730),tok('TOTAL',390,730),tok('DESTA',430,730),tok('FATURA',470,730),tok('R$',520,730),tok('13.266,54',540,730),
  tok('4219.XXXX.XXXX.9284',20,820)
];
const cab = acharCabecalho([pagina1]);
assert.equal(cab.ok,true);
assert.equal(cab.competencia,'01/2026');
assert.equal(cab.vencimento,'2026-01-12');
assert.equal(cab.valor_total_fatura,13266.54);
assert.equal(cab.primeiro_final,'9284');

const linhas = [
  linha(['Demonstrativo'],700),
  linha(['02/12','TOTAL','DA','FATURA','ANTERIOR','17.402,07D'],690),
  linha(['12/12','OBRIGADO','PELO','PAGAMENTO','17.402,07C'],680),
  linha(['02/01','CASHBACK','ANUIDADE','GASTOS','TIT','6,90C'],670),
  linha(['24/11','PAYU','*Marfrig','Sao','Paulo','2.829,55C'],660),
  linha(['RAFAEL','TESTE','(Cartão','9284)'],650),
  linha(['ANUIDADE'],640),
  linha(['ANUIDADE','DIFERENCIADA','TIT','04/','12','6,90D'],630),
  linha(['COMPRAS','(Cartão','9284)'],620),
  linha(['06/12','TENDA','ATACADO','S','A','CAMPINAS','10,75D'],610),
  linha(['08/12','MARAVILHAS','DO','LAR','CAMPINAS','15,96D'],600),
  linha(['16/12','MINEIROS','EMBALAGENS','CAMPINAS','101,96D'],590),
  linha(['16/12','CLUBE','DA','PICANHA','SUMARE','4.656,71D'],580),
  linha(['22/12','Amazon','Kindle','Unltd','SAO','PAULO','24,90D'],570),
  linha(['26/12','MP*NOVAATACADO','OSASCO','109,47D'],560),
  linha(['27/12','MP*NOVAATACADO','OSASCO','218,94D'],550),
  linha(['COMPRAS','PARCELADAS','(Cartão','9284)'],540),
  linha(['21/11','JIM.COM','ANNA','CAROLINA','ALO','02','DE','02','SANTOS','725,19D'],530),
  linha(['RAFAEL','TESTE','(Cartão','7954)'],520),
  linha(['ANUIDADE'],510),
  linha(['ANUIDADE','0,00D'],500),
  linha(['COMPRAS','(Cartão','7954)'],490),
  linha(['04/12','PAYU','*Marfrig','Sao','Paulo','1.422,63D'],480),
  linha(['06/12','JUSBRASIL','SALVADOR','39,90D'],470),
  linha(['10/12','PRIME','CATER','COMERCIAL','SAO','PAULO','7.593,82D'],460),
  linha(['COMPRAS','PARCELADAS','(Cartão','7954)'],450),
  linha(['24/06','AUTOMACAO','2000','07','DE','12','SAO','BERNARDO','510,00D'],440),
  linha(['04/11','MP*GREYCOMLTDA','02','DE','07','CAMPINAS','87,00D'],430),
  linha(['12/11','V4','COMPANY','02','DE','04','SAO','LEOPOLDO','534,00D'],420),
  linha(['11/12','ASSIST','CARD','01','DE','02','SAO','PAULO','25,63D'],410),
  linha(['11/12','ASSIST','CARD','01','DE','04','SAO','PAULO','19,23D'],400)
];

const cartoes = interpretarLinhasFinanceiras(linhas,cab);
assert.equal(cartoes.length,2);
assert.equal(cartoes.reduce((s,c)=>s+c.qtd_itens,0),20);
assert.equal(cartoes.find(c=>c.final==='9284').valor_total,3034.33);
assert.equal(cartoes.find(c=>c.final==='7954').valor_total,10232.21);
assert.equal(Number(cartoes.reduce((s,c)=>s+c.valor_total,0).toFixed(2)),13266.54);
const todos = cartoes.flatMap(c=>c.itens);
assert.ok(todos.some(i=>i.valor<0));
assert.ok(todos.some(i=>i.movimento==='CASHBACK' && i.efeito==='ABATE_FATURA'));
assert.ok(todos.some(i=>i.movimento==='ANUIDADE' && i.efeito==='AUMENTA_FATURA'));
assert.ok(!todos.some(i=>/FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(i.descricao)));

// Cobrança e desconto de mesmo valor devem coexistir; nunca podem sumir por dedupe.
const ajuste = interpretarLinhasFinanceiras([
  linha(['ANUIDADE','10,00D'],100),
  linha(['DESCONTO','ANUIDADE','10,00C'],90)
],{...cab,primeiro_final:'9284'});
assert.equal(ajuste[0].qtd_itens,2);
assert.equal(ajuste[0].valor_total,0);
assert.equal(ajuste[0].itens[0].movimento,'ANUIDADE');
assert.equal(ajuste[0].itens[1].movimento,'DESCONTO');
assert.equal(ajuste[0].itens[0].efeito,'AUMENTA_FATURA');
assert.equal(ajuste[0].itens[1].efeito,'ABATE_FATURA');

console.log('cartao-caixa-pdf-v3.test.js: OK');
