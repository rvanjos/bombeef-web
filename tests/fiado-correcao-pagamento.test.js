'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../lib/fiado-correcao-pagamento');
const body=(extra={})=>({valor_pago:500,forma_pagamento:'pix',data_pagamento:'2026-11-27',observacoes:'Corrigido',motivo:'Valor digitado incorretamente',versao:0,idempotencia:'correcao-fiado-00000001',saldo_esperado:0,credito_esperado:139.98,venda_id:null,...extra});
const pag={id:1,cliente_id:2,loja_id:3,versao:0,valor_pago:970,credito_gerado:139.98,credito_utilizado:0,forma_pagamento:'dinheiro'};
const vendas=[{id:10,cliente_id:2,loja_id:3,data_compra:'2026-10-01',total_final:300,saldo_restante:0,status:'pago'},{id:11,cliente_id:2,loja_id:3,data_compra:'2026-11-01',total_final:530.02,saldo_restante:0,status:'pago'}];
const rateios=[{venda_id:10,valor_abatido:300},{venda_id:11,valor_abatido:530.02}];
test('corrige excesso para parcial, exato, novo excesso e estorno zero sem alterar originais',()=>{
 for(const [valor,saldo,credito] of [[500,33002,0],[830.02,0,0],[900,0,6998],[0,83002,0]]){const antes=JSON.stringify([pag,vendas,rateios]);const r=C.planejar(pag,{credito_saldo:139.98},vendas,rateios,body({valor_pago:valor}));assert.equal(r.vendas.reduce((s,v)=>s+v.saldo,0),saldo);assert.equal(r.credito,credito);assert.equal(r.recebido,Math.round(valor*100));assert.equal(JSON.stringify([pag,vendas,rateios]),antes);}
});
test('direcionamento respeita a venda escolhida e devolve abatimentos da outra',()=>{const r=C.planejar(pag,{credito_saldo:139.98},vendas,rateios,body({valor_pago:600,venda_id:11}));assert.equal(r.vendas[0].saldo,30000);assert.equal(r.vendas[1].saldo,0);assert.equal(r.gerado,6998);});
test('não apaga pagamentos posteriores e bloqueia crédito consumido sem cobertura',()=>{
 const antigo={...pag,valor_pago:300,credito_gerado:0};const vs=[{...vendas[0],total_final:500,saldo_restante:100,status:'parcial'}];const r=C.planejar(antigo,{credito_saldo:0},vs,[{venda_id:10,valor_abatido:300}],body({valor_pago:200}));assert.equal(r.vendas[0].saldo,20000);
 assert.throws(()=>C.planejar(pag,{credito_saldo:0},vendas,rateios,body()),/já foi utilizado/);
});
test('corrigir uso de crédito devolve somente a diferença e não cria recebimento',()=>{
 const p={...pag,valor_pago:0,credito_gerado:0,credito_utilizado:300};const r=C.planejar(p,{credito_saldo:0},[vendas[0]],[rateios[0]],body({valor_pago:100,forma_pagamento:'saldo_cliente'}));assert.equal(r.credito,20000);assert.equal(r.recebido,0);assert.equal(r.utilizado,10000);
});
test('dados inválidos, rateio incompleto e venda cancelada são bloqueados',()=>{
 for(const extra of [{valor_pago:null},{valor_pago:-1},{valor_pago:'x'},{versao:null},{data_pagamento:'2026-02-31'},{motivo:'x'},{venda_id:-1}])assert.throws(()=>C.validar(body(extra)));
 assert.throws(()=>C.planejar(pag,{credito_saldo:139.98},vendas,[],body()),/rateio completo/);
 assert.throws(()=>C.planejar(pag,{credito_saldo:139.98},[{...vendas[0],status:'cancelado'},vendas[1]],rateios,body()),/cancelada/);
});
test('somente admin e gerente explicitamente autorizado corrigem pagamentos',()=>{
 assert.equal(C.podeCorrigir({perfil:'admin'}),true);assert.equal(C.podeCorrigir({perfil:'gestor',permissoes:{fiado_corrigir_pagamentos:true}}),true);
 for(const u of [{perfil:'gestor'},{perfil:'caixa',permissoes:{fiado_corrigir_pagamentos:true}},{perfil:'financeiro'},{perfil:'gestor',permissoes:{fiado_pagamentos:true}}])assert.equal(C.podeCorrigir(u),false);
});
function fixture({falha=false}={}){
 let estado={pag:structuredClone(pag),cliente:{id:2,loja_id:3,credito_saldo:139.98},vendas:structuredClone(vendas),rateios:rateios.map(r=>({...r,revisao:0})),revisoes:[],historico:[]},fila=Promise.resolve();const sqls=[];
 const pool={async connect(){let liberar=null,snapshot=null;return {release(){},async query(sql,p=[]){sqls.push(sql);
  if(sql==='BEGIN')return {rows:[]};
  if(sql==='COMMIT'||sql==='ROLLBACK'){if(sql==='ROLLBACK'&&snapshot)estado=snapshot;if(liberar){liberar();liberar=null;}return {rows:[]};}
  if(sql.startsWith('SELECT cliente_id'))return {rows:p[1]===3?[{cliente_id:2}]:[]};
  if(sql.startsWith('SELECT * FROM clientes_fiado')){const anterior=fila;fila=new Promise(r=>liberar=r);await anterior;snapshot=structuredClone(estado);return {rows:p[1]===3?[structuredClone(estado.cliente)]:[]};}
  if(sql.startsWith('SELECT requisicao'))return {rows:estado.revisoes.filter(r=>r.idempotencia===p[1])};
  if(sql.startsWith('SELECT * FROM pagamentos_fiado'))return {rows:[structuredClone(estado.pag)]};
  if(sql.startsWith('SELECT * FROM vendas_fiado'))return {rows:structuredClone(estado.vendas)};
  if(sql.startsWith('SELECT venda_id'))return {rows:estado.rateios.filter(r=>r.revisao===p[2]).map(r=>({...r}))};
  if(sql.startsWith('UPDATE vendas_fiado'))Object.assign(estado.vendas.find(v=>v.id===p[2]),{saldo_restante:p[0],status:p[1]});
  if(sql.startsWith('INSERT INTO pagamento_venda_fiado'))estado.rateios.push({venda_id:p[1],valor_abatido:p[2],revisao:p[4]});
  if(sql.startsWith('UPDATE clientes_fiado'))estado.cliente.credito_saldo=p[0];
  if(sql.startsWith('UPDATE pagamentos_fiado')){Object.assign(estado.pag,{valor_pago:p[0],credito_gerado:p[1],credito_utilizado:p[2],data_pagamento:p[3],forma_pagamento:p[4],observacoes:p[5],versao:p[6]});return {rows:[{...estado.pag}]};}
  if(sql.startsWith('INSERT INTO fiado_pagamento_revisoes')){if(falha)throw Error('falha gravando revisão');estado.revisoes.push({idempotencia:p[3],requisicao:JSON.parse(p[4]),antes:JSON.parse(p[5]),depois:JSON.parse(p[6])});}
  if(sql.startsWith('INSERT INTO historico_fiado'))estado.historico.push(p);
  return {rows:[]};
 }}}};return {pool,get db(){return estado},sqls};
}
test('transação preserva rateios originais, grava revisão com autor e atualiza os saldos',async()=>{
 const f=fixture();await C.corrigir(f.pool,1,3,{id:9,nome:'Gerente',perfil:'gestor',permissoes:{fiado_corrigir_pagamentos:true}},body());assert.equal(f.db.cliente.credito_saldo,0);assert.equal(f.db.pag.versao,1);assert.equal(f.db.pag.valor_pago,500);assert.equal(f.db.rateios.filter(r=>r.revisao===0).length,2);assert.equal(f.db.revisoes[0].antes.pagamento.valor_pago,970);assert.equal(f.db.historico.length,1);assert.equal(f.sqls.at(-1),'COMMIT');assert.ok(f.sqls.filter(s=>/FOR UPDATE/.test(s)).length>=3);assert.ok(!f.sqls.some(s=>/DELETE|TRUNCATE/.test(s)));
});
test('repetição concorrente é idempotente e versão antiga bloqueia outra correção',async()=>{
 const f=fixture();const rs=await Promise.all([C.corrigir(f.pool,1,3,{id:9,nome:'Admin',perfil:'admin'},body()),C.corrigir(f.pool,1,3,{id:9,nome:'Admin',perfil:'admin'},body())]);assert.equal(f.db.revisoes.length,1);assert.equal(rs[1].repetido,true);
 await assert.rejects(C.corrigir(f.pool,1,3,{id:9,nome:'Admin',perfil:'admin'},body({idempotencia:'correcao-fiado-00000002'})),/foi alterado/);assert.equal(f.db.pag.valor_pago,500);
});
test('outra loja, saldo stale e falha de auditoria deixam os dados intactos',async()=>{
 for(const opt of [{loja:4},{saldo:1},{falha:true}]){const f=fixture(opt),antes=JSON.stringify(f.db);await assert.rejects(C.corrigir(f.pool,1,opt.loja||3,{id:9,nome:'Admin',perfil:'admin'},body(opt.saldo?{saldo_esperado:opt.saldo}:{})));assert.equal(JSON.stringify(f.db),antes);assert.equal(f.sqls.at(-1),'ROLLBACK');}
});
test('extrato consulta somente rateio da revisão vigente e a interface oferece correção',()=>{
 const s=fs.readFileSync('routes/fiado.js','utf8');assert.match(s,/pv.revisao=p.versao/);assert.match(s,/r.put\('\/pagamentos\/:id\/correcao',exigirCorrecao/);const h=fs.readFileSync('public/fiado.html','utf8');assert.match(h,/botaoCorrigirPagamento\(p.id\)/);assert.match(h,/corrigir_pagamentos/);
});

test('segunda correção utiliza somente a revisão vigente e mantém todas as anteriores',async()=>{
 const f=fixture();await C.corrigir(f.pool,1,3,{id:9,nome:'Admin',perfil:'admin'},body());await C.corrigir(f.pool,1,3,{id:9,nome:'Admin',perfil:'admin'},body({versao:1,valor_pago:400,saldo_esperado:330.02,credito_esperado:0,idempotencia:'correcao-fiado-00000002'}));assert.equal(f.db.pag.versao,2);assert.equal(f.db.vendas[1].saldo_restante,430.02);assert.equal(f.db.revisoes.length,2);assert.equal(f.db.revisoes[0].antes.pagamento.valor_pago,970);assert.equal(f.db.revisoes[1].antes.pagamento.valor_pago,500);assert.equal(f.db.rateios.filter(r=>r.revisao===0).length,2);
});

test('aliases do Fiado compartilham a inicialização aditiva sem criar a auditoria duas vezes',async()=>{
 const router=require('../routes/fiado'),sqls=[];const pool={query:async s=>{sqls.push(s);return {rows:[]};}};router(pool);router(pool);await new Promise(r=>setImmediate(r));assert.equal(sqls.filter(s=>s.includes('CREATE TABLE IF NOT EXISTS fiado_pagamento_revisoes')).length,1);
});
