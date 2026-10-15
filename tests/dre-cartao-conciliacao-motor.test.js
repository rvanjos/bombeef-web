'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../public/js/dre-fluxo'),C=require('../public/js/dre-cartao-pagamentos');
const total=r=>Math.round(r.linhas.reduce((s,t)=>s+Number(t.valor),0)*100)/100;
const compra=(id,valor,ref='fat')=>({id,fonte:'CC',faturaCC:ref,cartaoNome:'Caixa final '+id,bandeira:'VISA',mes:'09/2026',mesCaixa:'10/2026',data:'2026-09-10',valor,categoria:'Mercadorias',razaoSocial:'Fornecedor '+id});
const pago={id:'p',fonte:'EXTRATO',mes:'10/2026',mesCaixa:'10/2026',data:'2026-10-12',valor:-100,categoria:'Pagamento de Fatura CC',lancamento:'FATURA CAIXA'};
test('débito único de vários cartões finais não vira despesa adicional',()=>{
 const tx=[{...pago,valor:-300},compra('1',-100,'DRIVE:pdf:1'),compra('2',-200,'DRIVE:pdf:2')];
 for(const modo of ['comp','caixa']){const r=F.resolver(tx,modo);assert.equal(total(r),-300);assert.equal(r.pendencias.length,0);assert.ok(!r.linhas.some(t=>t.categoria==='A CLASSIFICAR'));}
});
test('vínculo antigo a só um cartão é corrigido no cálculo quando o total comprova o conjunto',()=>{const tx=[{...pago,valor:-300,faturaCC:'DRIVE:pdf:1',vinculadoFaturaCC:true},compra('1',-100,'DRIVE:pdf:1'),compra('2',-200,'DRIVE:pdf:2')];assert.equal(total(F.resolver(tx)),-300);assert.equal(F.resolver(tx).pendencias.length,0);});
test('emissores distintos não são somados para forçar um vínculo',()=>{const a=compra('1',-100,'a'),b={...compra('2',-200,'b'),cartaoNome:'Itaú final 2'};const d=C.decidir({...pago,valor:-300},C.faturasDosLancamentos([a,b]));assert.equal(d.acao,'pendente');});
test('item ignorado não é recriado em A CLASSIFICAR pela diferença da fatura',()=>{
 const tx=[{...pago,valor:-1000,faturaCC:'fat'},compra('1',-350),{...compra('2',-650),ignorar:true}];
 for(const m of ['comp','caixa']){const r=F.resolver(tx,m);assert.equal(total(r),-350);assert.equal(r.pendencias.length,0);}
});
test('pagamento parcial distribui apenas a despesa ativa e preserva a exclusão',()=>{const tx=[{...pago,valor:-500,faturaCC:'fat'},compra('1',-350),{...compra('2',-650),ignorar:true}];assert.equal(total(F.resolver(tx)),-350);assert.equal(total(F.resolver(tx,'caixa')),-175);});
test('nota sem marcação de cartão é reconhecida por fornecedor, valor e data únicos',()=>{
 const cc={...compra('1',-100),razaoSocial:'BRF S.A. NOVA SANTA RI'};
 const nota={id:'nf',fonte:'BOLETO_PREV',boletoId:7,valor:-100,mes:'09/2026',dataNota:'2026-09-10',data:'2026-10-15',razaoSocial:'BRF S.A.',categoria:'Bovino'};
 const tx=[cc,nota,{...pago,faturaCC:'fat'}];
 for(const m of ['comp','caixa']){const r=F.resolver(tx,m);assert.equal(total(r),-100);assert.equal(r.linhas[0].categoria,'Bovino');assert.equal(r.vinculosInferidos.length,1);assert.equal(r.pendencias.length,0);}
 assert.equal(nota.cartaoItemRef,undefined,'reconhecimento não altera registro de origem');
});
test('duas notas compatíveis geram pendência em vez de apagar uma delas',()=>{const cc=compra('1',-100);const n={id:'n',fonte:'BOLETO_PREV',boletoId:7,valor:-100,mes:'09/2026',data:'2026-09-10',razaoSocial:'Fornecedor 1',categoria:'Bovino'};const r=F.resolver([cc,n,{...n,id:'n2',boletoId:8}]);assert.equal(r.vinculosInferidos.length,0);assert.ok(r.pendencias.some(p=>p.tipo==='vinculo_documento'));assert.equal(total(r),-300);});
test('mesmo valor sem identidade do fornecedor não cria vínculo',()=>{const cc={...compra('1',-100),razaoSocial:'BRF S.A.'};const n={id:'n',fonte:'BOLETO_PREV',boletoId:7,valor:-100,mes:'09/2026',data:'2026-09-10',razaoSocial:'TENDA ATACADO',categoria:'Bovino'};assert.equal(F.resolver([cc,n]).vinculosInferidos.length,0);});
test('nota já paga por outro lançamento bancário não é associada ao cartão',()=>{const cc=compra('1',-100);const n={id:'n',fonte:'BOLETO',boletoId:7,valor:-100,mes:'09/2026',data:'2026-09-10',razaoSocial:'Fornecedor 1',categoria:'Bovino'};const b={id:'b',fonte:'EXTRATO',boletoId:7,valor:-100,mes:'09/2026',categoria:'Bovino'};assert.equal(F.resolver([cc,n,b]).vinculosInferidos.length,0);});
test('datas incompatíveis ou lojas diferentes não criam vínculo',()=>{const cc={...compra('1',-100),loja_id:1};const n={id:'n',fonte:'BOLETO_PREV',boletoId:7,valor:-100,mes:'09/2026',data:'2026-09-10',razaoSocial:'Fornecedor 1',loja_id:33};assert.equal(F.resolver([cc,n]).vinculosInferidos.length,0);assert.equal(F.resolver([cc,{...n,loja_id:1,data:'2026-01-01'}]).vinculosInferidos.length,0);});
test('diferença real e fatura não importada ficam pendentes fora do resultado',()=>{assert.equal(total(F.resolver([pago])),0);const r=F.resolver([{...pago,faturaCC:'fat',valor:-110},compra('1',-100)]);assert.equal(total(r),-100);assert.equal(r.pendencias.find(p=>p.tipo==='fatura').valor,-10);});

test('compra confirmada manualmente como sem nota conserva a decisão',()=>{const cc={...compra('1',-100),documentoStatus:'sem_nota'};const n={id:'n',fonte:'BOLETO_PREV',boletoId:7,valor:-100,mes:'09/2026',data:'2026-09-10',razaoSocial:'Fornecedor 1'};assert.equal(F.resolver([cc,n]).vinculosInferidos.length,0);});

test('faturas independentes do mesmo emissor e mês não entram no mesmo conjunto',()=>{const tx=[{...pago,valor:-300},compra('1',-100,'DRIVE:arquivoA:1'),compra('2',-200,'DRIVE:arquivoA:2'),compra('3',-400,'DRIVE:arquivoB:3'),compra('4',-500,'DRIVE:arquivoB:4')];const d=C.decidir(tx[0],C.faturasDosLancamentos(tx));assert.equal(d.acao,'vincular');assert.deepEqual(d.fatura.referencias,['DRIVE:arquivoA:1','DRIVE:arquivoA:2']);assert.equal(total(F.resolver(tx)),-1200);assert.equal(F.resolver(tx).pendencias.length,0);});
