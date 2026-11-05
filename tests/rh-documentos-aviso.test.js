'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {contarPendenciasProprias}=require('../lib/rh-documentos-pendentes');

test('consulta usa apenas usuário autenticado e loja ativa, inclusive admin',async()=>{
 const pool={async query(sql,params){assert.deepEqual(params,[7,2]);assert.match(sql,/f\.loja_id=\$2/);assert.match(sql,/d\.loja_id=\$2/);assert.match(sql,/JOIN destinatario f ON f.id=d.funcionario_id/);assert.match(sql,/d\.status='ativo'/);assert.match(sql,/d\.exige_confirmacao=true AND d\.confirmado_em IS NULL/);assert.match(sql,/f\.usuario_id=\$1/);assert.doesNotMatch(sql,/UPDATE|INSERT|DELETE/);return {rows:[{total:3}]};}};
 assert.equal(await contarPendenciasProprias(pool,{id:7,lojaId:2,perfil:'admin'}),3);
});
test('sem vínculo/documento pendente retorna zero e identidade inválida não consulta banco',async()=>{
 assert.equal(await contarPendenciasProprias({query:async()=>({rows:[{total:0}]})},{id:7,lojaId:1}),0);
 let chamadas=0;const pool={query:async()=>{chamadas++;}};
 for(const user of [null,{id:7},{id:7,lojaId:0},{id:'texto',lojaId:2}])await assert.rejects(contarPendenciasProprias(pool,user));
 assert.equal(chamadas,0);
});

function fixture(){
 const elementos=[];const document={activeElement:null,body:{append(e){e.isConnected=true;}},createElement(tag){const e={tag,style:{},filhos:[],eventos:{},setAttribute(){},append(...x){this.filhos.push(...x);},remove(){this.isConnected=false;},showModal(){this.aberto=true;},focus(){document.activeElement=this;},addEventListener(n,fn){this.eventos[n]=fn;}};elementos.push(e);return e;}};
 const window={};vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/rh-documentos-aviso'),'utf8'),{window,document,setTimeout:fn=>{fn();}});
 return {api:window.BBDocumentosAviso,document,dialogos:()=>elementos.filter(e=>e.tag==='dialog'&&e.isConnected),botao:txt=>elementos.findLast(e=>e.tag==='button'&&e.textContent===txt)};
}
test('pendência abre popup com contagem e botão acessível para documentos',async()=>{
 const f=fixture();let abriu=0;await f.api.verificar({consultar:async()=>({ok:true,total:2}),abrir:()=>abriu++});
 assert.equal(f.dialogos().length,1);assert.equal(f.dialogos()[0].aberto,true);assert.match(f.dialogos()[0].filhos[1].textContent,/2 documentos/);
 f.botao('Ver documentos').onclick();assert.equal(abriu,1);assert.equal(f.dialogos().length,0);
});
test('ver depois não atesta nem apaga pendência; novo login avisa novamente',async()=>{
 const f=fixture();let abriu=0;const opts={consultar:async()=>({ok:true,total:1}),abrir:()=>abriu++};
 await f.api.verificar(opts);f.botao('Ver depois').onclick();assert.equal(abriu,0);assert.equal(f.dialogos().length,0);
 await f.api.verificar(opts);assert.equal(f.dialogos().length,1);
});
test('zero, erro ou resposta inválida não bloqueiam a entrada',async()=>{
 for(const r of [{ok:true,total:0},{ok:false},{ok:true,total:'<img>'}]){const f=fixture();await f.api.verificar({consultar:async()=>r});assert.equal(f.dialogos().length,0);}
});
test('resposta atrasada após logout é descartada',async()=>{
 const f=fixture();let responder;const p=f.api.verificar({consultar:()=>new Promise(r=>{responder=r;})});f.api.limpar();responder({ok:true,total:4});await p;assert.equal(f.dialogos().length,0);
});
test('mudança de usuário/loja descarta resposta anterior e não duplica aviso',async()=>{
 const f=fixture();let responder;const p=f.api.verificar({consultar:()=>new Promise(r=>{responder=r;})});
 await f.api.verificar({consultar:async()=>({ok:true,total:1})});responder({ok:true,total:9});await p;assert.equal(f.dialogos().length,1);assert.match(f.dialogos()[0].filhos[1].textContent,/1 documento/);
});
test('sessão renovada durante o login repete a consulta e recupera o aviso',async()=>{
 const f=fixture();let vezes=0;await f.api.verificar({consultar:async()=>++vezes===1?{ok:false}:{ok:true,total:1}});assert.equal(vezes,2);assert.equal(f.dialogos().length,1);
});
