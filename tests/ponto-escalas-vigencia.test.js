'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const E=require('../lib/ponto-escala');
const dias=(folga=1)=>Array.from({length:7},(_,dia_semana)=>({dia_semana,folga:dia_semana===folga,horario_entrada:dia_semana===0?'09:00':'10:00',horario_saida:dia_semana===0?'14:00':'19:00',intervalo_min:dia_semana===0?0:60}));
const config=(extra={})=>({vigencia_inicio:'2026-11-03',dias:dias(),domingo_ciclo:2,domingo_base:'2026-11-08',...extra});
const versao=(extra={})=>({id:1,funcionario_id:4,loja_id:2,...E.validarEscala(config(),'2026-11-03'),...extra});
test('valida sete dias, horários, intervalo, vigência e domingo de referência',()=>{
 for(const extra of [{vigencia_inicio:'2026-11-02'},{vigencia_inicio:'2026-02-30'},{dias:dias().slice(1)},{dias:dias().map(d=>({...d,dia_semana:0}))},{domingo_base:'2026-11-09'},{domingo_ciclo:4},{dias:dias().map(d=>({...d,horario_saida:'08:00'}))},{dias:dias().map(d=>({...d,intervalo_min:-1}))}])assert.throws(()=>E.validarEscala(config(extra),'2026-11-03'),JSON.stringify(extra));
 const c=E.validarEscala(config(),'2026-11-03');assert.equal(c.dias[0].jornada_horas,5);assert.equal(c.dias[0].intervalo_min,0);assert.equal(c.dias[1].jornada_horas,0);
});
test('rodízios 1T/1F e 2T/1F atravessam meses e mantêm a outra folga semanal',()=>{
 for(const [ciclo,expected] of [[2,[false,true,false,true,false,true]],[3,[false,false,true,false,false,true]]]){
  const v=versao({domingo_ciclo:ciclo});const domingos=['2026-11-08','2026-11-15','2026-11-22','2026-11-29','2026-12-06','2026-12-13'];
  assert.deepEqual(domingos.map(data=>E.resolverEscala([v],4,2,data).folga),expected);
  assert.equal(E.resolverEscala([v],4,2,'2026-11-09').folga,true);
 }
});
test('vigência futura 5x2 não muda passado; revisão do mesmo início preserva versões',()=>{
 const a=versao(),b=versao({id:2,vigencia_inicio:'2026-12-01',dias:E.validarEscala(config({dias:dias().map(d=>({...d,folga:[1,2].includes(d.dia_semana)})),domingo_ciclo:0}),'2026-11-03').dias,domingo_ciclo:0});
 assert.equal(E.resolverEscala([a,b],4,2,'2026-11-10').folga,false);assert.equal(E.resolverEscala([a,b],4,2,'2026-12-01').folga,true);
 assert.equal(E.resolverEscala([a,b,{...b,id:3}],4,2,'2026-12-02').escala_id,3);assert.equal(E.resolverEscala([a,b],4,3,'2026-12-02'),null);assert.equal(E.resolverEscala([a],5,2,'2026-12-02'),null);
});
function bancoMock(falhar=false){const calls=[];const c={query:async(sql,params)=>{calls.push({sql,params});if(sql.startsWith('SELECT * FROM funcionarios'))return {rows:[{id:4,loja_id:2,horario_entrada:'10:00',horario_saida:'19:00',intervalo_min:60,jornada_horas:8}]};if(sql.startsWith('SELECT id FROM ponto_escalas'))return {rows:[]};if(sql.startsWith('SELECT * FROM ponto_jornada_dia'))return {rows:[{dia_semana:0,folga:true,jornada_horas:null,intervalo_min:null}]};if(sql.includes('RETURNING *')){if(falhar)throw Error('Falha simulada');return {rows:[{id:2}]};}return {rows:[]};},release(){calls.push({sql:'RELEASE'});}};return {calls,pool:{connect:async()=>c}};}
test('salvamento transacional preserva legado e registra versão com usuário e loja',async()=>{
 const {calls,pool}=bancoMock();await E.salvarEscala(pool,4,2,9,E.validarEscala(config(),'2026-11-03'));
 assert.match(calls[1].sql,/loja_id=\$2.*FOR UPDATE/);const inserts=calls.filter(c=>c.sql.startsWith('INSERT'));assert.equal(inserts.length,2);assert.equal(JSON.parse(inserts[0].params[2])[0].jornada_horas,0);assert.equal(inserts[1].params[1],2);assert.equal(inserts[1].params[6],9);assert.ok(calls.some(c=>c.sql==='COMMIT'));assert.ok(!calls.some(c=>/DELETE|UPDATE ponto_jornada_dia/.test(c.sql)));
});
test('erro na versão desfaz também a cópia inicial do legado',async()=>{const {calls,pool}=bancoMock(true);await assert.rejects(E.salvarEscala(pool,4,2,9,E.validarEscala(config(),'2026-11-03')));assert.ok(calls.some(c=>c.sql==='ROLLBACK'));assert.equal(calls.at(-1).sql,'RELEASE');});
test('migração aditiva e RLS isolam versões por loja',async()=>{const sql=[];await E.initEscalas({query:async s=>sql.push(s)});assert.ok(sql.some(s=>s.includes('FORCE ROW LEVEL SECURITY')));assert.ok(sql.some(s=>s.includes("app.loja_id")));assert.ok(!sql.some(s=>/DROP|TRUNCATE|DELETE/.test(s)));});
test('apuração usa domingo escalado de cinco horas sem extra e distingue domingo de folga',async()=>{
 const s=fs.readFileSync(require.resolve('../routes/ponto'),'utf8');
 for(const [data,extra] of [['2026-11-08',0],['2026-11-15',300]]){
  const p={id:1,funcionario_id:4,loja_id:2,data_ref:data,entrada:data+'T12:00:00Z',saida:data+'T17:00:00Z',jornada_horas_efetiva:0,intervalo_min_efetivo:60,aprovacao_status:'pendente'},calls=[];
  const c={pool:{query:async(sql,params)=>{calls.push({sql,params});return {rows:sql.trim().startsWith('SELECT')?[p]:[{extra_minutos:params[0]}]};}},escalaDia:async()=>E.resolverEscala([versao()],4,2,data),calcHoras:()=>5,calcularExtraMinutos:(horas,prev)=>Math.max(0,Math.round((horas-prev)*60)),calcularIntervaloSuprimido:()=>0};
  vm.createContext(c);vm.runInContext(s.slice(s.indexOf('async function atualizarApuracaoPonto('),s.indexOf('async function recalcularPendenciasRecentes(')),c);const r=await c.atualizarApuracaoPonto(1);assert.equal(r.extra_minutos,extra);assert.equal(p.entrada,data+'T12:00:00Z');
 }
});
test('leitores de cartão, calendário e premiação usam o mesmo resolvedor de vigência',()=>{
 const p=fs.readFileSync(require.resolve('../routes/ponto'),'utf8'),rh=fs.readFileSync(require.resolve('../routes/rh'),'utf8'),ui=fs.readFileSync(require.resolve('../public/rh.html'),'utf8');assert.match(p,/calendario_jornada/);assert.match(p,/resolverEscala\(vs,p.funcionario_id/);assert.match(rh,/calendario_escala\[data\]=!d.folga/);assert.match(rh,/trabalhaVigente\(f,fds.domingo\)/);assert.match(ui,/calendario.get\(data\)\|\|jornadas.get/);
});
test('calendário aceita vigência no meio do mês sem configuração legada',async()=>{
 const s=fs.readFileSync(require.resolve('../public/rh.html'),'utf8'),nodes={'escala-mes-label':{},'escala-cal-container':{}},calls=[];
 const c={_escalaMes:{ano:2026,mes:10},MESES:Array(12).fill('Mês'),_escalasConfig:[],document:{getElementById:id=>nodes[id]},get:async url=>{calls.push(url);return {ok:true,data:[{id:4,nome:'Lucas Teste',calendario_escala:{'2026-11-08':true,'2026-11-15':false}}]};}};
 vm.createContext(c);vm.runInContext(s.slice(s.indexOf('async function renderEscala()'),s.indexOf('async function abrirConfigEscala()')),c);await c.renderEscala();assert.match(calls[0],/de=2026-11-01&ate=2026-11-30/);assert.match(nodes['escala-cal-container'].innerHTML,/Lucas/);assert.doesNotMatch(nodes['escala-cal-container'].innerHTML,/Erro:/);
});
