'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('resultado oficial persistido é sempre competência',()=>{
  const dre=ler('public/dre.html');
  assert.match(dre,/function calcResultadoDRE\(mesAlvo, modoOverride\)/);
  assert.match(dre,/calcResultadoDRE\(mes, 'comp'\)/);
  assert.match(dre,/resultadoModo: 'competencia'/);
  assert.match(dre,/estoquesMes: window\._estoquesMes \|\| \{\}/);
});

test('diagnóstico e evolução não usam mais dre_lancamentos como fonte financeira',()=>{
  const rota=ler('routes/dre.js');
  const inicio=rota.indexOf('// ── Leituras consolidadas do DRE');
  const fim=rota.indexOf('// CONTROLE DE FATURAS DE CARTÃO',inicio);
  const bloco=rota.slice(inicio,fim);
  assert.match(bloco,/fonte:'dre_sessoes'/);
  assert.match(bloco,/res_receitas/);
  assert.match(bloco,/res_despesas/);
  assert.match(bloco,/res_final/);
  assert.doesNotMatch(bloco,/FROM dre_lancamentos/);
});

test('relatório usa snapshot quando o mês está fechado',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/fechamento\?\.status==='FECHADO'/);
  assert.match(rota,/fonte='FECHAMENTO'/);
  assert.match(rota,/snapshot_json/);
  assert.match(rota,/estrutura\.totalReceitas=Number\(oficial\?\.receitas/);
});
