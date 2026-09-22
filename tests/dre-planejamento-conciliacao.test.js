'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('planejamento anual é persistido por loja com RLS',()=>{
  const rota=ler('routes/dre_planejamento.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS dre_planejamento_anual/);
  assert.match(rota,/loja_id INTEGER NOT NULL/);
  assert.match(rota,/UNIQUE\(loja_id, ano\)/);
  assert.match(rota,/ENABLE ROW LEVEL SECURITY/);
  assert.match(rota,/FORCE ROW LEVEL SECURITY/);
  assert.match(rota,/Perfil contábil tem acesso somente leitura/);
});

test('DRE expõe conciliação e planejamento como áreas próprias',()=>{
  const area=ler('public/js/dre-lancamentos-area.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(area,/data-v="conciliacao"/);
  assert.match(area,/data-v="planejamento"/);
  assert.match(fin,/Conciliação financeira/);
  assert.match(fin,/Planejamento anual/);
  assert.match(fin,/Pagamento de Fatura/);
  assert.match(fin,/\/api\/dre\/planejamento\//);
});

test('conciliação preserva regra contábil do cartão',()=>{
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(fin,/pagamento total do cartão é neutro no DRE/);
  assert.match(fin,/Itens da fatura entram no DRE; pagamento bancário não/);
  assert.match(fin,/reprocessarPagamentosCartaoDRE/);
});
