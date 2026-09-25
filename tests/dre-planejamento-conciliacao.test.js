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


test('conciliação suporta saldo patrimonial inicial sem virar receita do DRE',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS dre_fluxo_saldo_controle/);
  assert.match(rota,/UNIQUE\(loja_id\)/);
  assert.match(rota,/r\.get\('\/fluxo-saldo'/);
  assert.match(rota,/r\.put\('\/fluxo-saldo'/);
  assert.match(rota,/saldo_esperado/);
  assert.match(fin,/Saldo real do fluxo de caixa/);
  assert.match(fin,/Não entra como receita no DRE/);
  assert.match(fin,/\/api\/dre\/fluxo-saldo/);
});

test('abertura e navegação do DRE evitam trabalho redundante',()=>{
  const rota=ler('routes/dre.js');
  const dre=ler('public/dre.html');
  const lanc=ler('public/js/dre-lancamentos-area.js');
  assert.match(rota,/r\.get\('\/sessoes-completas'/);
  assert.match(dre,/\/api\/dre\/sessoes-completas\?limit=24/);
  assert.doesNotMatch(dre,/lista\.data\.map\(s => api\.get\(\`\/api\/dre\/sessoes\/\$\{s\.id\}\`\)\)/);
  assert.match(dre,/Não grava sessões apenas por abrir o DRE/);
  assert.match(dre,/As 24 sessões já estão em memória/);
  assert.match(dre,/_fatCacheEm/);
  assert.match(lanc,/limite:300/);
  assert.match(lanc,/dreLancMais/);
  assert.match(lanc,/list="cats-dl"/);
});


test('linha do tempo de saldos reais localiza divergencias por intervalo',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS dre_fluxo_conferencias/);
  assert.match(rota,/UNIQUE\(loja_id, data_ref\)/);
  assert.match(rota,/r\.get\('\/fluxo-conciliacao'/);
  assert.match(rota,/r\.post\('\/fluxo-conferencias'/);
  assert.match(rota,/variacao_divergencia/);
  assert.match(rota,/duplicidades_periodo/);
  assert.match(fin,/Histórico de conferências/);
  assert.match(fin,/Diagnóstico de divergências/);
  assert.match(fin,/dreFluxoRegistrarConf/);
});

test('datas do PostgreSQL sao normalizadas antes do calculo do caixa',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/function _isoData\(v\)/);
  assert.match(rota,/v instanceof Date/);
  assert.doesNotMatch(rota,/String\(cfg\.data_inicio\)\.slice\(0,10\)/);
  assert.match(fin,/function isoData\(v\)/);
  assert.match(fin,/value="\$\{esc\(isoData\(f\.data_inicio\)\)\}"/);
});

test('saldo esperado usa extrato e aponta duplicidades sem apagar operacoes legitimas',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/FITID é identidade bancária forte/);
  assert.match(rota,/Sem FITID não removemos do saldo/);
  assert.match(rota,/tipo:'Mesmo dia, valor e descrição'/);
  assert.match(rota,/saldo_esperado/);
});
