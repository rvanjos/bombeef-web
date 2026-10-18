'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const factory=require('../routes/retiradas');
function fixture(){
 const rows=[{id:1,funcionario_id:7,loja_id:1,dt_retirada:'2026-08-01',saldo:20,status:'pendente'},{id:2,funcionario_id:7,loja_id:1,dt_retirada:'2026-09-01',saldo:30,status:'parcial'},{id:3,funcionario_id:7,loja_id:2,dt_retirada:'2026-08-01',saldo:99,status:'pendente'}];
 const writes=[],sqls=[];
 const pool={query:async()=>({rows:[],rowCount:0}),connect:async()=>({release(){},async query(sql,p=[]){sqls.push(sql);
  if(sql.includes('SELECT id, dt_retirada, valor_total'))return{rows:rows.filter(r=>r.funcionario_id===p[0]&&r.loja_id===p[1]&&r.saldo>0&&(!p[2]||p[2].includes(r.id))).map(r=>({...r}))};
  if(sql.includes('INSERT INTO pagamentos_retiradas')){assert.equal(p[6],1);writes.push(['pagamento',p]);return{rows:[{id:9,valor_pago:p[2]}]};}
  if(sql.includes('UPDATE retiradas SET saldo_restante')){assert.equal(p[5],1);writes.push(['baixa',p]);const r=rows.find(r=>r.id===p[4]&&r.loja_id===p[5]);r.saldo=Number(p[0]);r.status=p[1];}
  if(sql.includes('INSERT INTO pagamento_retirada_itens')){assert.equal(p[3],1);writes.push(['item',p]);}
  return{rows:[]};}})};
 const h=factory(pool).stack.find(x=>x.route?.path==='/pagamentos'&&x.route.methods.post).route.stack.at(-1).handle;
 async function pagar(body={}){const res={status:200};await h({user:{id:8,lojaId:1},body:{funcionarioId:7,valorPago:50,saldoEsperado:50,...body}},{status(n){res.status=n;return this;},json(b){res.body=b;return this;}});return res;}
 return{rows,writes,sqls,pagar};
}
test('um pagamento quita todas as retiradas de meses distintos e preserva histórico',async()=>{const f=fixture(),r=await f.pagar();assert.equal(r.status,200);assert.equal(r.body.abatimentos.length,2);assert.equal(f.writes.filter(x=>x[0]==='pagamento').length,1);assert.deepEqual(f.rows.slice(0,2).map(r=>r.saldo),[0,0]);assert.equal(f.rows[2].saldo,99);assert.ok(f.sqls.includes('COMMIT'));assert.ok(f.sqls.some(s=>s.includes('FOR UPDATE')));});
test('pagamento parcial abate antigas primeiro',async()=>{const f=fixture(),r=await f.pagar({valorPago:25});assert.equal(r.status,200);assert.deepEqual(f.rows.slice(0,2).map(r=>r.saldo),[0,25]);});
test('seleção paga somente lançamento escolhido',async()=>{const f=fixture(),r=await f.pagar({criterio:'selecionadas',retiradaIds:[2],valorPago:30,saldoEsperado:30});assert.equal(r.status,200);assert.equal(f.rows[0].saldo,20);assert.equal(f.rows[1].saldo,0);});
test('saldo alterado e ID de outra loja abortam antes de gravar',async()=>{for(const body of [{saldoEsperado:55},{criterio:'selecionadas',retiradaIds:[1,3],valorPago:20,saldoEsperado:20}]){const f=fixture(),r=await f.pagar(body);assert.equal(r.status,409);assert.equal(f.writes.length,0);assert.ok(f.sqls.includes('ROLLBACK'));}});
test('segunda confirmação com o saldo antigo não duplica baixa parcial',async()=>{const f=fixture();assert.equal((await f.pagar({valorPago:10})).status,200);const n=f.writes.length;assert.equal((await f.pagar({valorPago:10})).status,409);assert.equal(f.writes.length,n);});
test('excedente não cria pagamento',async()=>{const f=fixture();assert.equal((await f.pagar({valorPago:51})).status,409);assert.equal(f.writes.length,0);});
const html=fs.readFileSync('public/retiradas.html','utf8');
function tela(){
 const {JSDOM}=require(process.env.JSDOM_PATH),dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost'}),w=dom.window;
 w.fmt={brl:n=>'R$ '+Number(n).toFixed(2),date:n=>n};w.toast=()=>{};w.carregar=async()=>{};w.fecharModal=id=>w.document.getElementById(id).classList.remove('open');w.retiradas=[{id:1,funcionario_id:7}];w.funcionarioProprioId=null;
 const sel=w.document.getElementById('pag-ret-funcionario');sel.innerHTML='<option value="7">Ana</option><option value="8">Lucas</option>';sel.value='7';
 w.api={get:async()=>({ok:true,data:[{id:1,status:'pendente',saldo_restante:'20.00',dt_retirada:'2026-08-01',descricao:'A'},{id:2,status:'parcial',saldo_restante:'30.00',dt_retirada:'2026-09-01',descricao:'B'}]})};
 w.eval(html.slice(html.indexOf('// Estado do modal de pagamento'),html.indexOf('window.toggleBaixaPDV')));return{dom,w,el:id=>w.document.getElementById(id)};
}
test('Pagar item → Quitar todo o saldo inclui todos os meses; confirmação única',async()=>{const {dom,w,el}=tela();try{
 await w.darBaixaRetirada(1);assert.equal(el('pag-ret-valor').value,'20.00');assert.equal(el('pag-ret-criterio').value,'selecionadas');w.quitarSaldoRet();assert.equal(el('pag-ret-valor').value,'50.00');assert.match(el('pag-ret-preview-txt').textContent,/Quita 2/);
 let done,calls=0,body;w.api.post=async(p,b)=>{calls++;body=b;return new Promise(r=>done=r)};
 const p=w.confirmarPagamentoRet();await w.confirmarPagamentoRet();assert.equal(calls,1);assert.equal(body.valorPago,50);assert.equal(body.saldoEsperado,50);assert.equal(body.criterio,'antigas');assert.equal(body.retiradaIds.length,0);assert.equal(el('pag-ret-confirmar').disabled,true);done({ok:true,abatimentos:[{},{}]});await p;
 }finally{dom.window.close();}});
test('resposta antiga não troca funcionário e falha de consulta impede pagamento',async()=>{const {dom,w,el}=tela();try{let first;w.api.get=async()=>new Promise(r=>first=r);const p=w.carregarPendenciasPagamentoRet();el('pag-ret-funcionario').value='8';w.api.get=async()=>({ok:false});await w.carregarPendenciasPagamentoRet();first({ok:true,data:[{id:1,status:'pendente',valor_total:99}]});await p;assert.equal(el('pag-ret-confirmar').disabled,true);assert.equal(el('pag-ret-quitar').disabled,true);assert.equal(el('pag-ret-valor').value,'');}finally{dom.window.close();}});
