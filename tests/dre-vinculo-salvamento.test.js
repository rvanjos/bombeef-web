const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const html=fs.readFileSync('public/dre.html','utf8'),C=require('../public/js/dre-cartao-pagamentos');
test('vínculo manual prevalece sobre substituição automática',()=>{
 assert.deepEqual(C.decidir({fonte:'EXTRATO',valor:-100,faturaCC:'escolhida',_vinculoFaturaManual:true},[]),{acao:'vinculado',faturaId:'escolhida'});
});
for(const sucesso of [true,false])test(`confirmar aguarda persistência e ${sucesso?'atualiza pendências':'mantém seleção e restaura pagamento'}`,async()=>{
 const {JSDOM}=require(process.env.JSDOM_PATH),dom=new JSDOM('<body><div id="m-drill" style="display:flex"></div><div id="m-pag-fatura-extrato"><input name="ext-fatura-sel" value="fat" checked type="radio"><button></button></div></body>',{runScripts:'outside-only'}),w=dom.window;
 try{
 let resolver,atualizou=0,salvo;w.TXS=[{id:'p',fonte:'EXTRATO',valor:-100,mes:'08/2026'}];w.CARTOES_MONITORADOS=[{id:'c6',label:'C6'}];w.DRECartaoPagamentos=C;w.ccrFaturasImportadas=()=>[{faturaId:'fat',referencias:['fat']}];w.salvarMes=async mes=>{salvo=JSON.parse(JSON.stringify(w.TXS[0]));assert.equal(mes,'08/2026');return new Promise(r=>resolver=r);};w.toast=()=>{};w.render=()=>{};w.renderDRE=()=>{};w._drillRender=()=>atualizou++;w.renderStatusCartoes=()=>{};
 const a=html.indexOf('async function confirmarPagFaturaExtrato('),b=html.indexOf('// Abre modal para vincular pagamento',a);w.eval(html.slice(a,b));const tarefa=w.confirmarPagFaturaExtrato('p','c6');assert.equal(salvo.faturaCC,'fat');assert.equal(salvo._vinculoFaturaManual,true);assert.ok(w.document.getElementById('m-pag-fatura-extrato'));resolver(sucesso);await tarefa;
 if(sucesso){assert.equal(w.document.getElementById('m-pag-fatura-extrato'),null);assert.equal(atualizou,1);}else{assert.ok(w.document.querySelector('input:checked'));assert.equal(w.TXS[0].faturaCC,undefined);assert.equal(w.document.querySelector('button').disabled,false);assert.equal(atualizou,0);}
 }finally{w.close();}
});
test('seletor fica acima das pendências',()=>assert.match(html,/id="m-pag-fatura-extrato" style="z-index:1200"/));
