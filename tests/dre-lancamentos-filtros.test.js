'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require.resolve('../public/js/dre-lancamentos-area.js'),'utf8');
function fixture(transactions){
  const area={innerHTML:'',querySelector:()=>null};
  const ctx={localStorage:{getItem:()=>null},document:{readyState:'loading',addEventListener(){},getElementById:id=>id==='dre-lanc-area'?area:null},setTimeout(){},clearTimeout(){},getDreTransactions:()=>transactions,alert(){},confirm:()=>true};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
  const ids=()=>[...area.innerHTML.matchAll(/class="dla-row" data-id="([^"]+)"/g)].map(m=>m[1]);
  return {ctx,area,ids};
}
const tx=(id,data,extra={})=>({id,data,fonte:'EXTRATO',valor:-10,lancamento:id,mes:'09/2026',mesCaixa:'10/2026',...extra});
test('mês específico distingue data, competência e caixa sem alterar os lançamentos',()=>{
  const data=[tx('out','2026-10-03'),tx('set','2026-09-30',{mes:'10/2026',mesCaixa:'09/2026'})],before=JSON.stringify(data);
  const {ctx,ids}=fixture(data);ctx.dreLancFiltro('mes','2026-10');assert.deepEqual(ids(),['out']);
  ctx.dreLancFiltro('criterio','competencia');assert.deepEqual(ids(),['set']);
  ctx.dreLancFiltro('criterio','caixa');assert.deepEqual(ids(),['out']);assert.equal(JSON.stringify(data),before);
});
test('período inclusivo aceita datas brasileiras e ISO e não inclui datas ausentes',()=>{
  const {ctx,ids}=fixture([tx('inicio','01/10/2026'),tx('fim','2026-10-31T12:00:00Z'),tx('fora','2026-11-01'),tx('sem','')]);
  ctx.dreLancFiltro('de','2026-10-01');ctx.dreLancFiltro('ate','2026-10-31');assert.deepEqual(ids(),['inicio','fim']);
  ctx.dreLancFiltro('mes','2026-11');assert.deepEqual(ids(),[]);ctx.dreLancLimparFiltros();assert.equal(ids().length,4);
});
test('conta separa os bancos por metadados explícitos e não atribui legado ao Itaú',()=>{
  const {ctx,ids,area}=fixture([tx('itau','2026-10-01',{bankId:'0341',acctId:'123'}),tx('pag','2026-10-01',{bankId:'290',acctId:'456'}),tx('legado','2026-10-01',{fitid:'a1386c3f-a4ec-41ac-bd20-d365b5828765'}),tx('cartao','2026-10-01',{fonte:'CC',banco:'Itaú'})]);
  ctx.dreLancFiltro('conta','PagBank · 456');assert.deepEqual(ids(),['pag']);assert.match(area.innerHTML,/Banco não identificado/);
  ctx.dreLancFiltro('conta','Itaú · 123');assert.deepEqual(ids(),['itau']);
  ctx.dreLancFiltro('conta','Banco não identificado');assert.deepEqual(ids(),['legado']);
});
test('combina busca, banco, mês e status; mostra conta e valores filtrados escapados',()=>{
  const {ctx,ids,area}=fixture([tx('p','2026-10-01',{banco:'Outro <banco>',acctId:'7',categoria:'Fretes',valor:-42}),tx('s','2026-09-01',{banco:'Outro <banco>',acctId:'7',categoria:'Fretes'})]);
  ctx.dreLancFiltro('mes','2026-10');ctx.dreLancBusca('Outro');ctx.dreLancStatus('CLASSIFICADO');ctx.dreLancFiltro('conta','Outro <banco> · 7');assert.deepEqual(ids(),['p']);
  assert.match(area.innerHTML,/Outro &lt;banco&gt; · 7/);assert.doesNotMatch(area.innerHTML,/Outro <banco>/);assert.match(area.innerHTML,/42,00/);
});
test('CSV e XLSX são bancários; selecionar visíveis limita a 100 e filtro limpa seleção',()=>{
  const {ctx,area,ids}=fixture(Array.from({length:130},(_,i)=>tx(String(i),'2026-10-01',{fonte:i%2?'CSV':'XLSX',banco:'Itaú'})));
  ctx.dreLancOrigem('Banco');assert.equal(ids().length,100);ctx.dreLancSelecionarVisiveis();assert.match(area.innerHTML,/100 selecionado/);assert.doesNotMatch(area.innerHTML,/130 selecionado/);
  ctx.dreLancFiltro('mes','2026-10');assert.doesNotMatch(area.innerHTML,/selecionado\(s\)/);
});
