'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {centavos,distribuirPagamento}=require('../lib/fiado-pagamento');
const routerFactory=require('../routes/fiado');
function fixture(vendas=[{id:1,cliente_id:1,loja_id:1,saldo_restante:300,status:'aberto'},{id:2,cliente_id:1,loja_id:1,saldo_restante:530.02,status:'aberto'}],credito=0) {
  const db={cliente:{id:1,loja_id:1,credito_saldo:credito},vendas:structuredClone(vendas),pags:[],abat:[],hist:[]};
  let fila=Promise.resolve();
  const pool={query:async()=>({rows:[]}),connect:async()=>{
    let unlock,snapshot;
    return {release(){if(unlock)unlock();},async query(sql,p=[]){
      if(sql.includes('SELECT * FROM clientes_fiado')) {
        const anterior=fila; fila=new Promise(resolve=>unlock=resolve); await anterior;
        snapshot=structuredClone(db);
        return {rows:p[0]==db.cliente.id&&p[1]==db.cliente.loja_id?[db.cliente]:[]};
      }
      if(sql==='ROLLBACK'&&snapshot) { Object.assign(db,snapshot); return {rows:[]}; }
      if(sql.includes('SELECT * FROM pagamentos_fiado')) return {rows:db.pags.filter(x=>x.loja_id===p[0]&&x.idempotencia===p[1])};
      if(sql.includes('SELECT * FROM vendas_fiado'))return {rows:db.vendas.filter(x=>x.cliente_id==p[0]&&x.loja_id==p[1]&&['aberto','parcial'].includes(x.status)&&(!p[2]||x.id==p[2]))};
      if(sql.includes('INSERT INTO pagamentos_fiado')) {
        const x={id:db.pags.length+1,cliente_id:p[0],valor_pago:p[2],forma_pagamento:p[3],credito_gerado:p[6],credito_utilizado:p[7],idempotencia:p[9],requisicao:JSON.parse(p[10]),loja_id:p[11]};db.pags.push(x);return {rows:[x]};
      }
      if(sql.includes('UPDATE vendas_fiado')) {const v=db.vendas.find(x=>x.id===p[2]&&x.loja_id===p[3]);v.saldo_restante=p[0];v.status=p[1];}
      if(sql.includes('INSERT INTO pagamento_venda_fiado'))db.abat.push(p);
      if(sql.includes('UPDATE clientes_fiado'))db.cliente.credito_saldo+=p[1]-p[2];
      if(sql.includes('INSERT INTO historico_fiado'))db.hist.push(p);
      return {rows:[]};
    }};
  }};
  const router=routerFactory(pool);
  const handler=router.stack.find(x=>x.route?.path==='/pagamentos'&&x.route.methods.post).route.stack.at(-1).handle;
  async function pagar(body={},loja=1){const result={status:200};const res={status(n){result.status=n;return this;},json(x){result.body=x;return this;}};await handler({user:{id:10,nome:'Teste',perfil:'admin',lojaId:loja},body:{cliente_id:1,valor_pago:970,idempotencia:'teste-pagamento-00001',...body}},res);return result;}
  return {db,pagar};
}
test('exemplo 970: quita 830,02 e gera 139,98 preservando recebimento e vínculos',async()=>{
  const {db,pagar}=fixture();const r=await pagar();assert.equal(r.status,200);assert.equal(db.pags[0].valor_pago,970);assert.equal(db.cliente.credito_saldo,139.98);assert.equal(r.body.valor_aplicado,830.02);assert.deepEqual(db.vendas.map(v=>v.status),['pago','pago']);assert.equal(db.abat.length,2);assert.equal(db.hist.length,1);
});
test('parcial abate mais antiga antes da seguinte',async()=>{const {db,pagar}=fixture();await pagar({valor_pago:400});assert.equal(db.vendas[0].saldo_restante,0);assert.equal(db.vendas[1].saldo_restante,430.02);assert.equal(db.cliente.credito_saldo,0);});
test('pagamento exato não gera crédito',async()=>{const {db,pagar}=fixture();await pagar({valor_pago:830.02});assert.equal(db.cliente.credito_saldo,0);assert.equal(db.vendas[1].status,'pago');});
test('venda direcionada deixa as demais intactas e gera excedente',async()=>{const {db,pagar}=fixture();await pagar({valor_pago:600,venda_id:2});assert.equal(db.vendas[0].saldo_restante,300);assert.equal(db.cliente.credito_saldo,69.98);assert.equal(db.abat[0][1],2);});
test('crédito manual quita compra sem registrar nova entrada de caixa',async()=>{const {db,pagar}=fixture(undefined,139.98);await pagar({valor_pago:139.98,forma_pagamento:'saldo_cliente'});assert.equal(db.cliente.credito_saldo,0);assert.equal(db.pags[0].valor_pago,0);assert.equal(db.pags[0].credito_utilizado,139.98);assert.equal(db.vendas[0].saldo_restante,160.02);});
test('uso de crédito insuficiente ou acima da dívida não altera dados',async()=>{const {db,pagar}=fixture(undefined,100);assert.equal((await pagar({valor_pago:200,forma_pagamento:'saldo_cliente'})).status,409);assert.equal(db.pags.length,0);assert.equal(db.cliente.credito_saldo,100);});
test('repetição concorrente do mesmo pagamento grava somente uma vez',async()=>{const {db,pagar}=fixture();const r=await Promise.all([pagar(),pagar()]);assert.equal(db.pags.length,1);assert.equal(db.cliente.credito_saldo,139.98);assert.equal(r[1].body.repetido,true);});
test('saldo stale impede segunda operação distinta concorrente',async()=>{const {db,pagar}=fixture();const r=await Promise.all([pagar({saldo_esperado:830.02}),pagar({saldo_esperado:830.02,idempotencia:'teste-pagamento-00002'})]);assert.equal(r[1].status,409);assert.equal(db.pags.length,1);});
test('mesma chave com payload diferente é rejeitada',async()=>{const {pagar,db}=fixture();await pagar();assert.equal((await pagar({valor_pago:900})).status,409);assert.equal(db.pags.length,1);});
test('outra loja não pode movimentar cliente',async()=>{const {pagar,db}=fixture();assert.equal((await pagar({},2)).status,404);assert.equal(db.pags.length,0);});
test('adiantamento sem dívida preserva crédito; venda inválida é rejeitada',async()=>{const {pagar,db}=fixture([]);assert.equal((await pagar({venda_id:99})).status,409);await pagar();assert.equal(db.cliente.credito_saldo,970);});
test('centavos evitam arredondamento de saldos e rejeitam valores inválidos',async()=>{assert.deepEqual(distribuirPagamento(30,[{id:1,saldo_restante:.1},{id:2,saldo_restante:.2}]),{aplicado:30,credito:0,vendas:[{id:1,abatido:10,saldo:0},{id:2,abatido:20,saldo:0}]});assert.ok(Number.isNaN(centavos('x')));const {pagar,db}=fixture();for(const valor_pago of ['x',null,0,-1,Infinity])assert.equal((await pagar({valor_pago})).status,400);assert.equal(db.pags.length,0);});
test('interface calcula prévia da venda selecionada e reutiliza chave após falha de conexão',async()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',style:{},classList:{add(){},remove(){},toggle(){}},innerHTML:''});return nodes.get(id);};
  const enviados=[];
  const ctx=vm.createContext({console,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,document:{getElementById:el,addEventListener(){}},window:{addEventListener(){}},BB:{api:{post:async(p,b)=>{enviados.push(b);return {ok:false,erro:'Sem conexão'};}},fmt:{brl:n=>Number(n).toFixed(2)},toast(){}}});
  const html=fs.readFileSync(require('node:path').join(__dirname,'../public/fiado.html'),'utf8');
  for(const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))vm.runInContext(m[1],ctx);
  vm.runInContext("_clientes=[{id:1,nome:'Teste',saldo_aberto:830.02,credito_saldo:139.98}];_vendas=[{id:2,cliente_id:1,status:'aberto',saldo_restante:530.02}];resetPag();selecionarClientePag(_clientes[0]);",ctx);
  el('pag-valor').value='970';ctx.atualizarTotalPag();assert.match(el('pag-preview-txt').textContent,/139.98/);
  el('pag-venda-id').value='2';ctx.atualizarTotalPag();assert.match(el('pag-preview-txt').textContent,/439.98/);
  await ctx.confirmarPagamento();await ctx.confirmarPagamento();assert.equal(enviados[0].idempotencia,enviados[1].idempotencia);assert.equal(enviados[0].saldo_esperado,530.02);
});
