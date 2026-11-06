'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const elementos=[],chamadas=[],eventos={};let revogados=0,impressoes=0;
 const node=tag=>{const n={tagName:tag.toUpperCase(),style:{},children:[],append(...es){this.children.push(...es);},replaceChildren(...es){this.children=[...es];},setAttribute(){},scrollIntoView(){},click(){chamadas.push(['download',this.download,this.href]);},remove(){this.removido=true;}};if(tag==='iframe'){n.contentWindow={focus(){},print(){impressoes++;}};n.contentDocument={createElement:node,head:node('head'),body:node('body')};}elementos.push(n);return n;};
 const root=node('div'),document={createElement:node,body:node('body')};
 const doc={id:101,titulo:'<img src=x onerror=alert(1)>',exige_confirmacao:true,visualizado_em:null,observacao:'<script>teste</script>'};
 const BB={api:{token:()=> 'sessao-sintetica',get:async path=>{chamadas.push(['get',path]);return {ok:true,data:[doc]};},post:async path=>{chamadas.push(['post',path]);return {ok:true};}}};
 const window={location:{origin:'https://app.test'},parent:{},confirm:()=>true,addEventListener:(tipo,fn)=>{eventos[tipo]=fn;}};
 const ctx={window,document,BB,atob,URL:{createObjectURL:()=> 'blob:documento-teste',revokeObjectURL:()=>revogados++},fetch:async path=>{chamadas.push(['arquivo',path]);return {ok:true,blob:async()=>({type:'application/pdf'})};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/rh-documentos-funcionario'),'utf8'),ctx);
 const ativos=()=>{const all=[];function scan(n){all.push(n);for(const x of n.children||[])scan(x);}scan(root);return all;};
 return {root,BB,ctx,eventos,chamadas,window,doc,ativos,get impressoes(){return impressoes;},get revogados(){return revogados;},carregar:()=>window.RHDocumentosFuncionario.carregar(root),botao:txt=>ativos().find(n=>n.tagName==='BUTTON'&&n.textContent===txt)};
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
test('download usa arquivo autenticado, nome original seguro e não confirma recebimento',async()=>{
 const f=fixture();f.doc.arquivo_nome='holerite-outubro.pdf';await f.carregar();await f.botao('Baixar').onclick();assert.ok(f.chamadas.some(x=>x[0]==='arquivo'&&x[1]==='/api/rh/documentos/101/arquivo'));assert.deepEqual(f.chamadas.find(x=>x[0]==='download'),['download','holerite-outubro.pdf','blob:documento-teste']);assert.ok(!f.chamadas.some(x=>x[0]==='post'));assert.equal(f.botao('Confirmar recebimento').disabled,false);
});
test('nome inválido é saneado e extensão corresponde ao conteúdo baixado',async()=>{
 const f=fixture();f.doc.arquivo_nome='../outro\\arquivo.exe';await f.carregar();await f.botao('Baixar').onclick();const nome=f.chamadas.find(x=>x[0]==='download')[1];assert.ok(!/[\\/]/.test(nome));assert.ok(nome.endsWith('.pdf'));
});
test('impressão PDF espera o carregamento e imprime só o iframe do documento',async()=>{
 const f=fixture();await f.carregar();await f.botao('Imprimir').onclick();const frame=f.ativos().find(n=>n.tagName==='IFRAME');assert.equal(f.impressoes,0);assert.equal(f.botao('Imprimir arquivo').disabled,true);frame.onload();assert.equal(f.impressoes,1);assert.equal(f.botao('Imprimir arquivo').disabled,false);assert.ok(!f.chamadas.some(x=>x[0]==='post'));
});
test('impressão de imagem espera a imagem carregar e ajusta largura da página',async()=>{
 const f=fixture();f.ctx.fetch=async()=>({ok:true,blob:async()=>({type:'image/png'})});await f.carregar();await f.botao('Imprimir').onclick();const frame=f.ativos().find(n=>n.tagName==='IFRAME');frame.onload();const imagem=frame.contentDocument.body.children[0];assert.equal(imagem.src,'blob:documento-teste');assert.equal(f.impressoes,0);imagem.onload();assert.equal(f.impressoes,1);assert.match(frame.contentDocument.head.children[0].textContent,/max-width:100%/);
});
test('negação de acesso impede download e impressão',async()=>{
 const f=fixture();f.ctx.fetch=async()=>({ok:false,json:async()=>({erro:'Acesso negado'})});await f.carregar();for(const acao of ['Baixar','Imprimir'])await f.botao(acao).onclick();assert.ok(!f.chamadas.some(x=>x[0]==='download'));assert.equal(f.impressoes,0);assert.ok(!f.ativos().some(n=>n.tagName==='IFRAME'));
});
test('logout antes do carregamento impede impressão e descarta download atrasado',async()=>{
 const f=fixture();await f.carregar();await f.botao('Imprimir').onclick();const frame=f.ativos().find(n=>n.tagName==='IFRAME');f.eventos.pagehide();frame.onload();assert.equal(f.impressoes,0);
 const g=fixture();let resolver;g.ctx.fetch=()=>new Promise(r=>{resolver=r;});await g.carregar();const p=g.botao('Baixar').onclick();g.eventos.pagehide();resolver({ok:true,blob:async()=>({type:'application/pdf'})});await p;assert.ok(!g.chamadas.some(x=>x[0]==='download'));
});
