'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
function fixture(){
 const funcionarios=[{id:11,usuario_id:7,loja_id:1},{id:22,usuario_id:8,loja_id:1},{id:33,usuario_id:7,loja_id:2}];
 const docs=[{id:101,funcionario_id:11,loja_id:1,status:'ativo',visualizado_em:null,storage_key:'a.pdf',arquivo_mime:'application/pdf',arquivo_nome:'a.pdf'},{id:202,funcionario_id:22,loja_id:1,status:'ativo',visualizado_em:'2026-11-01',storage_key:'b.pdf'},{id:303,funcionario_id:33,loja_id:2,status:'ativo',visualizado_em:'2026-11-01',storage_key:'c.pdf'}];
 let downloads=0;const sqls=[];
 const pool={async query(sql,p=[]){sqls.push({sql,p});assert.equal(Math.max(0,...[...sql.matchAll(/\$(\d+)/g)].map(x=>Number(x[1]))),p.length);
   if(sql.includes('SELECT f.id,f.nome,f.usuario_id')){assert.match(sql,/f\.loja_id=\$2/);return {rows:funcionarios.filter(f=>f.usuario_id===p[0]&&f.loja_id===p[1])};}
   if(sql.includes('SELECT d.id,d.funcionario_id')){assert.match(sql,/d\.loja_id=\$2/);return {rows:docs.filter(d=>(p[0]==null||d.funcionario_id===p[0])&&d.loja_id===p[1])};}
   if(sql.includes('SELECT d.*,f.usuario_id')){assert.match(sql,/d\.loja_id=\$2/);return {rows:docs.filter(d=>d.id===p[0]&&d.loja_id===p[1])};}
   if(sql.includes('SET visualizado_em=NOW()')){assert.match(sql,/funcionario_id=\$2 AND loja_id=\$3/);const d=docs.find(d=>d.id===p[0]&&d.funcionario_id===p[1]&&d.loja_id===p[2]);if(d)d.visualizado_em='agora';return {rows:[]};}
   if(sql.includes('confirmado_em=COALESCE')){assert.match(sql,/loja_id=\$6/);const d=docs.find(d=>d.id===p[3]&&d.funcionario_id===p[4]&&d.loja_id===p[5]&&d.visualizado_em);if(d)d.confirmado_em='agora';return {rows:d?[{id:d.id,confirmado_em:d.confirmado_em}]:[]};}
   throw Error('SQL inesperado');
 }};
 const arquivo=require.resolve('../routes/rh'),mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(arquivo,'utf8'),{module:mod,exports:mod.exports,require:createRequire(arquivo),setTimeout:()=>{},Buffer,URL,console,process:{env:{RH_DOCS_S3_ENDPOINT:'https://bucket.example.invalid',RH_DOCS_S3_BUCKET:'teste',RH_DOCS_S3_ACCESS_KEY_ID:'teste',RH_DOCS_S3_SECRET_ACCESS_KEY:'teste'}},fetch:async()=>{downloads++;return {ok:true,arrayBuffer:async()=>Buffer.from('%PDF-teste')};}});
 const router=mod.exports(pool);
 async function chamar(path,method='get',op={}){
  const req={user:{id:7,perfil:'operador',lojaId:1,...op.user},query:op.query||{},params:{id:String(op.id||101)},headers:{},socket:{},body:{}};
  const res={codigo:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.codigo=c;return this;},json(b){this.body=b;return this;},send(b){this.arquivo=b;return this;}};
  const rota=router.stack.find(x=>x.route?.path===path&&x.route.methods[method]);await rota.route.stack.at(-1).handle(req,res);return res;
 }
 return {chamar,docs,sqls,get downloads(){return downloads;}};
}
test('funcionário lista apenas documentos próprios e ignora funcionario_id alheio',async()=>{
 const f=fixture();const r=await f.chamar('/documentos','get',{query:{funcionario_id:22}});assert.equal(r.codigo,200);assert.deepEqual(r.body.data.map(d=>d.id),[101]);assert.equal(r.headers['Cache-Control'],'private, no-store');
});
test('documento de outro funcionário não chega ao storage nem marca visualização',async()=>{
 const f=fixture();const r=await f.chamar('/documentos/:id/arquivo','get',{id:202});assert.equal(r.codigo,403);assert.equal(f.downloads,0);assert.ok(!f.sqls.some(x=>x.sql.includes('SET visualizado_em=NOW()')));
});
test('documento de outra loja não pode ser aberto',async()=>{
 const f=fixture();const r=await f.chamar('/documentos/:id/arquivo','get',{id:303});assert.equal(r.codigo,404);assert.equal(f.downloads,0);
});
test('arquivo próprio abre e registra visualização só no destinatário e loja',async()=>{
 const f=fixture();const r=await f.chamar('/documentos/:id/arquivo');assert.equal(r.codigo,200);assert.equal(r.arquivo.toString(),'%PDF-teste');assert.equal(f.downloads,1);assert.equal(f.docs[0].visualizado_em,'agora');assert.equal(r.headers['Cache-Control'],'private, no-store');
});
test('não atesta antes de abrir; após abrir atesta somente o próprio documento',async()=>{
 const f=fixture();assert.equal((await f.chamar('/documentos/:id/confirmar','post')).codigo,409);await f.chamar('/documentos/:id/arquivo');assert.equal((await f.chamar('/documentos/:id/confirmar','post')).codigo,200);assert.equal(f.docs[0].confirmado_em,'agora');
 for(const id of [202,303])assert.equal((await f.chamar('/documentos/:id/confirmar','post',{id})).codigo,409);
 assert.ok(!f.docs[1].confirmado_em);assert.ok(!f.docs[2].confirmado_em);
});
test('sem vínculo não lista, abre ou atesta documentos',async()=>{
 const f=fixture();for(const [path,method] of [['/documentos','get'],['/documentos/:id/arquivo','get'],['/documentos/:id/confirmar','post']])assert.equal((await f.chamar(path,method,{user:{id:99}})).codigo,403);assert.equal(f.downloads,0);
});
test('troca de loja resolve o vínculo da loja selecionada sem trazer o anterior',async()=>{
 const f=fixture();const r=await f.chamar('/documentos','get',{user:{lojaId:2}});assert.deepEqual(r.body.data.map(d=>d.id),[303]);
});
test('admin mantém gestão e escopo meu também respeita o vínculo pessoal',async()=>{
 const f=fixture();const r=await f.chamar('/documentos','get',{user:{perfil:'admin'}});assert.deepEqual(r.body.data.map(d=>d.id),[101,202]);const proprio=await f.chamar('/documentos','get',{user:{perfil:'admin'},query:{escopo:'meu',funcionario_id:22}});assert.deepEqual(proprio.body.data.map(d=>d.id),[101]);
});
