'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {validarPeriodo}=require('../lib/kit-periodo');
test('valida ordem e calendário, mantendo kits sem período compatíveis',()=>{
  for(const p of [[null,null],['2026-10-26','2026-10-30'],['2026-10-26','2026-10-26'],['2026-10-26',null]])assert.equal(validarPeriodo(...p),null);
  for(const p of [['2026-10-30','2026-10-26'],['2026-02-30',null],['26/10/2026',null]])assert.ok(validarPeriodo(...p));
});
function fixture(method){
  const queries=[];const client={release(){},async query(sql,p){queries.push({sql,p});return {rows:sql.includes('information_schema')?[{column_name:'nome'}]:sql.includes('INSERT INTO kits')?[{id:7}]:sql.includes('AS custo')?[{custo:0}]:[]}}};
  const router=require('../routes/kits')({query:async()=>({rows:[]}),connect:async()=>client});
  const h=router.stack.find(x=>x.route?.path===(method==='post'?'/':'/:id')&&x.route.methods[method]).route.stack.at(-1).handle;
  return {queries,async run(body){const res={status(n){this.code=n;return this},json(b){this.body=b;return this}};await h({body,params:{id:'7'},user:{id:1,lojaId:1}},res);return res}};
}
test('criação persiste início e fim junto ao kit',async()=>{
  const f=fixture('post'),r=await f.run({nome:'Kit',codigo:'X',dataInicio:'2026-10-26',dataFim:'2026-10-30'});
  assert.equal(r.body.ok,true);const q=f.queries.find(q=>q.sql.includes('INSERT INTO kits'));assert.match(q.sql,/data_inicio,data_fim/);assert.deepEqual(q.p.slice(-2),['2026-10-26','2026-10-30']);
});
test('edição preserva datas omitidas e permite limpar datas explicitamente',async()=>{
  for(const body of [{nome:'Novo'},{nome:'Novo',dataInicio:null,dataFim:null}]){
    const f=fixture('put'),r=await f.run(body);assert.equal(r.body.ok,true);const q=f.queries.find(q=>q.sql.includes('UPDATE kits SET'));
    assert.match(q.sql,/CASE WHEN \$8/);assert.deepEqual(q.p.slice(-2),[body.dataInicio!==undefined,body.dataFim!==undefined]);
  }
});
test('período invertido é recusado antes de gravar na criação e edição',async()=>{
  for(const method of ['post','put']){const f=fixture(method),r=await f.run({nome:'Kit',dataInicio:'2026-10-30',dataFim:'2026-10-26'});assert.equal(r.code,400);assert.equal(f.queries.length,0);}
});
test('filtro encontra kits vigentes em parte do período, com limites inclusivos',()=>{
  const src=fs.readFileSync('public/kits-composicao.html','utf8');let result;
  const els={'busca-k':{value:''},'kits-de':{value:'2026-10-30'},'kits-ate':{value:'2026-11-02'}};
  const ctx={document:{getElementById:id=>els[id]},kits:[{nome:'A',data_inicio:'2026-10-26T00:00:00.000Z',data_fim:'2026-10-30T00:00:00.000Z'},{nome:'B',data_inicio:'2026-11-03',data_fim:'2026-11-05'},{nome:'C',data_inicio:null,data_fim:null}],renderK:a=>result=a,toast(){}};
  vm.runInNewContext(src.slice(src.indexOf('function filtrarK(){'),src.indexOf('function calcCustoTotalKit(')),ctx);
  ctx.filtrarK();assert.deepEqual(result.map(k=>k.nome),['A']);assert.equal(ctx.dataKit('2026-10-26T00:00:00.000Z'),'2026-10-26');assert.equal(ctx.periodoKit(ctx.kits[0]),'26/10/2026 até 30/10/2026');
  els['kits-de'].value='';els['kits-ate'].value='';ctx.filtrarK();assert.equal(result.length,3);
  els['busca-k'].value='b';ctx.filtrarK();assert.deepEqual(result.map(k=>k.nome),['B']);
});
