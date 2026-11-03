'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const {validarPeriodo,editarAusencia}=require('../lib/ponto-ausencia');
const html=fs.readFileSync(require.resolve('../public/rh.html'),'utf8'),rota=fs.readFileSync(require.resolve('../routes/ponto'),'utf8');
const body=()=>({tipo:'afastamento',data_inicio:'2026-10-15',data_fim:'2026-10-31',motivo:'Retorno',observacao:'Nota',status:'ativo',versao:2,justificativa:'Retornou antes'});
test('datas inválidas/invertidas e tipos desconhecidos não chegam ao banco',async()=>{
 for(const extra of [{data_fim:'2026-10-01'},{data_fim:'2026-02-30'},{data_inicio:'03/11/2026'},{tipo:'x'},{versao:-1},{justificativa:''},{status:'x'}]){
  let calls=0;await assert.rejects(editarAusencia({query:async()=>{calls++;}}, {id:9,lojaId:7},3,{...body(),...extra}));assert.equal(calls,0);
 }
 assert.equal(validarPeriodo(body()).data_fim,'2026-10-31');
});
test('edição é atômica, isolada por loja, preserva antes/depois e não altera batidas',async()=>{
 let sql,params;const row={id:3,status:'ativo',versao:3};const r=await editarAusencia({query:async(s,p)=>{sql=s;params=p;return {rows:[row]};}},{id:9,lojaId:7},3,body());
 assert.equal(r,row);assert.match(sql,/a.loja_id=\$11 AND a.versao=\$12/);assert.match(sql,/to_jsonb\(a\)-'historico_edicoes'/);assert.match(sql,/\$9::integer/);assert.equal(params[8],9);assert.equal(params[10],7);assert.equal(params[11],2);assert.equal(JSON.parse(params[6]).data_fim,'2026-10-31');assert.doesNotMatch(sql,/DELETE|ponto_registros|funcionario_id=/);
});
test('saldo de versão obsoleta, outro funcionário/loja ou registro inexistente não é sobrescrito',async()=>{
 await assert.rejects(editarAusencia({query:async()=>({rows:[]})},{id:9,lojaId:8},3,body()),e=>e.status===409);
});
test('reativar cancelado exige decisão explícita de status e mantém auditoria',async()=>{
 let params;await editarAusencia({query:async(s,p)=>{params=p;return {rows:[{id:3}]};}},{id:9,lojaId:7},3,body());assert.equal(params[5],'ativo');
 await editarAusencia({query:async(s,p)=>{params=p;return {rows:[{id:3}]};}},{id:9,lojaId:7},3,{...body(),status:'cancelado'});assert.equal(params[5],'cancelado');
});
function uiFixture(){
 const nodes={},messages=[],calls=[];const c={document:{getElementById:id=>nodes[id]||(nodes[id]={value:'',checked:false,style:{},scrollIntoView(){}})},toast:s=>messages.push(s),window:{prompt:()=> '2026-10-24'},post:async(u,b)=>{calls.push({u,b});return {ok:false,erro:'Mudou'};},put:async(u,b)=>{calls.push({u,b});return {ok:false,erro:'Mudou'};},confirm:()=>true,carregarJornadaAusencias:async()=>{}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('const _jaAusencias=new Map()'),html.indexOf('function abrirConfJornada()')),c);return {c,nodes,calls,messages};
}
test('retorno antecipado conserva dias afastados até a véspera e não grava antes de conferir',()=>{
 const {c,nodes,calls}=uiFixture();vm.runInContext("_jaAusencias.set(3,{id:3,funcionario_id:4,status:'ativo',versao:2,tipo:'afastamento',data_inicio:'2026-10-15',data_fim:'2026-11-15'})",c);c.retornoAntecipadoRH(3);assert.equal(nodes['ja-aus-fim'].value,'2026-10-23');assert.equal(nodes['ja-aus-ini'].value,'2026-10-15');assert.equal(nodes['ja-aus-just'].value,'Retorno antecipado em 2026-10-24');assert.equal(calls.length,0);assert.equal(c.ultimoDiaAusencia('2026-03-01'),'2026-02-28');assert.equal(c.ultimoDiaAusencia('2026-02-30'),null);
});
test('edição de cancelado não reativa por padrão e falha de gravação mantém formulário',async()=>{
 const {c,nodes,calls}=uiFixture();vm.runInContext("_jaAusencias.set(3,{id:3,funcionario_id:4,status:'cancelado',versao:2,tipo:'afastamento',data_inicio:'2026-10-15',data_fim:'2026-11-15'})",c);
 c.editarAusenciaRH(3);c.document.getElementById('ja-func').value='4';nodes['ja-aus-just'].value='Corrigir fim';nodes['ja-aus-fim'].value='2026-10-23';await c.salvarAusenciaRH();assert.equal(calls[0].b.status,'cancelado');assert.equal(nodes['ja-aus-fim'].value,'2026-10-23');nodes['ja-aus-reativar'].checked=true;await c.salvarAusenciaRH();assert.equal(calls[1].b.status,'ativo');assert.equal(calls[1].b.versao,2);
});
test('permissão de editar continua restrita à gestão',async()=>{
 let handler,calls=0;const c={r:{put:(p,h)=>handler=h},editarAusencia:async()=>calls++,pool:{}};vm.createContext(c);vm.runInContext(rota.slice(rota.indexOf("r.put('/ausencias/:id'"),rota.indexOf("r.post('/ausencias/:id/cancelar'")),c);let status;await handler({user:{perfil:'caixa'},body:{},params:{}},{status:s=>{status=s;return {json(){}};}});assert.equal(status,403);assert.equal(calls,0);
});
