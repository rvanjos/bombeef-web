'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../public/js/dre-analise-gastos'),F=require('../public/js/dre-fluxo');
const base=data=>({data,meses:['08/2026','09/2026','10/2026','11/2026']});
const o={hoje:'2026-12-01'};
test('energia dobrada gera comparação exata em reais e percentual',()=>{
 const r=A.analisar(base({CONSUMO:{Energia:{'10/2026':-4621.72,'11/2026':-9243.44}}}),'11/2026',o);
 assert.equal(r.length,1);assert.equal(r[0].comparacoes[0].diferenca,4621.72);assert.equal(r[0].comparacoes[0].percentual,100);assert.equal(r[0].parcial,false);
});
test('software acima da média aparece mesmo com mês anterior também elevado',()=>{
 const r=A.analisar(base({TERCEIROS:{Software:{'08/2026':-200,'09/2026':-200,'10/2026':-500,'11/2026':-550}}}),'11/2026',o);
 assert.equal(r.length,1);assert.equal(r[0].comparacoes.length,1);assert.equal(r[0].comparacoes[0].tipo,'média recente');assert.equal(r[0].comparacoes[0].base,300);
});
test('limiares, meses futuros, falta de histórico e receitas não geram falsos avisos',()=>{
 for(const v of [-129,-150])assert.equal(A.analisar(base({CONSUMO:{Luz:{'10/2026':-100,'11/2026':v}}}),'11/2026',o).length,0);
 assert.equal(A.analisar(base({RECEITAS:{Vendas:{'10/2026':-100,'11/2026':-900}},OUTROS:{Retiradas:{'10/2026':-100,'11/2026':-900}},CONSUMO:{Nova:{'11/2026':-900}}}),'11/2026',o).length,0);
 assert.equal(A.analisar(base({CONSUMO:{Luz:{'10/2026':-100,'11/2026':-900}}}),'11/2026',{hoje:'2026-10-31'}).length,0);
 assert.equal(A.analisar({},'invalido',o).length,0);
});
test('mês corrente sinaliza acumulado parcial e meses ausentes não viram zero artificial',()=>{
 const b={data:{CONSUMO:{Luz:{'10/2026':-100,'11/2026':-500}}},meses:['10/2026','11/2026']};
 const r=A.analisar(b,'11/2026',{hoje:'2026-11-23'});assert.equal(r[0].parcial,true);assert.equal(r[0].comparacoes.length,1);
});
test('motor após duplicidades evita aviso falso de energia dobrada e respeita regime',()=>{
 const rows=[{id:'p',fonte:'EXTRATO',bankId:'341',acctId:'1',data:'2026-10-03',mes:'10/2026',mesCaixa:'10/2026',valor:-4621.72,lancamento:'DA CPFL PTA 1015164',categoria:'Energia'},
 ...['a','b'].map((id,i)=>({id,fonte:'EXTRATO',bankId:'341',acctId:'1',data:'2026-11-03',mes:'11/2026',mesCaixa:'12/2026',valor:-4621.72,lancamento:'DA CPFL PTA 1015164',categoria:'Energia',extratoArquivoHash:'arquivo'+i,extratoLinha:0,fitid:id}))];
 const resolvido=F.resolver(rows,'comp');const valores={};for(const t of resolvido.linhas)valores[t.mes]=(valores[t.mes]||0)+t.valor;
 assert.equal(A.analisar(base({CONSUMO:{Energia:valores}}),'11/2026',o).length,0);
});
