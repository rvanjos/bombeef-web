'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const elementos=[],chamadas=[],eventos={};let revogados=0;
 const node=tag=>{const n={tagName:tag.toUpperCase(),style:{},children:[],append(...es){this.children.push(...es);},replaceChildren(...es){this.children=[...es];},setAttribute(){},scrollIntoView(){}};elementos.push(n);return n;};
 const root=node('div'),document={createElement:node};
 const doc={id:101,titulo:'<img src=x onerror=alert(1)>',exige_confirmacao:true,visualizado_em:null,observacao:'<script>teste</script>'};
 const BB={api:{token:()=> 'sessao-sintetica',get:async path=>{chamadas.push(['get',path]);return {ok:true,data:[doc]};},post:async path=>{chamadas.push(['post',path]);return {ok:true};}}};
 const window={location:{origin:'https://app.test'},parent:{},confirm:()=>true,addEventListener:(tipo,fn)=>{eventos[tipo]=fn;}};
 const ctx={window,document,BB,atob,URL:{createObjectURL:()=> 'blob:documento-teste',revokeObjectURL:()=>revogados++},fetch:async path=>{chamadas.push(['arquivo',path]);return {ok:true,blob:async()=>({type:'application/pdf'})};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/rh-documentos-funcionario'),'utf8'),ctx);
 const ativos=()=>{const all=[];function scan(n){all.push(n);for(const x of n.children||[])scan(x);}scan(root);return all;};
 return {root,BB,ctx,eventos,chamadas,window,doc,ativos,get revogados(){return revogados;},carregar:()=>window.RHDocumentosFuncionario.carregar(root),botao:txt=>ativos().find(n=>n.tagName==='BUTTON'&&n.textContent===txt)};
}
test('aba consulta escopo pessoal e renderiza título/observação como texto',async()=>{
 const f=fixture();await f.carregar();assert.equal(f.chamadas[0][1],'/api/rh/documentos?escopo=meu');assert.ok(f.ativos().some(e=>e.textContent===f.doc.titulo));assert.ok(!f.ativos().some(e=>e.innerHTML));assert.ok(f.botao('Confirmar recebimento').disabled);
});
test('visualização embutida dispensa popup do navegador e libera ateste explícito',async()=>{
 const f=fixture();await f.carregar();await f.botao('Visualizar documento').onclick();assert.ok(f.ativos().some(e=>e.tagName==='IFRAME'&&e.src==='blob:documento-teste'));assert.equal(f.botao('Confirmar recebimento').disabled,false);assert.ok(!f.chamadas.some(x=>x[0]==='post'));await f.botao('Confirmar recebimento').onclick();assert.ok(f.chamadas.some(x=>x[0]==='post'&&x[1].endsWith('/101/confirmar')));assert.equal(f.revogados,1);
});
test('negação do arquivo não exibe conteúdo nem libera ateste',async()=>{
 const f=fixture();f.ctx.fetch=async()=>({ok:false,json:async()=>({erro:'Acesso negado'})});await f.carregar();await f.botao('Visualizar documento').onclick();assert.ok(!f.ativos().some(e=>e.tagName==='IFRAME'));assert.equal(f.botao('Confirmar recebimento').disabled,true);assert.ok(f.ativos().some(e=>e.textContent==='Acesso negado'));
});
test('saída da tela descarta arquivo recebido tardiamente',async()=>{
 const f=fixture();let resolver;f.ctx.fetch=()=>new Promise(r=>{resolver=r;});await f.carregar();const p=f.botao('Visualizar documento').onclick();f.eventos.pagehide();resolver({ok:true,blob:async()=>({type:'application/pdf'})});await p;assert.ok(!f.ativos().some(e=>e.tagName==='IFRAME'));
});
test('logout limpa documentos e libera arquivo; mensagens externas não interferem',async()=>{
 const f=fixture();await f.carregar();await f.botao('Visualizar documento').onclick();
 f.eventos.message({origin:'https://outro.test',source:f.window.parent,data:{type:'bb_logout'}});assert.ok(f.botao('Visualizar documento'));
 f.eventos.message({origin:f.window.location.origin,source:f.window.parent,data:{type:'bb_logout'}});assert.equal(f.ativos().length,2);assert.equal(f.revogados,1);assert.ok(!f.ativos().some(e=>e.tagName==='IFRAME'));
});
test('nova identidade no mesmo iframe remove documentos anteriores antes da consulta',async()=>{
 const f=fixture();await f.carregar();let responder;
 f.BB.api.get=()=>new Promise(r=>{responder=r;});
 const tk='cabecalho.'+Buffer.from(JSON.stringify({id:8,lojaId:1,sessaoId:'outra-sessao-sintetica'})).toString('base64url')+'.assinatura-sintetica';f.BB.api.token=()=>tk;
 f.eventos.message({origin:f.window.location.origin,source:f.window.parent,data:{type:'bb_token',token:tk}});
 assert.ok(!f.ativos().some(e=>e.textContent===f.doc.titulo));responder({ok:true,data:[]});await Promise.resolve();
});
test('portal e tela do funcionário têm o mesmo caminho para documentos',()=>{
 const html=fs.readFileSync(require.resolve('../public/rh-funcionario.html'),'utf8'),portal=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
 assert.match(html,/onclick="showTab\('documentos'\)"/);assert.match(html,/id="tab-documentos"/);assert.match(html,/get\('aba'\)==='documentos'\)showTab\('documentos'\)/);assert.match(portal,/usuario\?\.perfil==='admin'\?'rh.html':'rh-funcionario.html'/);
});
