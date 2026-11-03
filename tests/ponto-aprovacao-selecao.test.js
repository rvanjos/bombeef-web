'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(require.resolve('../public/ponto.html'),'utf8');
function fixture(){
 const nodes={'aprov-func':{value:''},'aprov-de':{value:''},'aprov-ate':{value:''},'aprov-vazio':{},'aprov-ponto-resumo':{},'aprov-selecionados':{}},buttons=[{},{}],calls=[];
 const cards=[['1','2026-10-20'],['2','2026-10-21'],['1','2026-10-25']].map(([func,data],i)=>{const c={dataset:{func,data},hidden:false},checkbox={value:String(i+1),checked:false,closest:()=>c};c.querySelector=()=>checkbox;c.checkbox=checkbox;return c;});
 const c={document:{getElementById:id=>nodes[id],querySelectorAll:q=>q.includes('[data-aprov-decisao]')?buttons:q.includes('.aprov-card')?cards:q.includes(':checked')?cards.map(c=>c.checkbox).filter(x=>x.checked):cards.map(c=>c.checkbox)},window:{prompt:()=> 'Conferido'},api:{post:async(u,b)=>{calls.push(b);return {ok:false,erro:'Simulado'};}},showToast(){}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('function atualizarSelecaoAprovacoesPonto()'),html.indexOf('async function marcarTrocaFolga(')),c);return {c,nodes,cards,buttons,calls};
}
test('selecionar todas considera apenas funcionário e período visíveis',()=>{
 const {c,nodes,cards,buttons}=fixture();nodes['aprov-func'].value='1';nodes['aprov-de'].value='2026-10-20';nodes['aprov-ate'].value='2026-10-24';c.filtrarAprovacoesPonto();c.selecionarTodasAprovacoes(true);
 assert.deepEqual(cards.map(x=>x.checkbox.checked),[true,false,false]);assert.equal(nodes['aprov-selecionados'].textContent,'1 selecionada(s)');assert.equal(buttons[0].disabled,false);assert.equal(nodes['aprov-ponto-resumo'].textContent,'1 de 3 pendência(s)');
});
test('mudar filtro remove seleção oculta e desabilita decisões sem selecionados',()=>{
 const {c,nodes,cards,buttons}=fixture();c.selecionarTodasAprovacoes(true);nodes['aprov-func'].value='2';c.filtrarAprovacoesPonto();assert.deepEqual(cards.map(x=>x.checkbox.checked),[false,true,false]);c.selecionarTodasAprovacoes(false);assert.equal(buttons[1].disabled,true);nodes['aprov-de'].value='2026-11-01';c.filtrarAprovacoesPonto();assert.equal(nodes['aprov-vazio'].hidden,false);
});
test('decisão não envia IDs ocultos mesmo que estejam marcados',async()=>{
 const {c,cards,calls}=fixture();cards[0].checkbox.checked=true;cards[1].checkbox.checked=true;cards[1].hidden=true;await c.decidirAprovacoesPonto('aprovado');assert.equal(JSON.stringify(calls[0].ids),'[1]');
});
test('tela inteira tem rolagem central, ações fora da rolagem e grade móvel de batidas',()=>{
 assert.match(html,/#m-aprov-ponto>\.md\{[^}]*height:100dvh/);assert.match(html,/\.aprov-conteudo\{[^}]*overflow:auto/);assert.match(html,/<footer class="aprov-rodape">/);assert.match(html,/@media\(max-width:600px\)/);assert.match(html,/\.aprov-batidas\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});
