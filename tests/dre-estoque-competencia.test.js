'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('public/dre.html','utf8');
function trecho(nome,proximo){const a=html.indexOf('function '+nome+'('),b=html.indexOf('\nfunction '+proximo+'(',a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function motor(){const ctx={window:{_estoquesMes:{'08/2026':10000,'09/2026':12000,'10/2026':12000}},prepararBaseDRE:modo=>({modo:modo||'comp',sg:(grupo,mes)=>({RECEITAS:50000,CMV:-30000,PESSOAL:-5000}[grupo]||0)}),TXS:[],_txsSemDuplicatas:t=>t,mesRef:'09/2026',localStorage:{getItem:()=>null}};vm.createContext(ctx);vm.runInContext(trecho('calcularMotorDRE','_buildDRE'),ctx);return ctx;}
test('CMV competência = compras + inicial − final e final maior melhora lucro',()=>{
 const c=motor(),antes=c.calcularMotorDRE('09/2026','comp');assert.equal(antes.cmv,-28000);assert.equal(antes.lucroBruto,22000);assert.equal(antes.final,17000);
 c.window._estoquesMes['09/2026']=17000;const depois=c.calcularMotorDRE('09/2026','comp');assert.equal(depois.cmv,-23000);assert.equal(depois.final-antes.final,5000);
 const out=c.calcularMotorDRE('10/2026','comp');assert.equal(out.cmv,-35000);assert.equal(out.final,10000);
});
test('caixa não recebe ajuste de estoque e fechamento zero é legítimo',()=>{
 const c=motor();assert.equal(c.calcularMotorDRE('09/2026','caixa').cmv,-30000);c.window._estoquesMes['09/2026']=0;assert.equal(c.calcularMotorDRE('09/2026','comp').cmv,-40000);assert.equal(c.calcularMotorDRE('09/2026','caixa').final,15000);
});
test('estoque digitado recalcula demonstrativo aberto, conserva zero e grava cache da loja',()=>{
 const storage=new Map(),msgs=[],c={window:{_estoquesMes:{}},_estoquesMes:{},chaveEstoqueLocal:()=> 'bb_estoques_mes:33',localStorage:{setItem:(k,v)=>storage.set(k,v)},document:{getElementById:()=>({classList:{contains:()=>true}})},renderDRE:()=>msgs.push('dre'),renderDREFull:()=>msgs.push('full'),autoSv:()=>msgs.push('save'),toast:()=>msgs.push('erro')};vm.createContext(c);vm.runInContext(trecho('setEstoqueFinal','setFatManual'),c);
 c.setEstoqueFinal('09_2026','117413.26');assert.equal(c.window._estoquesMes['09/2026'],117413.26);assert.deepEqual(msgs,['dre','full','save']);c.setEstoqueFinal('09_2026','0');assert.equal(JSON.parse(storage.get('bb_estoques_mes:33'))['09/2026'],0);c.setEstoqueFinal('09_2026','-1');assert.equal(c.window._estoquesMes['09/2026'],0);assert.equal(msgs.at(-1),'erro');assert.equal(storage.has('bb_estoques_mes'),false);
});
test('estoque mais recente prevalece no carregamento e autosave ao sair inclui estoque',()=>{
 const a=html.indexOf('    for(const r of [...sessoes].reverse())'),b=html.indexOf('\n    _estoquesMes=',a);const c={sessoes:[{data:{dados_json:{estoquesMes:{'09/2026':0}}}},{data:{dados_json:{estoquesMes:{'09/2026':999}}}}],window:{_estoquesMes:{}}};vm.runInNewContext(html.slice(a,b),c);assert.equal(c.window._estoquesMes['09/2026'],0);
 const vis=html.slice(html.indexOf("document.addEventListener('visibilitychange'"),html.indexOf("window.addEventListener('beforeunload'"));assert.match(vis,/estoquesMes:window\._estoquesMes/);
});
test('detalhamento mantém célula de grupo abrangendo seis colunas em desktop',{skip:!process.env.BOMBEEF_JSDOM_MODULE},()=>{
 const {JSDOM}=require(process.env.BOMBEEF_JSDOM_MODULE);const css=fs.readFileSync('public/css/dre-v2.css','utf8');const dom=new JSDOM(`<style>${css}</style><table class="drill-table"><tr class="drill-group"><td colspan="6"><div class="drill-group-bar"><div class="drill-group-name"><strong>Fornecedor com nome extenso</strong><span>2 lançamentos</span></div><b>1 para conferir</b></div></td></tr></table>`);const td=dom.window.document.querySelector('td');assert.equal(dom.window.getComputedStyle(td).display,'table-cell');assert.equal(td.colSpan,6);assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('.drill-group-bar')).display,'flex');dom.window.close();
});
test('PostgreSQL: salvamento conserva estoque omitido e aceita zero sem tocar outra loja',{skip:!process.env.BOMBEEF_PGLITE_MODULE},async()=>{
 const {PGlite}=require(process.env.BOMBEEF_PGLITE_MODULE),db=new PGlite();
 try{
  await db.exec(`CREATE TABLE dre_sessoes(id int PRIMARY KEY,loja_id int,mes_ref text,descricao text,dados_json jsonb,usuario_id int,atualizado_em timestamptz DEFAULT now());INSERT INTO dre_sessoes VALUES(1,1,'09/2026','Original','{"transactions":[{"id":"antigo"}],"estoquesMes":{"09/2026":12000}}',1,now()),(2,33,'09/2026','Outra','{"transactions":[],"estoquesMes":{"09/2026":999}}',1,now());`);
  await db.exec('ALTER TABLE dre_sessoes ADD COLUMN res_receitas numeric, ADD COLUMN res_despesas numeric, ADD COLUMN res_cmv numeric, ADD COLUMN res_lucro_bruto numeric, ADD COLUMN res_lucro_op numeric, ADD COLUMN res_final numeric');
  const pool={query:async(sql,p)=> /^(UPDATE|INSERT INTO|SELECT id FROM) dre_sessoes/.test(sql.trim())?db.query(sql,p):({rows:[...(sql.includes('SELECT COUNT(*) FROM fornecedores_lookup')?[{count:11}]:[]) ]})};
  const router=require('../routes/dre')(pool),handler=router.stack.find(l=>l.route?.path==='/salvar').route.stack.at(-1).handle;let status=200,body;const res={status:n=>{status=n;return res;},json:b=>{body=b;return res;}};
  await handler({user:{id:1,lojaId:1},body:{sessao_id:1,mes_ref:'09/2026',dados_json:{transactions:[{id:'antigo'}]}}},res);assert.equal(status,200);assert.equal(body.ok,true);assert.equal((await db.query('SELECT dados_json FROM dre_sessoes WHERE id=1')).rows[0].dados_json.estoquesMes['09/2026'],12000);
  await handler({user:{id:1,lojaId:1},body:{sessao_id:1,mes_ref:'09/2026',dados_json:{transactions:[{id:'antigo'}],estoquesMes:{'09/2026':0}}}},res);const rows=(await db.query('SELECT dados_json FROM dre_sessoes ORDER BY id')).rows;assert.equal(rows[0].dados_json.estoquesMes['09/2026'],0);assert.equal(rows[0].dados_json.transactions[0].id,'antigo');assert.equal(rows[1].dados_json.estoquesMes['09/2026'],999);
  await handler({user:{id:1,lojaId:1},body:{sessao_id:1,mes_ref:'09/2026',dados_json:{transactions:[{id:'antigo'}],estoquesMes:{'08/2026':10000,'09/2026':12000}},resultado:motor().calcularMotorDRE('09/2026','comp')}},res);
  const oficial=(await db.query('SELECT res_cmv,res_lucro_bruto,res_final FROM dre_sessoes WHERE id=1')).rows[0];assert.equal(Number(oficial.res_cmv),-28000);assert.equal(Number(oficial.res_lucro_bruto),22000);assert.equal(Number(oficial.res_final),17000);
  await handler({user:{id:1,lojaId:1},body:{mes_ref:'09/2026',dados_json:{transactions:[{id:'antigo'}]}}},res);assert.equal((await db.query('SELECT dados_json FROM dre_sessoes WHERE id=1')).rows[0].dados_json.estoquesMes['09/2026'],12000);

 }finally{await db.close();}
});
test('demonstrativo compacto e completo exibem subtotal CMV e lucro ajustados',()=>{
 const c=motor(),mes='09/2026',data={RECEITAS:{Vendas:{[mes]:50000}},CMV:{Bovino:{[mes]:-30000}},PESSOAL:{Salário:{[mes]:-5000}}};
 c.prepararBaseDRE=modo=>({modo:modo||'comp',at:[{}],invalidos:[],data,dataNaoOper:{},meses:[mes],sg:(g,m)=>Object.values(data[g]||{}).reduce((s,x)=>s+(x[m]||0),0),sgt:g=>Object.values(data[g]||{}).reduce((s,x)=>s+(x[mes]||0),0)});
 c.getModo=()=> 'comp';c.CATS={RECEITAS:{l:'RECEITAS'},CMV:{l:'CMV'},PESSOAL:{l:'PESSOAL'}};c.fmt={brl:v=>Number(v).toFixed(2)};c.fmtMes=m=>m;c._showPct=false;c.document={getElementById:()=>({textContent:''})};c.requestAnimationFrame=()=>{};c.setTimeout=()=>{};
 vm.runInContext(trecho('_buildDRE','calcResultadoDRE'),c);
 for(const full of [false,true]){const el={innerHTML:'',querySelector:()=>null};c._buildDRE(el,full);const subtotal=el.innerHTML.match(/▶ SUBTOTAL CMV[\s\S]*?<\/tr>/)[0];assert.match(subtotal,/-28000\.00/);const lucro=el.innerHTML.match(/LUCRO BRUTO[\s\S]*?<\/tr>/)[0];assert.match(lucro,/22000\.00/);assert.match(el.innerHTML,/step="0.01"/);}
});
test('Excel numérico reproduz CMV e lucro de competência sem aplicar estoque ao caixa',()=>{
 const c=motor(),mes='09/2026',data={RECEITAS:{Vendas:{[mes]:50000}},CMV:{Bovino:{[mes]:-30000}},PESSOAL:{Salário:{[mes]:-5000}}};
 c.prepararBaseDRE=modo=>({modo,data,meses:[mes],sg:(g,m)=>Object.values(data[g]||{}).reduce((s,x)=>s+(x[m]||0),0)});c.nomeMes=m=>m;
 const a=html.indexOf('  function montarDados(modo)'),b=html.indexOf('  const modosExport',a);vm.runInContext(html.slice(a,b),c);
 const comp=c.montarDados('comp').rows,caixa=c.montarDados('caixa').rows;
 assert.equal(comp.find(r=>r[0]==='SUBTOTAL CMV')[1],-28000);assert.equal(comp.find(r=>r[0]==='LUCRO BRUTO')[1],22000);assert.equal(comp.find(r=>String(r[0]).includes('Ajuste de Estoque'))[1],2000);
 assert.equal(caixa.find(r=>r[0]==='SUBTOTAL CMV')[1],-30000);assert.equal(caixa.some(r=>String(r[0]).includes('Ajuste de Estoque')),false);
});
