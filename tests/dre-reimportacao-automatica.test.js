'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),{createHash}=require('node:crypto');
const F=require('../public/js/dre-fluxo'),C=require('../public/js/dre-conferencia-core');
const html=fs.readFileSync(require.resolve('../public/dre.html'),'utf8');
const tx=(id,extra={})=>({id,fonte:'EXTRATO',data:'2026-10-05',mes:'10/2026',mesCaixa:'10/2026',valor:309.71,lancamento:'PIX',razaoSocial:'QR CODE RECEBIDO ARTHUR PASSOS',categoria:'VENDAS DE MERCADORIAS',...extra});
test('mesmo FITID normaliza 0341/341 e conta textual; cálculo e conferência concordam sem alterar originais',()=>{
 const ts=[tx('antigo',{fitid:'abc',bankId:'0341',acctId:'123'}),tx('novo',{fitid:'abc',contaBancaria:'Itaú · 123'})],before=JSON.stringify(ts);
 for(const modo of ['comp','caixa'])assert.equal(F.resolver(ts,modo).linhas.length,1);
 const c=C.analisar(ts);assert.equal(c.reimportacoes.length,0);assert.equal(c.reimportacoesAutomaticas.length,1);assert.equal(JSON.stringify(ts),before);
});
test('mesmo arquivo conserva multiplicidade das linhas e reenvio sem FITID conta uma única vez',()=>{
 const ts=[tx('a',{extratoArquivoHash:'h',extratoLinha:0}),tx('b',{extratoArquivoHash:'h',extratoLinha:1})];
 const copia=ts.map(t=>({...t,id:t.id+'2'}));assert.equal(F.deduplicar([...ts,...copia]).fontes.length,2);assert.equal(C.analisar([...ts,...copia]).reimportacoesAutomaticas.length,2);
});
test('identidades alternativas tratam arquivo novo com FITID já conhecido e preservam a classificação manual',()=>{
 const ts=[tx('a',{fitid:'f',bankId:'341',acctId:'1',_categoriaEditada:true,categoria:'Receita ajustada'}),tx('b',{fitid:'f',bankId:'341',acctId:'1',extratoArquivoHash:'h',extratoLinha:0,categoria:null})];
 const d=F.deduplicar(ts);assert.equal(d.fontes.length,1);assert.equal(d.fontes[0].id,'a');assert.equal(d.fontes[0].categoria,'Receita ajustada');
});
test('FITIDs diferentes, contas diferentes, lojas diferentes e dados divergentes permanecem separados',()=>{
 const a=tx('a',{fitid:'f',bankId:'341',acctId:'1',loja_id:1});
 for(const extra of [{fitid:'g'},{acctId:'2'},{loja_id:2},{valor:400},{data:'2026-10-06'},{boletoId:2}]){
  const orig={...a,boletoId:1},b={...orig,...extra,id:'b'};assert.equal(F.deduplicar([orig,b]).fontes.length,2,JSON.stringify(extra));
 }
 assert.equal(C.analisar([a,{...a,id:'b',acctId:'2'}]).reimportacoes.length,0);
});
test('cópia vinculada prevalece e sequências de três reenvios continuam com uma única versão',()=>{
 const ts=[tx('a',{fitid:'f'}),tx('b',{fitid:'f',boletoId:7}),tx('c',{fitid:'f'})];
 const d=F.deduplicar(ts);assert.equal(d.fontes.length,1);assert.equal(d.fontes[0].id,'b');assert.equal(d.fontes[0].boletoId,7);assert.equal(d.suprimidos.length,2);
});
test('versão vinculada herda a classificação manual no cálculo sem modificar as duas origens',()=>{
 const ts=[tx('a',{fitid:'f',_categoriaEditada:true,categoria:'Receita ajustada'}),tx('b',{fitid:'f',boletoId:7,categoria:null})],before=JSON.stringify(ts);
 const d=F.deduplicar(ts);assert.equal(d.fontes.length,1);assert.equal(d.fontes[0].boletoId,7);assert.equal(d.fontes[0].categoria,'Receita ajustada');assert.equal(JSON.stringify(ts),before);
 const conflito=[tx('a',{fitid:'f',_categoriaEditada:true,categoria:'A'}),tx('b',{fitid:'f',_categoriaEditada:true,categoria:'B'})];assert.equal(F.deduplicar(conflito).fontes.length,2);
});
test('plano em lote conserva versão classificada e pula contas, categorias e vínculos conflitantes',()=>{
 const grupos=ts=>[{transacoes:ts.map(t=>({id:t.id}))}];
 const a=tx('a'),b=tx('b',{categoria:null});assert.equal(F.planejarReimportacoes([a,b],grupos([a,b]))[0].manterId,'a');
 for(const extra of [{categoria:'Outra categoria'},{bankId:'290'},{loja_id:2},{valor:310},{mes:'09/2026'}])assert.equal(F.planejarReimportacoes([a,{...b,...extra}],grupos([a,b])).length,0);
 assert.equal(F.planejarReimportacoes([{...a,boletoId:1},{...b,boletoId:2}],grupos([a,b])).length,0);
 assert.equal(F.planejarReimportacoes([a,b,tx('ref',{vinculadoA:'b'})],grupos([a,b])).length,0);
});
function loteFixture(ts,save){
 const msgs=[],ctx={TXS:ts,DREFluxo:F,DREConferencia:C,window:{},mesRef:'10/2026',fmt:{brl:String},confirm:()=>true,salvarMes:save,toast:s=>msgs.push(s),render(){},updStats(){},renderDRE(){},abrirConferenciaDRE(){}};
 vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('let _tratandoReimportacoesDRE'),html.indexOf('// ── Exporta cada lançamento')),ctx);return {ctx,msgs};
}
test('lote persiste cópia no histórico uma vez; operação repetida não volta como pendência',async()=>{
 const ts=[tx('a'),tx('b')],calls=[];const {ctx}=loteFixture(ts,async mes=>{calls.push(mes);assert.equal(ts[1].ignorar,true);return true;});
 await ctx.tratarReimportacoesDRE();assert.equal(ts.length,2);assert.equal(ts[1].duplicadoDe,'a');assert.equal(ts[1].historicoDuplicidade.length,1);assert.equal(C.analisar(ts).reimportacoes.length,0);
 await ctx.tratarReimportacoesDRE();assert.deepEqual(calls,['10/2026']);
});
test('falha de salvamento ou mês fechado restaura todos os campos e informa que não salvou',async()=>{
 const ts=[tx('a'),tx('b')],before=JSON.stringify(ts);const {ctx,msgs}=loteFixture(ts,async()=>false);await ctx.tratarReimportacoesDRE();assert.equal(JSON.stringify(ts),before);assert.match(msgs.at(-1),/1 não salvas/);
});
test('duplo clique durante salvamento não duplica o histórico nem os envios',async()=>{
 let release;const ts=[tx('a'),tx('b')],calls=[];const {ctx}=loteFixture(ts,async mes=>{calls.push(mes);return new Promise(r=>release=r);});
 const p=ctx.tratarReimportacoesDRE();await ctx.tratarReimportacoesDRE();release(true);await p;assert.equal(calls.length,1);assert.equal(ts[1].historicoDuplicidade.length,1);
});
test('importador fornece hash estável e índice por linha e consulta apenas a loja ativa',async()=>{
 const s=fs.readFileSync(require.resolve('../routes/dre'),'utf8');let handler;const calls=[];
 const ctx={r:{post:(...args)=>handler=args.at(-1)},autoPublish:()=>()=>{},upload:{single:()=>()=>{}},parseXLSXExtrato:()=>[tx(undefined),tx(undefined)],createHash,DREFluxo:F,pool:{query:async(sql,params)=>{calls.push({sql,params});return {rows:[]};}},console};
 vm.createContext(ctx);vm.runInContext(s.slice(s.indexOf("r.post('/import-extrato'"),s.indexOf('// ── Fechamento mensal seguro')),ctx);
 async function run(){let response;const res={json:v=>response=v,status(){return this;}};await handler({file:{originalname:'extrato.csv',buffer:Buffer.from('mesmo conteúdo')},user:{lojaId:7}},res);return response;}
 const a=await run(),b=await run();assert.equal(a.ok,true);assert.equal(a.lancamentos[0].extratoArquivoHash,b.lancamentos[0].extratoArquivoHash);assert.notEqual(F.identidade(a.lancamentos[0]),F.identidade(a.lancamentos[1]));assert.match(calls[0].sql,/loja_id=\$2/);assert.equal(calls[0].params[1],7);
});
test('reimportação na tela não adiciona novas cópias nem substitui categoria já salva',()=>{
 const a=tx('a',{fitid:'f',bankId:'0341',acctId:'123',categoria:'Receita ajustada'}),ts=[a];
 const ctx={TXS:ts,DREFluxo:F,files:[],toast(){},showTable(){},updMesFiltro(){},render(){},updStats(){},renderDRE(){},autoSv(){},tentarVincularFaturaAuto(){}};
 vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('function addLancs('),html.indexOf('function showTable(')),ctx);
 ctx.addLancs([tx(undefined,{fitid:'f',bankId:'341',acctId:'123',extratoArquivoHash:'h',extratoLinha:0})],'extrato.ofx');
 assert.equal(ts.length,1);assert.equal(a.categoria,'Receita ajustada');
 const rows=[0,1].map(extratoLinha=>tx(undefined,{extratoArquivoHash:'csv',extratoLinha}));ctx.addLancs(rows,'extrato.csv');ctx.addLancs(rows,'extrato.csv');assert.equal(ts.length,3);
});
