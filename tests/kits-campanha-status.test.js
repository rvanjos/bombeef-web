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
