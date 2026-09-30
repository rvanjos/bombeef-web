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
  assert.match(html,/Relatório de Retiradas para Baixa/);
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

test('forma de pagamento e escolhida no impresso e confirmada depois',()=>{
  const html=ler('public/retiradas.html');
  const js=ler('public/js/retiradas-termo.js');
  assert.doesNotMatch(html,/id="rel-forma"/);
  assert.match(js,/Desconto no Vale Alimentação/);
  assert.match(js,/Pagamento via PIX/);
  assert.match(js,/Forma de pagamento escolhida pelo funcionário/);
  assert.match(js,/rel-baixa-forma/);
  assert.match(js,/Selecione após a assinatura/);
});


test('botoes de impressao abrem sempre o termo com assinatura',()=>{
  const html=ler('public/retiradas.html');
  assert.match(html,/Relatório para baixa/);
  assert.match(html,/Imprimir para baixa/);
  assert.equal((html.match(/onclick="abrirRelatorio\(\)"/g)||[]).length>=2,true);
  assert.doesNotMatch(html,/onclick="imprimirRetiradas\(\)">🖨️ Imprimir/);
});


test('relatorio valida e confirma baixa integral de todos os itens',()=>{
  const rota=ler('routes/retiradas.js');
  const js=ler('public/js/retiradas-termo.js');
  assert.match(rota,/relatorio-periodo\/validar-baixa/);
  assert.match(rota,/relatorio-periodo\/confirmar-baixa/);
  assert.match(rota,/FOR UPDATE/);
  assert.match(rota,/status='pago'/);
  assert.match(rota,/INSERT INTO pagamento_retirada_itens/);
  assert.match(js,/Conferir se pode dar baixa/);
  assert.match(js,/Confirmar pagamento de todos/);
  assert.match(rota,/O relatório mudou desde a emissão/);
});

test('atalho legado de imprimir abre relatorio de baixa',()=>{
  const js=ler('public/js/retiradas-termo.js');
  assert.match(js,/window\.imprimirRetiradas = window\.abrirRelatorio/);
});


test('relatorio impresso possui assinatura explicita e layout proprio',()=>{
  const js=ler('public/js/retiradas-termo.js');
  assert.match(js,/RELATÓRIO PARA BAIXA/);
  assert.match(js,/Assinatura do funcionário/);
  assert.match(js,/TOTAL A PAGAR \/ DESCONTAR/);
  assert.match(js,/Conferência e autorização do funcionário/);
  assert.match(js,/baixa no sistema deve ser confirmada somente após/);
});

test('arquivo do termo usa cache busting',()=>{
  const html=ler('public/retiradas.html');
  assert.match(html,/retiradas-termo\.js\?v=20260930-1521/);
});
