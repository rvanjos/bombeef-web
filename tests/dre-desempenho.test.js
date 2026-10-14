'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(require.resolve('../public/dre.html'),'utf8');
function fixture(){
 const calls=[];let post=async()=>({ok:true,sessao_id:1});
 const txs=Array.from({length:12},(_,i)=>({id:String(i),fonte:'MANUAL',mes:String(i+1).padStart(2,'0')+'/2026',valor:-100,categoria:'Aluguel'}));
 const c=vm.createContext({console:{log(){},error(){}},TXS:txs,files:[],supMem:{},mesRef:'10/2026',sessId:10,_sv:0,_svMes:{},setTimeout,clearTimeout,setSt(){},toast(){},calcResultadoDRE:()=>({}),window:{_sessoesPorMes:Object.fromEntries(txs.map((t,i)=>[t.mes,i+1])),_estoquesMes:{}},api:{post:async(u,b)=>{calls.push(JSON.parse(JSON.stringify(b)));return post();},get:async()=>({ok:true,data:{id:1}})}});
 vm.runInContext(html.slice(html.indexOf('let _mesMetadadosDRE'),html.indexOf('async function desvinculardoBoleto')),c);
 vm.runInContext(html.slice(html.indexOf('async function salvarTodos('),html.indexOf('async function abrirSessoes(')),c);
 c.registrarBaseSalvaDRE();return {c,calls,setPost:f=>post=f};
}
test('abrir e salvar sem mudanças não escreve os 12 meses',async()=>{const {c,calls}=fixture();await c.salvarTodos();assert.equal(calls.length,0);});
test('uma edição envia apenas o mês alterado',async()=>{const {c,calls}=fixture();c.TXS[3].categoria='Manutenção';await c.salvarTodos();assert.equal(calls.length,1);assert.equal(calls[0].mes_ref,'04/2026');await c.salvarTodos();assert.equal(calls.length,1);});
test('exclusão do último lançamento mantém sessão vazia no salvamento',async()=>{const {c,calls}=fixture();c.TXS=c.TXS.filter(t=>t.mes!=='04/2026');await c.salvarTodos();assert.equal(calls.length,1);assert.equal(calls[0].dados_json.transactions.length,0);});
test('mudança de estoque recalcula somente o mês e o seguinte',async()=>{const {c,calls}=fixture();c.window._estoquesMes['09/2026']=0;await c.salvarTodos();assert.deepEqual(calls.map(x=>x.mes_ref),['09/2026','10/2026']);});
test('nova edição durante envio é salva depois, sem sobreposição',async()=>{
 const {c,calls,setPost}=fixture();let release;setPost(()=>new Promise(r=>release=r));c.TXS[3].categoria='A';const a=c.salvarMes('04/2026');assert.equal(calls.length,1);c.TXS[3].categoria='B';const b=c.salvarMes('04/2026');assert.equal(calls.length,1);setPost(async()=>({ok:true,sessao_id:4}));release({ok:true,sessao_id:4});await Promise.all([a,b]);assert.equal(calls.length,2);assert.equal(calls[1].dados_json.transactions[0].categoria,'B');await c.salvarTodos();assert.equal(calls.length,2);
});
test('falha não marca alterações como salvas e permite tentar novamente',async()=>{const {c,calls,setPost}=fixture();setPost(async()=>({ok:false,erro:'falha'}));c.TXS[0].categoria='A';assert.equal(await c.salvarTodos(),false);setPost(async()=>({ok:true,sessao_id:1}));assert.equal(await c.salvarTodos(),true);assert.equal(calls.length,2);});
test('metadados novos são persistidos sem regravar todos os meses',async()=>{const {c,calls}=fixture();c.files.push('fatura.pdf');c.supMem.Loja='Compras';await c.salvarTodos();assert.deepEqual(calls.map(x=>x.mes_ref),['10/2026']);});
test('carga inicial consulta apenas a sessão mais recente por mês e loja',()=>{const route=fs.readFileSync(require.resolve('../routes/dre'),'utf8');const sql=route.slice(route.indexOf("r.get('/sessoes-completas'"),route.indexOf('function _isoData'));assert.match(sql,/DISTINCT ON \(mes_ref\)/);assert.match(sql,/WHERE loja_id=\$1/);assert.match(sql,/atualizado_em DESC,id DESC/);});
test('edição durante busca da sessão entra no payload enviado',async()=>{
 const {c,calls}=fixture();delete c.window._sessoesPorMes['04/2026'];let release;c.api.get=()=>new Promise(r=>release=r);c.TXS[3].categoria='A';const save=c.salvarMes('04/2026');c.TXS.push({id:'novo',fonte:'MANUAL',mes:'04/2026',valor:-5});release({ok:true,data:{id:4}});await save;assert.equal(calls[0].dados_json.transactions.length,2);await c.salvarTodos();assert.equal(calls.length,1);
});
test('áreas separadas, menu único e navegação em blocos com 3.700 itens',{skip:!process.env.JSDOM_PATH},async()=>{
 const {JSDOM}=require(process.env.JSDOM_PATH);
 const dom=new JSDOM(html,{url:'http://localhost/dre.html',runScripts:'outside-only'});const w=dom.window;
 try{
  w.localStorage.setItem('dre-ferramentas','1');w.render=()=>{};w.renderDRE=()=>{};w.getDreTransactions=()=>Array.from({length:3700},(_,i)=>({id:String(i),fonte:'MANUAL',mes:'10/2026',valor:-10,lancamento:'Fornecedor '+i}));
  w.eval(fs.readFileSync(require.resolve('../public/js/dre-lancamentos-area'),'utf8'));await new Promise(r=>setTimeout(r,240));
  assert.equal(w.document.body.classList.contains('dre-tools-open'),false);
  assert.equal(w.getComputedStyle(w.document.querySelector('.main')).display,'none');
  assert.equal(w.getComputedStyle(w.document.getElementById('dre-p')).display,'block');
  assert.equal(w.document.querySelectorAll('#dre-actions').length,1);
  w.dreSetView('lancamentos');assert.equal(w.document.querySelectorAll('.dla-row').length,100);w.dreLancMais();assert.equal(w.document.querySelectorAll('.dla-row').length,200);
  w.dreSetView('demonstrativo');assert.equal(w.document.body.classList.contains('dre-view-demonstrativo'),true);
 }finally{w.close();}
});

test('trocar mês para consulta não provoca salvamento de metadados sem edição',async()=>{const {c,calls}=fixture();c.mesRef='05/2026';await c.salvarTodos();assert.equal(calls.length,0);c.files.push('novo.pdf');await c.salvarTodos();assert.equal(calls.length,1);assert.equal(calls[0].mes_ref,'10/2026');assert.equal(calls[0].dados_json.loadedFiles[0],'novo.pdf');});
