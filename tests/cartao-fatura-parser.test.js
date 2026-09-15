const assert = require('assert');
const { interpretarCaixa } = require('../lib/cartao-fatura-parser');
const { montarLinhasColuna } = require('../lib/pdf-layout-extractor');

const texto = `4219.XXXX.XXXX.9284
VENCIMENTO
12/01/2026
VALOR TOTAL DESTA FATURA
R$ 13.266,54
CARTÕES CAIXA - 00.360.305/0001-04
Demonstrativo
Data Descrição Cidade/País Valor U$$ Crédito/Débito
02/12 TOTAL DA FATURA ANTERIOR 17.402,07D
12/12 OBRIGADO PELO PAGAMENTO 17.402,07C
02/01 CASHBACK ANUIDADE GASTOS TIT 6,90C
24/11 PAYU *Marfrig Sao Paulo 2.829,55C
Total 2.836,45 C
RAFAEL VIEIRA DOS ANJOS (Cartão 9284)
ANUIDADE
Crédito/Débito R$
ANUIDADE DIFERENCIADA TIT 04/ 12 6,90D
COMPRAS (Cartão 9284)
Data Descrição Cidade/País Valor U$$ Crédito/Débito
06/12 TENDA ATACADO S A CAMPINAS 10,75D
08/12 MARAVILHAS DO LAR CAMPINAS 15,96D
16/12 MINEIROS EMBALAGENS CAMPINAS 101,96D
16/12 CLUBE DA PICANHA SUMARE 4.656,71D
22/12 Amazon Kindle Unltd SAO PAULO 24,90D
26/12 MP*NOVAATACADO OSASCO 109,47D
27/12 MP*NOVAATACADO OSASCO 218,94D
Total COMPRAS 5.138,69D
COMPRAS PARCELADAS (Cartão 9284)
21/11 JIM.COM ANNA CAROLINA ALO 02 DE 02 SANTOS 725,19D
Total COMPRAS PARCELADAS 725,19D
Total final (cartão 9284) 5.870,78D
RAFAEL VIEIRA DOS ANJOS (Cartão 7954)
ANUIDADE
ANUIDADE 0,00D
COMPRAS (Cartão 7954)
04/12 PAYU *Marfrig Sao Paulo 1.422,63D
06/12 JUSBRASIL SALVADOR 39,90D
10/12 PRIME CATER COMERCIAL SAO PAULO 7.593,82D
Total COMPRAS 9.056,35D
COMPRAS PARCELADAS (Cartão 7954)
24/06 AUTOMACAO 2000 07 DE 12 SAO BERNARDO 510,00D
04/11 MP*GREYCOMLTDA 02 DE 07 CAMPINAS 87,00D
12/11 V4 COMPANY 02 DE 04 SAO LEOPOLDO 534,00D
11/12 ASSIST CARD 01 DE 02 SAO PAULO 25,63D
11/12 ASSIST CARD 01 DE 04 SAO PAULO 19,23D
Total COMPRAS PARCELADAS 1.175,86D
Total final (cartão 7954) 10.232,21D
Valor total desta fatura R$ 13.266,54 D`;

function validar(p) {
  assert.equal(p.ok,true);
  assert.equal(p.competencia,'01/2026');
  assert.equal(p.vencimento,'2026-01-12');
  assert.equal(p.valor_total_fatura,13266.54);
  assert.equal(p.cartoes.length,2);
  assert.equal(p.conferencia_ok,true);
  assert.equal(p.diferenca,0);
  assert.equal(p.qtd_itens,20);
  assert.equal(p.cartoes.find(c=>c.final==='9284').valor_total,3034.33);
  assert.equal(p.cartoes.find(c=>c.final==='7954').valor_total,10232.21);
  assert.ok(p.cartoes[0].itens.some(i=>i.valor<0));
  assert.ok(!p.cartoes.flatMap(c=>c.itens).some(i=>/FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(i.descricao)));
}

validar(interpretarCaixa(texto,'Fatura 01-2026.pdf'));

const textoQuebrado = texto
  .replace('ANUIDADE DIFERENCIADA TIT 04/ 12 6,90D','ANUIDADE DIFERENCIADA TIT 04/ 126,90D')
  .replace('16/12 CLUBE DA PICANHA SUMARE 4.656,71D','16/12 CLUBE DA PICANHA\nSUMARE\n4.656,71D')
  .replace('10/12 PRIME CATER COMERCIAL SAO PAULO 7.593,82D','10/12 PRIME CATER COMERCIAL\nSAO PAULO\n7.593,82D')
  .replace('24/06 AUTOMACAO 2000 07 DE 12 SAO BERNARDO 510,00D','24/06 AUTOMACAO 2000 07 DE 12\nSAO BERNARDO\n510,00D');

validar(interpretarCaixa(textoQuebrado,'Fatura 01-2026.pdf'));

// Simula a página 2 real: conteúdo de pontos/encargos na coluna esquerda e
// lançamentos na coluna direita. O recorte deve ignorar a esquerda e manter
// a compra completa em uma única linha.
const item = (str,x,y)=>({str,transform:[1,0,0,1,x,y]});
const duasColunas = [
  item('Programa de Pontos',40,500),
  item('7177',210,500),
  item('06/12',305,500),
  item('TENDA ATACADO S A',331,500),
  item('CAMPINAS',430,500),
  item('10,75D',520,500),
  item('ROTATIVO',40,480),
  item('234,65% a.a',120,480),
  item('08/12',305,480),
  item('MARAVILHAS DO LAR',331,480),
  item('CAMPINAS',430,480),
  item('15,96D',520,480)
];
assert.deepEqual(montarLinhasColuna(duasColunas,295),[
  '06/12 TENDA ATACADO S A CAMPINAS 10,75D',
  '08/12 MARAVILHAS DO LAR CAMPINAS 15,96D'
]);

console.log('cartao-fatura-parser.test.js: OK');
