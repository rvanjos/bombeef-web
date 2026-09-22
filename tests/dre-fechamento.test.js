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


test('conferência permite validar suspeita e fechamento respeita decisão', () => {
  const core = ler('public/js/dre-conferencia-core.js');
  const rota = ler('routes/dre.js');
  assert.match(core, /Está correto \/ não é duplicidade/);
  assert.match(core, /tipo:'DUPLICIDADE'/);
  assert.match(core, /chaveDuplicidade/);
  assert.match(rota, /dre_conferencia_decisoes/);
  assert.match(rota, /duplicidadesPendentes/);
  assert.match(rota, /Pagamentos parecidos para revisão/);
});

test('área de lançamentos usa a mesma fonte em memória do DRE', () => {
  const area = ler('public/js/dre-lancamentos-area.js');
  assert.match(area, /getDreTransactions/);
});

test('mês fechado também protege auditoria, recuperação e exclusão de fatura', () => {
  const dre = ler('routes/dre.js');
  const aud = ler('routes/auditoria.js');
  assert.match(dre, /Reabra antes de recuperar\/alterar a sessão/);
  assert.match(dre, /competência desta fatura está em um DRE fechado/);
  assert.match(aud, /fechamento_status/);
  assert.match(aud, /DRE_MES_FECHADO/);
});

test('tabelas de fechamento aplicam RLS fail-closed no próprio módulo', () => {
  const dre = ler('routes/dre.js');
  assert.match(dre, /ALTER TABLE \$\{tabela\} ENABLE ROW LEVEL SECURITY/);
  assert.match(dre, /ALTER TABLE \$\{tabela\} FORCE ROW LEVEL SECURITY/);
  assert.match(dre, /CREATE POLICY bb_isolamento_loja/);
});
