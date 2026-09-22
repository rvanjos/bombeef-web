'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','public','dre.html'),'utf8');

test('DRE possui uma única preparação compartilhada de dados',()=>{
  assert.match(html,/function prepararBaseDRE\(modoOverride\)/);
  assert.match(html,/function calcularMotorDRE\(mesAlvo, modoOverride\)/);
  assert.match(html,/const baseDRE = prepararBaseDRE\(getModo\(\)\)/);
  assert.match(html,/const baseXLS=prepararBaseDRE\(getModo\(\)\)/);
  assert.match(html,/const baseExport=prepararBaseDRE\(modo\)/);
});

test('motor único inclui regras críticas do DRE',()=>{
  assert.match(html,/_valorParaDRE\(t, gruposParcela, modoBase\)/);
  assert.match(html,/CATS_NAO_OPERACIONAIS\.has\(t\.categoria\)/);
  assert.match(html,/data\.RECEITAS\['VENDAS DE MERCADORIAS'\]/);
  assert.match(html,/ajusteEstoque = estIni - estFin/);
  assert.match(html,/dasEstimado = Math\.round/);
});

test('resultados visuais e exportados vêm do mesmo motor',()=>{
  assert.match(html,/lucBrutoMes\[m\]=calcularMotorDRE\(m,getModo\(\)\)\.lucroBruto/);
  assert.match(html,/lucOpMes\[m\]=calcularMotorDRE\(m,getModo\(\)\)\.lucroOp/);
  assert.match(html,/resAntRetMes\[m\]=calcularMotorDRE\(m,getModo\(\)\)\.final/);
  assert.match(html,/lucBruto\[m\]=calcularMotorDRE\(m,getModo\(\)\)\.lucroBruto/);
  assert.match(html,/const resFinal = meses\.map\(m => calcularMotorDRE\(m,modo\)\.final\)/);
});
