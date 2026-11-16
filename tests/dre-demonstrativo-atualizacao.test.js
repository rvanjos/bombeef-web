'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const F=require('../public/js/dre-fluxo');
const html=fs.readFileSync(require.resolve('../public/dre.html'),'utf8');
function fixture(){
 const timers=new Map();let seq=0;const nodes={'m-dre':{classList:{contains:()=>true}},'dre-body':{},'dre-full-body':{}};
 const txs=[{id:'a',fonte:'EXTRATO',valor:-4621.72,mes:'11/2026',mesCaixa:'11/2026',data:'2026-11-03',lancamento:'DA CPFL PTA 1015164',categoria:'Energia eletrica'},
 {id:'b',fonte:'EXTRATO',valor:-4621.72,mes:'11/2026',mesCaixa:'11/2026',data:'2026-11-03',lancamento:'DA CPFL PTA 1015164',categoria:'Energia eletrica'}];
 const ctx={window:null,TXS:txs,document:{getElementById:id=>nodes[id]||null},setTimeout(fn){const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),_garantirFatPorMes:async()=>{},_buildDRE(el){if(el)el.linhas=F.resolver(txs,'comp').linhas;},
 CATS:{CONSUMO:{s:['Energia eletrica','Água e esgoto']}},mesRef:'11/2026',supMem:{},_chaveFornecedor:()=>'',updStats(){},salvarMesDebounce(){},autoSv(){},render(){}};
 ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('let _dreRenderTimer='),html.indexOf('// Garante que bb_fat_por_mes')),ctx);
 vm.runInContext(html.slice(html.indexOf('async function setCat('),html.indexOf('// ── Sprint 3.1-D:')),ctx);
 const flush=async()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}await Promise.resolve();};
 return {ctx,nodes,txs,flush};
}
test('ignorar duplicidade atualiza DRE principal e tela inteira para o mesmo valor',async()=>{
 const {ctx,nodes,txs,flush}=fixture();ctx.renderDRE();await flush();
 const soma=node=>node.linhas.reduce((s,t)=>s+t.valor,0);
 assert.equal(soma(nodes['dre-full-body']),-9243.44);
 txs[1].ignorar=true;ctx.renderDRE();await flush();
 assert.equal(soma(nodes['dre-body']),-4621.72);assert.equal(soma(nodes['dre-full-body']),-4621.72);
});
test('reclassificar e limpar categoria bancária atualizam ambos os demonstrativos',async()=>{
 const {ctx,nodes,txs,flush}=fixture();txs[1].ignorar=true;
 await ctx.setCat('a','Água e esgoto');await flush();
 for(const id of ['dre-body','dre-full-body'])assert.equal(nodes[id].linhas[0].categoria,'Água e esgoto');
 assert.equal(txs[0]._categoriaEditada,true);
 await ctx.setCat('a','');await flush();
 for(const id of ['dre-body','dre-full-body'])assert.notEqual(nodes[id].linhas[0].categoria,'Água e esgoto');
});
test('atualizações consecutivas usam os dados mais recentes e não reabrem modal fechado',async()=>{
 const {ctx,nodes,txs,flush}=fixture();ctx.renderDRE();txs[1].ignorar=true;ctx.renderDREFull();await flush();
 assert.equal(nodes['dre-full-body'].linhas.length,1);
 nodes['m-dre'].classList.contains=()=>false;nodes['dre-full-body'].linhas=null;
 ctx.renderDRE();await flush();assert.equal(nodes['dre-full-body'].linhas,null);assert.equal(nodes['dre-body'].linhas.length,1);
});
