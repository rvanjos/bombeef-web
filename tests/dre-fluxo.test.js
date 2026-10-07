'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../public/js/dre-fluxo');
const pago={id:'p',fonte:'EXTRATO',mes:'10/2026',mesCaixa:'10/2026',valor:-100,categoria:'Pagamento de Fatura CC',faturaCC:'CC_10_2026_Caixa'};
const compra={id:'cc',fonte:'CC',mes:'09/2026',mesCaixa:'10/2026',valor:-100,lancamento:'Mercado',faturaCC:'CC_10_2026_Caixa'};
const total=r=>Math.round(r.linhas.reduce((s,t)=>s+Number(t.valor),0)*100)/100;
test('pagamento sem fatura permanece no resultado mesmo se antes foi ignorado',()=>{const r=F.resolver([{...pago,ignorar:true}]);assert.equal(total(r),-100);assert.equal(r.linhas[0].categoria,'A CLASSIFICAR');assert.ok(r.pendencias.some(p=>p.tipo==='fatura'));assert.equal(pago.categoria,'Pagamento de Fatura CC');});
test('fatura completa sem categoria não perde gasto nem duplica pagamento',()=>{const r=F.resolver([pago,compra]);assert.equal(total(r),-100);assert.equal(r.linhas.length,1);assert.equal(r.linhas[0].categoria,'A CLASSIFICAR');assert.equal(r.pendencias[0].mesCaixa,'10/2026');});
test('fatura classificada substitui pagamento por gastos',()=>{const r=F.resolver([pago,{...compra,categoria:'Material de Limpeza'}]);assert.equal(total(r),-100);assert.equal(r.pendencias.length,0);});
test('importação incompleta mantém diferença de pagamento como pendência',()=>{const r=F.resolver([pago,{...compra,valor:-40,categoria:'Material de Limpeza'}]);assert.equal(total(r),-100);assert.equal(r.linhas.find(t=>t.id.endsWith('__pendencia')).valor,-60);});
test('crédito e estorno na fatura reduzem gasto e pagamento uma vez',()=>{const r=F.resolver([pago,{...compra,valor:-120,categoria:'Material de Limpeza'},{...compra,id:'estorno',valor:20,categoria:'Material de Limpeza'}]);assert.equal(total(r),-100);assert.equal(r.pendencias.length,0);});
test('nota e pagamento bancário com vínculo: uma despesa, mês correto por regime',()=>{const nf={id:'n',fonte:'BOLETO',boletoId:5,mes:'09/2026',mesCaixa:'10/2026',valor:-100,categoria:'Mercadorias'};const ext={id:'ext',fonte:'EXTRATO',boletoId:5,mes:'10/2026',valor:-100};let r=F.resolver([nf,ext]);assert.equal(total(r),-100);assert.equal(r.linhas[0].mes,'09/2026');r=F.resolver([nf,ext],'caixa');assert.equal(total(r),-100);assert.equal(r.linhas[0].mes,'10/2026');assert.equal(r.linhas[0].categoria,'Mercadorias');});
test('nota paga pelo cartão, compra da fatura e pagamento: sem triplicação',()=>{const nf={id:'n',fonte:'BOLETO_CARTAO',boletoId:5,cartaoItemRef:'cc',cartaoFaturaRef:pago.faturaCC,mes:'09/2026',valor:-100,categoria:'Mercadorias'};const r=F.resolver([nf,pago,{...compra,documentoStatus:'boleto',documentoBoletoId:5}]);assert.equal(total(r),-100);assert.equal(r.linhas[0].id,'n');assert.equal(r.pendencias.length,0);const caixa=F.resolver([nf,pago,compra],'caixa');assert.equal(total(caixa),-100);assert.equal(caixa.linhas[0].categoria,'Mercadorias');});
test('valores e datas iguais sem vínculo não apagam despesas diferentes',()=>{const r=F.resolver([{id:'n',fonte:'BOLETO_PREV',data:'2026-10-01',mes:'10/2026',valor:-100,categoria:'Mercadorias'},{id:'e',fonte:'EXTRATO',data:'2026-10-01',mes:'10/2026',valor:-100,categoria:'Aluguel'}]);assert.equal(total(r),-200);});
test('boleto ainda não pago entra na competência, não no caixa',()=>{const t={id:'n',fonte:'BOLETO_PREV',mes:'10/2026',valor:-100,categoria:'Mercadorias'};assert.equal(total(F.resolver([t])),-100);assert.equal(total(F.resolver([t],'caixa')),0);});
test('FITID repetido é deduplicado; outra identidade é preservada',()=>{const a={id:'e1',fonte:'EXTRATO',fitid:'a',mes:'10/2026',valor:-100,categoria:'Mercadorias'};assert.equal(total(F.resolver([a,{...a,id:'e2'}])),-100);assert.equal(total(F.resolver([a,{...a,id:'e2',fitid:'b'}])),-200);});
test('auto concilia pagamento e fatura por total exato e identidade única',()=>{const r=F.resolver([{...pago,faturaCC:null,lancamento:'FATURA CAIXA'}, {...compra,bandeira:'Caixa',categoria:'Mercadorias'}]);assert.equal(total(r),-100);assert.equal(r.pendencias.length,0);});
test('diferença de um centavo permanece visível',()=>{const r=F.resolver([pago,{...compra,valor:-99.99,categoria:'Mercadorias'}]);assert.equal(total(r),-100);assert.equal(r.linhas[1].valor,-.01);});
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../public/dre.html'),'utf8');
test('motor visual e totais oficiais incluem gastos pendentes no resultado',()=>{
 const ctx=vm.createContext({DREFluxo:F,window:{},localStorage:{getItem:()=>null},TXS:[pago,compra],mesRef:'10/2026',getModo:()=> 'comp',CATS_NAO_OPERACIONAIS:new Set(['Pagamento de Fatura CC']),catGrupo:()=> 'OUTRAS'});
 vm.runInContext(html.slice(html.indexOf('function _txsSemDuplicatas('),html.indexOf('function _buildDRE(')),ctx);
 assert.equal(ctx.calcularMotorDRE('09/2026','comp').final,-100);
 assert.equal(ctx.calcularMotorDRE('10/2026','caixa').final,-100);
 assert.equal(ctx.prepararBaseDRE('comp').data.OUTRAS['A CLASSIFICAR']['09/2026'],-100);
});
test('importação só adiciona lançamentos após confirmação do banco',async()=>{
 const adicionados=[],avisos=[];let ok=false;
 const ctx=vm.createContext({document:{getElementById:()=>({classList:{add(){}}})},api:{post:async()=>ok?{ok:true,id:7,pendentes_classificacao:1}:{ok:false,erro:'falha'}},toast:t=>avisos.push(t),addLancs:a=>adicionados.push(...a),fecharModal(){},salvarTodos:async()=>true,_revinculateCC(){},renderDRE(){},autoSv(){},carregarCartaoFaturas(){},renderStatusCartoes(){},_ccrEnviando:false,_ccrLancs:[compra],_ccrBandeira:'Caixa',_ccrMesCC:'10/2026',_ccrFileName:'fatura.pdf'});
 vm.runInContext(html.slice(html.indexOf('async function _ccrExecutarEnvioNovo('),html.indexOf('// Variáveis de contexto para modal')),ctx);
 await ctx._ccrExecutarEnvioNovo('CC_10_2026_Caixa','Caixa',100,[], 'hash');assert.equal(adicionados.length,0);assert.match(avisos[0],/não salva/);
 ok=true;await ctx._ccrExecutarEnvioNovo('CC_10_2026_Caixa','Caixa',100,[],'hash');assert.equal(adicionados.length,1);assert.equal(adicionados[0].fatura_db_id,7);
});
test('sincronização usa PATCH e o hash persistido da fatura',async()=>{
 let enviado;
 const ctx=vm.createContext({console,toast(){},api:{patch:async(url,body)=>{enviado={url,body};return {ok:true,atualizados:1};}},_hashItemCC(){throw new Error('Não deve recalcular hash histórico');}});
 vm.runInContext(html.slice(html.indexOf('async function _sincronizarCategoriesCC('),html.indexOf('// ── Conferência do DRE: auditoria visual')),ctx);
 await ctx._sincronizarCategoriesCC([{faturaCC:'ref',fatura_db_id:4,hash_item_persistido:'histórico',categoria:'Mercadorias'}]);assert.equal(enviado.body.itens[0].hash_item,'histórico');assert.equal(enviado.body.itens[0].fatura_id,4);
});
test('identidades preservam documento e banco vinculados e compras semelhantes',()=>{
 assert.notEqual(F.identidade({fonte:'BOLETO',boletoId:1}),F.identidade({fonte:'EXTRATO',boletoId:1,fitid:'x'}));
 assert.equal(F.identidade({fonte:'BOLETO_PREV',boletoId:1}),F.identidade({fonte:'BOLETO',boletoId:1}));
 assert.notEqual(F.identidade({...compra,id:'a'}),F.identidade({...compra,id:'b'}));
 assert.notEqual(F.identidade({fonte:'OFX',fitid:'x',conta:'a'}),F.identidade({fonte:'OFX',fitid:'x',conta:'b'}));
});
test('reimportar documento não sobrescreve banco e compras iguais com IDs distintos sobrevivem',()=>{
 const ctx=vm.createContext({DREFluxo:F,TXS:[],files:[],supMem:{},_chaveFornecedor:()=>'',autoClassificar:()=>null,tentarVincularFaturaAuto(){},toast(){},showTable(){},updMesFiltro(){},render(){},updStats(){},renderDRE(){},autoSv(){}});
 vm.runInContext(html.slice(html.indexOf('function addLancs('),html.indexOf('function showTable(')),ctx);
 const nf={id:'n',fonte:'BOLETO_PREV',boletoId:5,data:'2026-09-30',mes:'09/2026',valor:-100,lancamento:'Fornecedor'};
 const bank={id:'b',fonte:'OFX',boletoId:5,fitid:'x',data:'2026-10-01',mes:'10/2026',valor:-100,lancamento:'Fornecedor'};
 ctx.addLancs([nf,bank,{...compra,id:'a'},{...compra,id:'b'}],'teste');assert.equal(ctx.TXS.length,4);
 ctx.addLancs([{...nf,fonte:'BOLETO'},bank,{...compra,id:'a'}],'teste');assert.equal(ctx.TXS.length,4);
 assert.equal(ctx.TXS[0].fonte,'BOLETO');assert.equal(ctx.TXS[0].mes,'09/2026');assert.equal(ctx.TXS[1].fonte,'OFX');assert.equal(ctx.TXS[1].mes,'10/2026');
});
test('pagamento parcial preserva despesa de competência e limita desembolso no caixa',()=>{
 const txs=[{...pago,valor:-50},{...compra,categoria:'Material de Limpeza'}];
 assert.equal(total(F.resolver(txs)),-100);const c=F.resolver(txs,'caixa');assert.equal(total(c),-50);assert.equal(c.linhas[0].categoria,'Material de Limpeza');
});
test('pagamentos da mesma fatura em meses diferentes distribuem caixa sem duplicar compra',()=>{
 const txs=[{...pago,id:'p1',valor:-30,mes:'10/2026'},{...pago,id:'p2',valor:-70,mes:'11/2026',mesCaixa:'11/2026'},{...compra,categoria:'Material de Limpeza'}];
 assert.equal(total(F.resolver(txs)),-100);const c=F.resolver(txs,'caixa');assert.equal(total(c),-100);
 assert.equal(c.linhas.filter(t=>t.mesCaixa==='10/2026').reduce((n,t)=>n+t.valor,0),-30);
 assert.equal(c.linhas.filter(t=>t.mesCaixa==='11/2026').reduce((n,t)=>n+t.valor,0),-70);
});
