'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const {registrarRetirada,alterarRetirada,saldoAbertoSQL}=require('../lib/retiradas-limite');
function fixture({limite=300,aberto=200,autorizado=true,failItem=false}={}) {
  const historico=[{id:1,funcionario_id:7,loja_id:1,mes:'08/2026',valor_total:250,saldo_restante:aberto,status:aberto?'parcial':'pago'},
    {id:2,funcionario_id:7,loja_id:2,valor_total:999,saldo_restante:999,status:'pendente'}];
  const pagamentos=[],vinculos=[],queries=[];let nextId=3,queue=Promise.resolve();
  const pool={query:async()=>({rows:[]}),async connect(){
    let liberar=null;const gravados=[],pagos=[],links=[];
    function unlock(){if(liberar){liberar();liberar=null;}}
    return {release:unlock,async query(sql,p=[]){
      queries.push({sql,p});
      if(sql.includes('FROM funcionarios')){
        const anterior=queue;queue=new Promise(r=>liberar=r);await anterior;
        return {rows:p[0]===7&&p[1]===1?[{id:7,nome:'Fixture',limite_retirada:limite}]:[]};
      }
      if(sql.startsWith('SELECT funcionario_id'))return {rows:historico.filter(r=>r.id===p[0]&&r.loja_id===p[1])};
      if(sql.startsWith('SELECT *,'))return {rows:historico.filter(r=>r.id===p[0]&&r.loja_id===p[1]).map(r=>({...r,qtd:1,preco_unitario:r.valor_total,desconto_pct:0,aberto:r.status==='pago'?0:r.saldo_restante}))};
      if(sql.startsWith('SELECT preco_custo'))return {rows:p[0]===9&&p[1]===1?[{preco_custo:150}]:[]};
      if(sql.includes('SUM('))return {rows:[{total:historico.filter(r=>r.funcionario_id===p[0]&&r.loja_id===p[1]).reduce((s,r)=>s+(r.status==='pago'?0:r.saldo_restante),0)}]};
      if(sql.includes('INSERT INTO pagamentos_retiradas')){const row={id:20+pagamentos.length,valor_pago:p[2],forma_pagamento:p[3],usuario_id:p[5],loja_id:p[6]};pagos.push(row);return {rows:[row]};}
      if(sql.includes('INSERT INTO retiradas')){const row={id:nextId++,funcionario_id:p[0],loja_id:p[12],valor_total:p[6],saldo_restante:p[13],status:p[14],mes:p[7]};gravados.push(row);return {rows:[row]};}
      if(sql.includes('INSERT INTO pagamento_retirada_itens')){if(failItem)throw Error('falha simulada');links.push(p);}
      if(sql==='COMMIT'){historico.push(...gravados);pagamentos.push(...pagos);vinculos.push(...links);unlock();}
      if(sql==='ROLLBACK')unlock();
      return {rows:[]};
    }};
  }};
  const req={user:{id:8,lojaId:1,perfil:'admin'},podeRetirada:()=>autorizado};
  const body={funcionarioId:7,dtRetirada:'2026-10-23',itens:[{descricao:'Teste',qtd:1,precoUnitario:150}]};
  return {pool,req,body,historico,pagamentos,vinculos,queries,registrar:b=>registrarRetirada(pool,req,{...body,...b})};
}
test('dívida antiga ocupa limite; exige apenas o excedente pago no ato',async()=>{
  const f=fixture();await assert.rejects(f.registrar({}),e=>e.status===422&&e.pagamento_minimo===50&&e.saldo===100);
  assert.equal(f.historico.length,2);assert.equal(f.pagamentos.length,0);
  const r=await f.registrar({valorPagoAgora:50,formaPagamento:'pix'});
  assert.equal(r.saldo_aberto,300);assert.equal(r.limite_disponivel,0);assert.equal(r.data[0].saldo_restante,100);assert.equal(r.data[0].status,'parcial');
  assert.equal(f.pagamentos[0].valor_pago,50);assert.equal(f.pagamentos[0].usuario_id,8);assert.equal(f.pagamentos[0].loja_id,1);assert.equal(f.vinculos[0][2],50);
});
test('pagamento anterior libera limite sem depender de virada do mês',async()=>{
  const f=fixture();f.historico[0].saldo_restante=0;f.historico[0].status='pago';
  const r=await f.registrar({});assert.equal(r.saldo_aberto,150);assert.equal(r.limite_disponivel,150);
});
test('pagamento parcial anterior libera só o valor efetivamente pago',async()=>{
  const f=fixture({aberto:100});const r=await f.registrar({});assert.equal(r.saldo_aberto,250);assert.equal(r.limite_disponivel,50);
});
test('sem disponível, nova retirada precisa ser integralmente paga',async()=>{
  const f=fixture({aberto:300});await assert.rejects(f.registrar({valorPagoAgora:149,formaPagamento:'dinheiro'}),e=>e.pagamento_minimo===150);
  const r=await f.registrar({valorPagoAgora:150,formaPagamento:'dinheiro'});assert.equal(r.data[0].status,'pago');assert.equal(r.saldo_aberto,300);
});
test('limite zero exige pagamento integral; dívida antiga de outra loja não interfere',async()=>{
  const f=fixture({limite:0,aberto:0});await assert.rejects(f.registrar({}),e=>e.pagamento_minimo===150);
  const r=await f.registrar({valorPagoAgora:150,formaPagamento:'debito'});assert.equal(r.saldo_aberto,0);assert.equal(f.historico[1].saldo_restante,999);
});
test('lote registra um único pagamento e mantém vínculo de cada item abatido',async()=>{
  const f=fixture({aberto:0});const r=await f.registrar({itens:[{descricao:'A',qtd:1,precoUnitario:200},{descricao:'B',qtd:1,precoUnitario:200}],valorPagoAgora:250,formaPagamento:'pix'});
  assert.equal(r.total,400);assert.equal(r.data.length,2);assert.equal(r.data[0].status,'pago');assert.equal(r.data[1].saldo_restante,150);assert.equal(f.pagamentos.length,1);assert.equal(f.vinculos.length,2);
});
test('falha ao gravar vínculo desfaz lote e pagamento, sem retirada parcial',async()=>{
  const f=fixture({failItem:true});await assert.rejects(f.registrar({valorPagoAgora:50,formaPagamento:'pix'}));assert.equal(f.historico.length,2);assert.equal(f.pagamentos.length,0);assert.equal(f.queries.at(-1).sql,'ROLLBACK');
});
test('custo oficial prevalece e produto de outra loja é recusado',async()=>{
  const f=fixture({aberto:0});const r=await f.registrar({itens:[{descricao:'P',produtoId:9,qtd:1,precoUnitario:1}]});assert.equal(r.total,150);
  await assert.rejects(f.registrar({itens:[{descricao:'P',produtoId:99,qtd:1,precoUnitario:1}]}),e=>e.status===404);
});
test('registrar pagamento exige autorização; valores inválidos não gravam',async()=>{
  const f=fixture({autorizado:false});await assert.rejects(f.registrar({valorPagoAgora:50,formaPagamento:'pix'}),e=>e.status===403);
  for(const b of [{valorPagoAgora:151,formaPagamento:'pix'},{valorPagoAgora:-1},{valorPagoAgora:1.005},{itens:[{descricao:'X',qtd:-1,precoUnitario:2}]}])await assert.rejects(f.registrar(b));
});
test('duas novas retiradas concorrentes não ultrapassam o limite',async()=>{
  const f=fixture({aberto:0,limite:200});const r=await Promise.allSettled([f.registrar({}),f.registrar({})]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.filter(x=>x.status==='rejected'&&x.reason.status===422).length,1);assert.equal(f.historico.length,3);
});
test('edição preserva pagamento já feito e impede aumentar dívida acima do limite',async()=>{
  const f=fixture();await alterarRetirada(f.pool,f.req,1,{valorTotal:300});const q=f.queries.find(q=>q.sql.startsWith('UPDATE retiradas'));assert.equal(q.p[6],250);assert.equal(q.p[7],'parcial');assert.equal(q.p[10],1);
  await assert.rejects(alterarRetirada(f.pool,f.req,1,{valorTotal:400}),e=>e.status===422);
  await assert.rejects(alterarRetirada(f.pool,f.req,1,{valorTotal:40}),e=>e.status===409);
});
test('reabertura e IDs de outra loja não contornam limite',async()=>{
  const f=fixture({limite:100,aberto:0});await assert.rejects(alterarRetirada(f.pool,f.req,1,{},true),e=>e.status===422);
  await assert.rejects(alterarRetirada(f.pool,f.req,2,{},true),e=>e.status===404);
});
test('SQL do limite considera parcial/legado e não conta itens pagos',()=>{
  assert.match(saldoAbertoSQL('ret'),/ret.status/);assert.match(saldoAbertoSQL('ret'),/ret.saldo_restante,ret.valor_total/);
  const src=fs.readFileSync('routes/retiradas.js','utf8');const limite=src.slice(src.indexOf("r.get('/limites'"),src.indexOf('// ── GET /relatorio'));
  assert.doesNotMatch(limite,/ret.mes=|ret.mes =/);assert.match(limite,/ret.loja_id=f.loja_id/);
});
test('prévia informa mínimo e campo permite pagamento opcional',()=>{
  const src=fs.readFileSync('public/retiradas.html','utf8'),els={'r-pagamento-previa':{},'r-pago-agora':{value:'0'}};
  const ctx={document:{getElementById:id=>els[id]},retLimiteAtual:{saldo:100},retTotalAtual:150,permissoesRet:{pagamentos:true},fmt:{brl:n=>String(n)}};
  vm.runInNewContext(src.slice(src.indexOf('function previewRetirada()'),src.indexOf('// ── Múltiplos itens')),ctx);
  ctx.previewRetirada();assert.match(els['r-pagamento-previa'].textContent,/mínimo: 50/);ctx.preencherMinimoRetirada();assert.equal(els['r-pago-agora'].value,'50.00');assert.match(els['r-pagamento-previa'].textContent,/em aberto nesta retirada: 100/);
});
test('tela envia lote uma vez e mantém os itens quando o backend exige pagamento',async()=>{
  const src=fs.readFileSync('public/retiradas.html','utf8'),els={};
  const values={'r-func':'7','r-obs':'Teste','r-dt':'2026-10-23','ret-desc-0':'Produto','ret-qtd-0':'1','ret-preco-0':'150','ret-prodId-0':'9','ret-cod-0':'X','r-pago-agora':'50','r-forma-agora':'pix'};
  for(const [k,v] of Object.entries(values))els[k]={value:v};els['btn-salvar']={};els['r-pagamento-previa']={};
  let confirmar,called=0,body,closed=false;
  const ctx={document:{getElementById:id=>els[id],querySelectorAll:()=>[{id:'ret-item-0'}]},retSalvando:false,
    api:{post:async(p,b)=>{called++;body=b;return new Promise(r=>confirmar=r)}},fmt:{brl:String},toast(){},
    fecharModal:()=>closed=true,carregarFuncionarios:async()=>{},carregar:async()=>{}};
  vm.runInNewContext(src.slice(src.indexOf('async function salvar(){'),src.indexOf('// Estado do modal de pagamento')),ctx);
  const a=ctx.salvar();await ctx.salvar();assert.equal(called,1);assert.equal(body.itens.length,1);assert.equal(body.valorPagoAgora,50);
  confirmar({ok:false,pagamento_minimo:60});await a;assert.equal(closed,false);assert.equal(ctx.retSalvando,false);assert.equal(els['btn-salvar'].disabled,false);assert.match(els['r-pagamento-previa'].textContent,/60/);
  ctx.api.post=async()=>({ok:true,valor_pago:60});await ctx.salvar();assert.equal(closed,true);
});
