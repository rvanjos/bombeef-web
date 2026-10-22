'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chaveSSE,publicarSSE}=require('../lib/sse-tenant');
const {executarNaLoja}=require('../lib/tenant-context');
const {politicaCors}=require('../lib/cors-policy');
test('eventos SSE não atravessam lojas e sem contexto não são publicados',()=>{
 const a=[],b=[],map=new Map([['1:dre',new Set([{write:x=>a.push(x)}])],['2:dre',new Set([{write:x=>b.push(x)}])]]);
 executarNaLoja(1,()=>publicarSSE(map,'dre',{type:'atualizado'}));
 assert.equal(a.length,1);assert.equal(b.length,0);
 publicarSSE(map,'dre',{type:'global'});assert.equal(a.length,1);
 executarNaLoja(2,()=>publicarSSE(map,'dre',{type:'outra'}));assert.equal(b.length,1);
});
test('canais SSE inválidos e lojas ausentes falham fechados',()=>{
 for(const [id,c] of [[null,'dre'],[1,['dre']],[1,'1:dre'],[0,'geral'],[1,'x'.repeat(51)]])assert.equal(chaveSSE(id,c),null);
 assert.equal(chaveSSE(1,'estoque'),'1:estoque');
});
test('CORS produção permite somente origens listadas, sem bloquear chamadas sem Origin',()=>{
 const p=politicaCors({NODE_ENV:'production',ALLOWED_ORIGIN:'https://loja.exemplo, https://outra.exemplo'});
 for(const [o,ok] of [['https://hostil.exemplo',false],['null',false],['https://loja.exemplo',true],[undefined,true],['https://bombeef-web-production.up.railway.app',true]])p.origin(o,(err,res)=>{assert.equal(err,null);assert.equal(res,ok)});
});
test('auditoria mascara variantes de segredos em objetos aninhados',()=>{
 const {limpar}=require('../lib/auditoria');const out=limpar({nome:'Exemplo',config:{client_secret:'falso',GOOGLE_DRIVE_PRIVATE_KEY:'falso',DATABASE_URL:'falso',OPENAI_API_KEY:'falso'},senha:'falso'});
 assert.equal(out.nome,'Exemplo');assert.equal(out.senha,'[PROTEGIDO]');for(const v of Object.values(out.config))assert.equal(v,'[PROTEGIDO]');
});
const dre=fs.readFileSync('routes/dre.js','utf8');
function beaconFixture(fechado,mesSessao='10/2026'){
 const trecho=dre.slice(dre.indexOf("  r.post('/salvar-beacon'"),dre.indexOf('// ── DELETE /sessoes',dre.indexOf("  r.post('/salvar-beacon'")));
 let h;const queries=[],r={post(_p,_m,handler){h=handler}};
 const pool={async query(sql,p){queries.push({sql,p});return {rows:sql.startsWith('SELECT')?[{dados_json:{transactions:[]},mes_ref:mesSessao}]:[]}}};
 new Function('r','autoPublish','pool','bloquearSeFechado','extrairTransacoes','mergeTransacoes','espelharLancamentos',trecho)(r,()=>{},pool,async()=>fechado,()=>[],()=>[],async()=>{});
 return {queries,async run(){const result={};const res={status(n){result.status=n;return this},json(b){result.body=b;return this},sendStatus(n){result.status=n;return this}};await h({body:{sessao_id:5,mes_ref:'10/2026',dados_json:{transactions:[]}},user:{lojaId:1}},res);return result}};
}
test('beacon rejeita mês fechado sem gravar',async()=>{const f=beaconFixture(true);assert.equal((await f.run()).status,423);assert.equal(f.queries.length,0)});
test('beacon não permite usar mês aberto para adulterar outra sessão',async()=>{const f=beaconFixture(false,'09/2026');assert.equal((await f.run()).status,409);assert.ok(!f.queries.some(q=>q.sql.startsWith('UPDATE')))});
test('beacon válido consulta e altera somente sessão da loja ativa',async()=>{const f=beaconFixture(false);assert.equal((await f.run()).status,204);for(const q of f.queries)assert.match(q.sql,/loja_id=/);assert.deepEqual(f.queries[0].p,[5,1])});
test('exclusão de sessão fechada é bloqueada antes de DELETE',async()=>{
 const inicio=dre.indexOf("  r.delete('/sessoes/:id'");const trecho=dre.slice(inicio,dre.indexOf('\n  });',inicio)+6);let h,deletou=false;
 new Function('r','autoPublish','pool','bloquearSeFechado',trecho)({delete(_p,_m,handler){h=handler}},()=>{}, {async query(sql){if(sql.startsWith('DELETE'))deletou=true;return{rows:[{mes_ref:'10/2026'}]}}},async()=>true);
 let status;const res={status(n){status=n;return this},json(){return this}};await h({params:{id:'1'},user:{lojaId:1}},res);assert.equal(status,423);assert.equal(deletou,false);
});
test('multipart usa limite de tamanho e mantém compatibilidade com Multer atualizado',async()=>{
 const express=require('express'),multer=require('multer'),app=express();
 app.post('/upload',multer({storage:multer.memoryStorage(),limits:{fileSize:10}}).single('arquivo'),(req,res)=>res.json({size:req.file.buffer.length}));
 app.use((err,req,res,next)=>res.status(err.code==='LIMIT_FILE_SIZE'?413:400).end());
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const [len,status] of [[3,200],[20,413]]){const form=new FormData();form.append('arquivo',new Blob(['x'.repeat(len)]),'teste.txt');const res=await fetch(`http://127.0.0.1:${server.address().port}/upload`,{method:'POST',body:form});assert.equal(res.status,status)}}finally{await new Promise(r=>server.close(r))}
});
test('SheetJS atualizado lê arquivo XLSX válido',()=>{
 const x=require('xlsx'),wb=x.utils.book_new();x.utils.book_append_sheet(wb,x.utils.aoa_to_sheet([['Valor'],[139.98]]),'Dados');const read=x.read(x.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});assert.equal(read.Sheets.Dados.A2.v,139.98);
});
