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


test('termo simples usa apenas valores em aberto e total do desconto',()=>{
  const js=ler('public/js/retiradas-termo.js');
  assert.match(js,/filter\(x=>Number\(x\.saldo_restante\|\|0\)>0\.004\)/);
  assert.match(js,/TOTAL DO DESCONTO/);
  assert.match(js,/Valor a descontar/);
  assert.doesNotMatch(js,/Total retirado/);
  assert.doesNotMatch(js,/Já pago/);
  assert.doesNotMatch(js,/Saldo para quitação/);
});

test('forma de pagamento e obrigatoria e sai impressa',()=>{
  const html=ler('public/retiradas.html');
  const js=ler('public/js/retiradas-termo.js');
  assert.match(html,/id="rel-forma"/);
  assert.match(js,/Selecione a forma de pagamento/);
  assert.match(js,/Forma de pagamento escolhida/);
  assert.match(js,/Desconto no Vale Alimentação/);
  assert.match(js,/Pagamento via PIX/);
});


test('botoes de impressao abrem sempre o termo com assinatura',()=>{
  const html=ler('public/retiradas.html');
  assert.match(html,/Relatório para assinatura/);
  assert.match(html,/Imprimir termo assinado/);
  assert.equal((html.match(/onclick="abrirRelatorio\(\)"/g)||[]).length>=2,true);
  assert.doesNotMatch(html,/onclick="imprimirRetiradas\(\)">🖨️ Imprimir/);
});
