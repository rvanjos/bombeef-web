const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('campanhas separam reservados, separacao, entregues e pagos',()=>{
  const rota=ler('routes/kits_campanha.js');
  assert.match(rota,/status='reservado'\) AS reservados/);
  assert.match(rota,/status='separado'\) AS em_separacao/);
  assert.match(rota,/status IN \('entregue','conciliado'\)\) AS entregues/);
  assert.match(rota,/COALESCE\(p\.pago,false\)=true\) AS pagos/);
});

test('disponibilidade usa comprometidos sem chamar reservado de entregue',()=>{
  const rota=ler('routes/kits_campanha.js');
  const tela=ler('public/gestao-kits.html');
  assert.match(rota,/AS comprometidos/);
  assert.match(rota,/limite - comprometidos/);
  assert.match(tela,/\(c\.entregues\|\|0\)\/c\.limite_campanha/);
  assert.match(tela,/\$\{c\.entregues\|\|0\} entregues/);
  assert.doesNotMatch(tela,/\$\{c\.vendidos\|\|0\} entregues/);
});


test('estoque insuficiente nao bloqueia entrega de kits',()=>{
  const rota=ler('routes/kits_campanha.js');
  const tela=ler('public/gestao-kits.html');
  assert.doesNotMatch(rota,/Estoque insuficiente para concluir a entrega\./);
  assert.match(rota,/const avisosEstoque = insuficientes\.map/);
  assert.match(rota,/Entrega concluída com estoque negativo/);
  assert.match(rota,/UPDATE produtos SET estoque=estoque-\$1/);
  assert.match(tela,/d\.aviso_estoque/);
});


test('constraint de movimentos aceita KIT_ENTREGA sem bloquear estoque',()=>{
  const server=ler('server.js');
  const mov=ler('routes/movimentos.js');
  assert.match(server,/DROP CONSTRAINT IF EXISTS movimentos_estoque_tipo_movimento_check/);
  assert.match(server,/KIT_ENTREGA/);
  assert.match(server,/NOT VALID/);
  assert.match(mov,/KIT_ENTREGA/);
  assert.match(mov,/VENDA_ANALYTICS/);
});
