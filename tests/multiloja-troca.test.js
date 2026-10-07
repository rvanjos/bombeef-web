'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const codigo=fs.readFileSync('public/js/api.js','utf8');
function tk(lojaId,n=1){return 'teste.'+Buffer.from(JSON.stringify({lojaId,perfil:'admin',n})).toString('base64url')+'.teste';}
function ambiente(inicial,fetchImpl){
 const dados=new Map(inicial?[['bb_token',inicial]]:[]),messages=[],listeners={};
 const storage={getItem:k=>dados.get(k)||null,setItem:(k,v)=>dados.set(k,v),removeItem:k=>dados.delete(k)};
 const parent={postMessage:m=>messages.push(m)},w={location:{pathname:'/teste.html',search:'',origin:'https://teste',href:''},parent,top:parent,addEventListener:(t,f)=>(listeners[t]??=[]).push(f)};w.self=w;
 const ctx={window:w,location:w.location,document:{getElementById:()=>null},sessionStorage:storage,localStorage:storage,fetch:fetchImpl,setTimeout:()=>0,clearTimeout(){},atob:s=>Buffer.from(s,'base64').toString(),console,URLSearchParams};
 vm.runInNewContext(codigo,ctx);
 return {w,storage,messages,emit:(token,origin='https://teste')=>listeners.message.forEach(f=>f({origin,source:parent,data:{type:'bb_token',token}}))};
}
test('401 em iframe não apaga a sessão compartilhada nem encerra o portal',async()=>{
 const token=tk(33),a=ambiente(token,async()=>({status:401,json:async()=>({ok:false})}));
 await assert.rejects(a.w.BB.api.get('/api/teste'),/Sessão expirada/);
 assert.equal(a.storage.getItem('bb_token'),token);assert.equal(a.w.location.href,'');assert.ok(a.messages.some(m=>m.type==='bb_request_auth'));
});
test('tela antiga e autosave conservam token antigo após troca; novo módulo recebe a nova loja',async()=>{
 const old=tk(1),novo=tk(33),chamadas=[],a=ambiente(old,async(p,o)=>{chamadas.push(o.headers.Authorization);return {status:200,json:async()=>({ok:true})};});
 a.storage.setItem('bb_token',novo);await a.w.BB.api.post('/api/dre/salvar',{});
 assert.equal(chamadas[0],'Bearer '+old);assert.equal(a.w.BB.api.token(),old);assert.equal(a.storage.getItem('bb_token'),novo);
 const b=ambiente(novo,async()=>({status:200,json:async()=>({ok:true})}));assert.equal(b.w.BB.api.token(),novo);
 a.emit(novo);const r=await a.w.BB.api.post('/api/dre/salvar',{});assert.equal(r.ok,false);assert.equal(chamadas.length,1);
});
test('refresh atrasado não sobrescreve sessão nova e iframe não grava refresh no portal',async()=>{
 const antigo=tk(1),novo=tk(33);let liberar;const a=ambiente(antigo,async(p)=>p==='/auth/refresh'?new Promise(r=>liberar=()=>r({status:200,json:async()=>({ok:true,token:tk(1,2)})})):({status:401,json:async()=>({ok:false})}));
 const pedido=a.w.BB.api.get('/api/teste');while(!liberar)await Promise.resolve();a.storage.setItem('bb_token',novo);liberar();await assert.rejects(pedido);assert.equal(a.storage.getItem('bb_token'),novo);
});
test('módulo sem token espera portal; mensagem de outra origem é rejeitada',async()=>{
 let calls=0;const a=ambiente(null,async()=>{calls++;});const r=await a.w.BB.api.get('/api/teste');assert.equal(r.ok,false);assert.equal(calls,0);
 a.emit(tk(33),'https://outro');assert.equal(a.w.BB.api.token(),'');a.emit(tk(33));assert.equal(a.w.BB.api.token(),tk(33));
});
test('troca do portal recarrega sem fornecer sessão nova aos dados antigos',async()=>{
 const html=fs.readFileSync('public/index.html','utf8'),start=html.indexOf('async function trocarLojaAtiva('),end=html.indexOf('\nfunction entrarNoPortal()',start);const dados=new Map([['bb_token',tk(1)]]);let broadcasts=0,reloads=0,requests=0;
 const ctx={_trocandoLoja:false,$:()=>({disabled:false}),apiFetch:async()=>{requests++;return {ok:true,token:tk(33),usuario:{loja:{id:33}}};},sessionStorage:{setItem:(k,v)=>dados.set(k,v)},usuario:{loja:{id:1}},broadcastToken:()=>broadcasts++,location:{reload:()=>reloads++},alert:assert.fail,renderLojaAtiva(){}};
 vm.runInNewContext(html.slice(start,end),ctx);await Promise.all([ctx.trocarLojaAtiva(33),ctx.trocarLojaAtiva(33)]);assert.equal(requests,1);assert.equal(broadcasts,0);assert.equal(reloads,1);assert.equal(dados.get('bb_token'),tk(33));
});
test('backend DRE rejeita id de outra loja/mês sem fallback para inserir ou sobrescrever',async()=>{
 const pool={query:async()=>({rows:[]})},router=require('../routes/dre')(pool),route=router.stack.find(l=>l.route?.path==='/salvar');
 const handler=route.route.stack.at(-1).handle;
 let status=200,body;const res={status:n=>{status=n;return res;},json:b=>{body=b;return res;}};
 await handler({body:{sessao_id:73,mes_ref:'10/2026',dados_json:{transactions:[]}},user:{id:1,lojaId:33}},res);
 assert.equal(status,409);assert.equal(body.codigo,'DRE_SESSAO_INCOMPATIVEL');
});
