'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('planejamento anual é persistido por loja com RLS',()=>{
  const rota=ler('routes/dre_planejamento.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS dre_planejamento_anual/);
  assert.match(rota,/loja_id INTEGER NOT NULL/);
  assert.match(rota,/UNIQUE\(loja_id, ano\)/);
  assert.match(rota,/ENABLE ROW LEVEL SECURITY/);
  assert.match(rota,/FORCE ROW LEVEL SECURITY/);
  assert.match(rota,/Perfil contábil tem acesso somente leitura/);
});

test('DRE expõe conciliação e planejamento como áreas próprias',()=>{
  const area=ler('public/js/dre-lancamentos-area.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(area,/data-v="conciliacao"/);
  assert.match(area,/data-v="planejamento"/);
  assert.match(fin,/Conciliação financeira/);
  assert.match(fin,/Planejamento anual/);
  assert.match(fin,/Pagamento de Fatura/);
  assert.match(fin,/\/api\/dre\/planejamento\//);
});

test('conciliação preserva regra contábil do cartão',()=>{
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(fin,/pagamento total do cartão é neutro no DRE/);
  assert.match(fin,/Itens da fatura entram no DRE; pagamento bancário não/);
  assert.match(fin,/reprocessarPagamentosCartaoDRE/);
});


test('conciliação suporta saldo patrimonial inicial sem virar receita do DRE',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS dre_fluxo_saldo_controle/);
  assert.match(rota,/UNIQUE\(loja_id\)/);
  assert.match(rota,/r\.get\('\/fluxo-saldo'/);
  assert.match(rota,/r\.put\('\/fluxo-saldo'/);
  assert.match(rota,/saldo_esperado/);
  assert.match(fin,/Saldo real do fluxo de caixa/);
  assert.match(fin,/Não entra como receita no DRE/);
  assert.match(fin,/\/api\/dre\/fluxo-saldo/);
});

test('abertura e navegação do DRE evitam trabalho redundante',()=>{
  const rota=ler('routes/dre.js');
  const dre=ler('public/dre.html');
  const lanc=ler('public/js/dre-lancamentos-area.js');
  assert.match(rota,/r\.get\('\/sessoes-completas'/);
  assert.match(dre,/\/api\/dre\/sessoes-completas\?limit=24/);
  assert.doesNotMatch(dre,/lista\.data\.map\(s => api\.get\(\`\/api\/dre\/sessoes\/\$\{s\.id\}\`\)\)/);
  assert.match(dre,/Não grava sessões apenas por abrir o DRE/);
  assert.match(dre,/As 24 sessões já estão em memória/);
  assert.match(dre,/_fatCacheEm/);
  assert.match(lanc,/limite:300/);
  assert.match(lanc,/dreLancMais/);
  assert.match(lanc,/list="cats-dl"/);
});


test('linha do tempo de saldos reais localiza divergencias por intervalo',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS dre_fluxo_conferencias/);
  assert.match(rota,/UNIQUE\(loja_id, data_ref\)/);
  assert.match(rota,/r\.get\('\/fluxo-conciliacao'/);
  assert.match(rota,/r\.post\('\/fluxo-conferencias'/);
  assert.match(rota,/variacao_divergencia/);
  assert.match(rota,/duplicidades_periodo/);
  assert.match(fin,/Histórico de conferências/);
  assert.match(fin,/Diagnóstico de divergências/);
  assert.match(fin,/dreFluxoRegistrarConf/);
});

test('datas do PostgreSQL sao normalizadas antes do calculo do caixa',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/function _isoData\(v\)/);
  assert.match(rota,/v instanceof Date/);
  assert.doesNotMatch(rota,/String\(cfg\.data_inicio\)\.slice\(0,10\)/);
  assert.match(fin,/function isoData\(v\)/);
  assert.match(fin,/value="\$\{esc\(isoData\(f\.data_inicio\)\)\}"/);
});

test('saldo esperado usa extrato e aponta duplicidades sem apagar operacoes legitimas',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/FITID é identidade bancária forte/);
  assert.match(rota,/Sem FITID não removemos do saldo/);
  assert.match(rota,/tipo:'Mesmo dia, valor e descrição'/);
  assert.match(rota,/saldo_esperado/);
});


test('PagBank e Itaú não duplicam receita nas transferências internas',()=>{
  const rota=ler('routes/dre.js');
  const fix=ler('scripts/fix-dre-ofx-creditos.js');
  assert.match(rota,/bankId === '290' \? 'PagBank'/);
  assert.match(rota,/VENDAS - DISPONIVEL/);
  assert.match(rota,/categoria = 'VENDAS DE MERCADORIAS'/);
  assert.match(rota,/PIX ENVIADO - O ACOUGUE BOM BEEF VALINHOS/);
  assert.match(rota,/Transferência entre contas/);
  assert.match(rota,/if\(_normFluxo\(t\?\.categoria\)==='TRANSFERENCIA ENTRE CONTAS'\) continue/);
  assert.match(fix,/transferências PagBank↔Itaú conciliadas/);
  assert.match(fix,/diffDias\(dt,dataTx\(e\.t\)\)<=3/);
  assert.match(fix,/transferenciaInterna=true/);
});

test('OFX guarda banco e conta e ignora linhas informativas de saldo',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/const bankId = getGlobal\('BANKID'\)/);
  assert.match(rota,/const acctId = getGlobal\('ACCTID'\)/);
  assert.match(rota,/contaBancaria/);
  assert.match(rota,/SALDO ANTERIOR\|SALDO TOTAL DISPONIVEL DIA/);
});


test('saldo diario mostra esperado real e lancamentos',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/r\.get\('\/fluxo-diario'/);
  assert.match(rota,/SALDO TOTAL DISPONIVEL DIA/);
  assert.match(rota,/SALDO ANTERIOR/);
  assert.match(rota,/saldo_abertura/);
  assert.match(rota,/saldo_esperado/);
  assert.match(rota,/saldo_real/);
  assert.match(fin,/Saldo diário da conta/);
  assert.match(fin,/Saldo abertura/);
  assert.match(fin,/Saldo esperado/);
  assert.match(fin,/Saldo real/);
  assert.match(fin,/dreFluxoToggleDia/);
  assert.match(fin,/lançamento\(s\)/);
});

test('saldo real do dia vira base do dia seguinte',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/saldoBase=saldoReal!=null\?saldoReal:saldoEsperado/);
  assert.match(rota,/Um saldo real fecha o dia e é a base mais confiável para o próximo/);
});

test('saldo informativo do OFX nao entra como movimento financeiro',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/if\(tipoSaldo\)\{/);
  assert.match(rota,/saldosReais\.push/);
  assert.match(rota,/continue;/);
});


test('saldo informado manualmente entra na grade diaria',()=>{
  const rota=ler('routes/dre.js');
  const fin=ler('public/js/dre-planejamento-conciliacao.js');
  assert.match(rota,/SELECT id,data_ref,saldo_real,observacoes,atualizado_em/);
  assert.match(rota,/for\(const cf of conferencias\)/);
  assert.match(rota,/fonteFechamento\.set\(d,'Informado'\)/);
  assert.match(rota,/saldo_real_fonte/);
  assert.match(fin,/Sem saldo real/);
  assert.match(fin,/saldo_real_fonte/);
  assert.match(fin,/carregarFluxoDiario\(st\.diario\?\.conta\|\|undefined\)/);
});

test('grade diaria respeita data e saldo inicial configurados',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/const dataInicio=_isoData\(cfg\?\.data_inicio\)/);
  assert.match(rota,/const de=deReq\|\|\(dataInicio\|\|datas\[0\]\)/);
  assert.match(rota,/baseCfg\?\.saldo_inicial/);
  assert.match(rota,/if\(dataBase===data && baseCfg\?\.saldo_inicial!=null\) saldoBase=Number\(baseCfg\.saldo_inicial\)/);
});

test('OFX preserva saldo informativo sem virar receita ou despesa',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/saldoInformativo: ehSaldoAnterior \? 'abertura' : 'fechamento'/);
  assert.match(rota,/categoria: 'Saldo bancário informativo'/);
  assert.match(rota,/ignorar: true/);
});


test('saldo inicial usa a conta Itau real quando identificada no OFX',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/const contaItauReal=contas\.find/);
  assert.match(rota,/const contaBase=contaItauReal \|\| 'Itaú · conta principal'/);
  assert.match(rota,/const baseDaConta=\(cfg && conta===contaBase\)\?cfg:null/);
  assert.match(rota,/const confDaConta=\(cfg && conta===contaBase\)\?confRows:\[\]/);
});


test('lancamentos Itau legados entram na conta real na grade diaria',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/function _pertenceContaDiaria\(t,conta\)/);
  assert.match(rota,/atual==='Itaú · conta principal'/);
  assert.match(rota,/banco\.movimentos\.filter\(t=>_pertenceContaDiaria\(t,conta\)/);
});
