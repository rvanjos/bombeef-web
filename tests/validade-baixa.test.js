const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('descarte de validade nao e bloqueado por estoque insuficiente',()=>{
  const rota=ler('routes/validade.js');
  assert.doesNotMatch(rota,/Estoque insuficiente no descarte/);
  assert.match(rota,/const baixaEstoque = Math\.min\(qtd, disponivel\)/);
  assert.match(rota,/Estoque cadastral menor que a quantidade descartada/);
  assert.match(rota,/divergenciasEstoque/);
  assert.match(rota,/SET estoque = GREATEST\(0, estoque - \$1\)/);
});

test('perda continua sendo registrada pela quantidade descartada',()=>{
  const rota=ler('routes/validade.js');
  assert.match(rota,/const qtd\s*=\s*Math\.abs\(parseInt\(item\.qtd_unidades \|\| 0\)\)/);
  assert.match(rota,/INSERT INTO perdas/);
  assert.match(rota,/qtd, valor, dtHoje, mes/);
});

test('tela informa divergencia sem transformar em erro',()=>{
  const html=ler('public/validade.html');
  assert.match(html,/d\.alerta \? '⚠️ ' \+ d\.alerta/);
});
