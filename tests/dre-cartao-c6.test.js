'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {interpretar}=require('../public/js/dre-cartao-c6');
const cab='C6 BANK\nValor da fatura: R$ 150,50\nVencimento\n15/01/2026\nResumo da fatura\nCompras nacionais 150,50\nSaldo obrigações futuras R$ 9.000,00\nTransações do cartão principal\nC6 Carbon Final 1234 - PESSOA TESTE Subtotal deste cartão R$ 150,50\n';
test('OCR C6: datas coladas e ícones, pagamento anterior, parcelas e IOF',()=>{
 const r=interpretar(cab+'O 16dez LOJA A - Parcela 2/12 100,00\nO 15dez Pag Fatura Boleto 800,00\nO O4jan SERVICO USD 9,00 | Cotação USD: R$5,00 45,00\nO O4jan SERVICO IOF Transações Exterior 5,50\nFormas de pagamento\n04 jan BOLETO 150,50');
 assert.equal(r.conferenciaOk,true);assert.equal(r.itens.length,3);assert.equal(r.itens[0].data,'2025-12-16');assert.equal(r.itens[0].parcela,'2/12');assert.equal(r.itens[1].valorCentavos,4500);assert.match(r.itens[2].descricao,/IOF/);
});
test('conferência rejeita leitura incompleta ou valor errado',()=>{
 const r=interpretar(cab+'01 jan LOJA 150,49');assert.equal(r.conferenciaOk,false);assert.equal(r.totalCentavos-r.somaCentavos,1);
 assert.equal(interpretar(cab).conferenciaOk,false);
});
test('créditos abatem o total e compras idênticas legítimas são preservadas',()=>{
 const texto=cab.replaceAll('150,50','150,00')+'02 jan LOJA 100,00\n02 jan LOJA 100,00\n03 jan ESTORNO LOJA 50,00';
 const r=interpretar(texto);assert.equal(r.conferenciaOk,true);assert.equal(r.itens.length,3);assert.equal(r.itens[2].valorCentavos,-5000);
 assert.notEqual(r.itens[0].chave,r.itens[1].chave);assert.deepEqual(interpretar(texto),r);
});
test('continuação de página mantém o cartão e cartão adicional troca o portador',()=>{
 const r=interpretar(cab+'01 jan LOJA 50,00\n--- PAGE ---\nTransações do cartão principal\n02 jan LOJA 50,00\nC6 Carbon Virtual Final 5678 - OUTRA PESSOA B Cartão Virtual Subtotal deste cartão R$ 50,50\n03 jan LOJA 50,50');
 assert.equal(r.conferenciaOk,true);assert.deepEqual(r.itens.map(i=>i.cartao),['1234','1234','5678']);assert.equal(r.itens[2].portador,'OUTRA PESSOA');
});
test('sem vencimento, total ou banco identificável não libera importação',()=>{
 assert.throws(()=>interpretar(cab.replace('15/01/2026','')),/vencimento/);
 assert.throws(()=>interpretar(cab.replace('Valor da fatura: R$ 150,50','')),/total/);
 assert.throws(()=>interpretar('PDF sem identificação'),/C6/);
});
test('datas impossíveis não são convertidas em outro mês',()=>{
 assert.throws(()=>interpretar(cab+'31 fev LOJA 150,50'),/Data de compra/);
});

function leitorFixture(modo){
 const vm=require('node:vm'),fs=require('node:fs');const nos=[];let terminou=0,limpou=0,reconheceu=0;
 const document={createElement(tag){const el={tag,style:{},append(){},remove(){this.removido=true;},getContext(){return {};}};nos.push(el);return el;},body:{append(){}},head:{append(){throw Error('não deve baixar o leitor já carregado');}}};
 const window={Tesseract:{async createWorker(){return {async setParameters(p){assert.equal(p.tessedit_pageseg_mode,'6');},recognize(){reconheceu++;if(modo==='cancelar'){queueMicrotask(()=>nos.find(n=>n.tag==='button').onclick());return new Promise(()=>{});}if(modo==='falhar')return Promise.reject(Error('OCR indisponível'));return Promise.resolve({data:{text:'texto reconhecido'}});},async terminate(){terminou++;}};}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/dre-cartao-ocr'),'utf8'),{window,document,setTimeout,clearTimeout});
 const pdf={numPages:2,async getPage(){return {getViewport({scale}){return {width:600*scale,height:800*scale};},render(){return {promise:Promise.resolve()};},cleanup(){limpou++;}};}};
 return {ler:()=>window.DRECartaoOCR.ler(pdf,['','texto original suficiente '.repeat(5)]),estado:()=>({terminou,limpou,reconheceu,fechado:nos[0].removido})};
}
test('OCR: processa apenas imagens, preserva texto existente e libera recursos',async()=>{
 const f=leitorFixture();assert.match(await f.ler(),/texto reconhecido[\s\S]+texto original/);assert.deepEqual(f.estado(),{terminou:1,limpou:1,reconheceu:1,fechado:true});
});
test('OCR: cancelamento encerra o worker e fecha o progresso',async()=>{
 const f=leitorFixture('cancelar');await assert.rejects(f.ler(),/cancelada/);assert.deepEqual(f.estado(),{terminou:1,limpou:1,reconheceu:1,fechado:true});
});
test('OCR: falha de leitura também libera recursos',async()=>{
 const f=leitorFixture('falhar');await assert.rejects(f.ler(),/indisponível/);assert.deepEqual(f.estado(),{terminou:1,limpou:1,reconheceu:1,fechado:true});
});
test('revisão mostra o total líquido e apresenta texto do PDF sem executar HTML',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync(require.resolve('../public/dre.html'),'utf8');
 const fonte=html.slice(html.indexOf('function ccrRenderGrupos()'),html.indexOf('function ccrToggleGrupo('));
 const nos=new Map(),malicioso='<img src=x onerror=alert(1)>',itens=[{id:'a',valor:-200,lancamento:malicioso,portador:malicioso},{id:'b',valor:50,lancamento:malicioso}];
 const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const ctx={_ccrLancs:itens,_ccrFiltro:'todos',_ccrGrupos:[],ccrAgrupar:()=>[{nomeRef:malicioso,itens}],ccrCatInput:()=>'',esc,fmt:{brl:String,date:String},document:{getElementById(id){if(!nos.has(id))nos.set(id,{style:{}});return nos.get(id);}}};
 vm.runInNewContext(fonte+'\nccrRenderGrupos();',ctx);
 assert.equal(nos.get('ccr-total-val').textContent,'-150');assert.ok(!nos.get('ccr-grupos').innerHTML.includes('<img'));assert.ok(nos.get('ccr-grupos').innerHTML.includes('&lt;img'));
});
