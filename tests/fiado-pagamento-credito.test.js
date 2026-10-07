'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('fiado aceita pagamento acima do saldo e registra crédito',()=>{
  const rota=ler('routes/fiado.js');
  assert.doesNotMatch(rota,/Pagamento maior que o saldo aberto/);
  assert.match(rota,/credito_saldo NUMERIC\(12,2\)/);
  assert.match(rota,/credito_gerado NUMERIC\(12,2\)/);
  assert.match(rota,/const creditoGerado = Math\.max\(0, Number\(\(valorNumerico - saldoDisponivel\)\.toFixed\(2\)\)\)/);
  assert.match(rota,/credito_saldo=COALESCE\(credito_saldo,0\)\+\$2/);
  assert.match(rota,/credito_gerado:creditoGerado/);
});
