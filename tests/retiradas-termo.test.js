const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('relatorio de retiradas aceita periodo e funcionario',()=>{
  const rota=ler('routes/retiradas.js');
  assert.match(rota,/r\.get\('\/relatorio-periodo'/);
  assert.match(rota,/ret\.dt_retirada BETWEEN \$2::date AND \$3::date/);
  assert.match(rota,/saldo_restante/);
});

test('termo impresso possui assinatura e escolha de pagamento',()=>{
  const html=ler('public/retiradas.html');
  const js=ler('public/js/retiradas-termo.js');
  assert.match(html,/Termo de Conferência de Retiradas/);
  assert.match(js,/Desconto no Vale Alimentação/);
  assert.match(js,/Pagamento via PIX/);
  assert.match(js,/Responsável Bom Beef/);
  assert.match(js,/Funcionário/);
  assert.match(js,/imprimirTermoRetiradas/);
});
