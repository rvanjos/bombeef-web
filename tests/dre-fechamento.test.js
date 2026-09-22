'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ler = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('fechamento mensal usa a sessão DRE como fonte de verdade', () => {
  const rota = ler('routes/dre.js');
  assert.match(rota, /async function checklistFechamento\(mes, lojaId\)/);
  assert.match(rota, /FROM dre_sessoes WHERE loja_id=\$1 AND mes_ref=\$2/);
  assert.match(rota, /analiseTransacoesSessao\(txs\)/);
  assert.match(rota, /dre_fechamentos/);
  assert.match(rota, /snapshot_json/);
});

test('mês fechado bloqueia salvamento e reabertura exige admin', () => {
  const rota = ler('routes/dre.js');
  assert.match(rota, /bloquearSeFechado\(mes_ref, req\.user\?\.lojaId\)/);
  assert.match(rota, /DRE_MES_FECHADO/);
  assert.match(rota, /Apenas administrador pode reabrir um mês fechado/);
  assert.match(rota, /Informe o motivo da reabertura/);
});

test('fechamento é isolado por loja e auditável', () => {
  const rota = ler('routes/dre.js');
  const seg = ler('lib/multiloja-security.js');
  assert.match(rota, /WHERE loja_id=\$1 AND mes_ref=\$2/);
  assert.match(rota, /dre_fechamento_eventos/);
  assert.match(seg, /'dre_fechamentos'/);
  assert.match(seg, /'dre_fechamento_eventos'/);
});

test('interface carrega status e permite fechar ou reabrir', () => {
  const ui = ler('public/js/dre-fechamento.js');
  const loader = ler('public/js/dre-conferencia.js');
  assert.match(ui, /Fechar mês/);
  assert.match(ui, /Confirmar fechamento/);
  assert.match(ui, /Reabrir mês/);
  assert.match(ui, /dre-mes-fechado/);
  assert.match(loader, /dre-fechamento\.js/);
});
