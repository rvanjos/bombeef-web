const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('ponto aplica tolerancia legal e exige aprovacao de extras',()=>{
  const rota=ler('routes/ponto.js');
  assert.match(rota,/entradaAntecipada>5 \|\| saidaPosterior>5/);
  assert.match(rota,/excedente>10/);
  assert.match(rota,/aprovacao_status/);
  assert.match(rota,/pendentes-aprovacao\/count/);
  assert.match(rota,/aprovacoes\/decidir-lote/);
});

test('retorno antecipado do intervalo exige confirmacao e motivo',()=>{
  const rota=ler('routes/ponto.js');
  const tela=ler('public/ponto.html');
  assert.match(rota,/confirmacao_necessaria:true/);
  assert.match(rota,/confirmar_intervalo_curto/);
  assert.match(rota,/motivo_intervalo/);
  assert.match(tela,/Tem certeza que deseja retornar agora/);
  assert.match(tela,/Informe por que está retornando antes de completar o intervalo/);
});

test('troca de folga zera hora extra sem apagar o registro',()=>{
  const rota=ler('routes/ponto.js');
  assert.match(rota,/registros\/:id\/troca-folga/);
  assert.match(rota,/extra_minutos=CASE WHEN \$1 THEN 0 ELSE extra_minutos END/);
  assert.match(rota,/troca_folga_data/);
  assert.doesNotMatch(rota,/DELETE FROM ponto_registros/);
});

test('dashboard mostra pendencias de ponto e fiado',()=>{
  const html=ler('public/index.html');
  assert.match(html,/api\/ponto\/pendentes-aprovacao\/count/);
  assert.match(html,/api\/fiado\/pendentes-aprovacao\/count/);
  assert.match(html,/dash-pend-ponto/);
  assert.match(html,/dash-pend-fiado/);
});

test('aprovacao em lote existe na interface e backend',()=>{
  const tela=ler('public/ponto.html');
  const rota=ler('routes/ponto.js');
  assert.match(tela,/Aprovar selecionadas/);
  assert.match(tela,/Rejeitar selecionadas/);
  assert.match(tela,/Troca de folga/);
  assert.match(rota,/WHERE id=ANY\(\$4::int\[\]\) AND aprovacao_status='pendente'/);
});


test('dashboard mantém ponto e fiado visíveis e soma ponto no total',()=>{
  const html=ler('public/index.html');
  assert.match(html,/sempreVisivel = tipo==='ponto' \|\| tipo==='fiado'/);
  assert.match(html,/dados\.rh\+dados\.retiradas\+dados\.fiado\+dados\.ponto/);
  assert.match(html,/\['admin','gestor'\]\.includes\(usuario\?\.perfil\)/);
});

test('rotas estáticas de alertas de validade não são capturadas pelo GET de item',()=>{
  const rota=ler('routes/validade.js');
  assert.match(rota,/r\.get\('\/:id\(\\\\d\+\)'/);
  assert.match(rota,/r\.get\('\/alertas-confirmacao'/);
  assert.match(rota,/r\.get\('\/alertas-dashboard'/);
});

test('gestor pode visualizar e aprovar pendencias do ponto',()=>{
  const rota=ler('routes/ponto.js');
  const tela=ler('public/ponto.html');
  assert.match(rota,/\['admin','gestor'\]\.includes\(req\.user\?\.perfil\)/);
  assert.match(tela,/\['admin','gestor'\]\.includes\(me\.data\.perfil\)/);
});


test('ponto exige justificativa para almoco corrido e hora extra na saida',()=>{
  const rota=ler('routes/ponto.js');
  const tela=ler('public/ponto.html');
  assert.match(rota,/tipo:'intervalo_nao_registrado'/);
  assert.match(rota,/justificativa_almoco_corrido/);
  assert.match(rota,/tipo:'hora_extra_saida'/);
  assert.match(rota,/justificativa_hora_extra/);
  assert.match(tela,/A justificativa da hora extra é obrigatória/);
  assert.match(tela,/almoço corrido\/sem intervalo registrado/);
});

test('aprovacao do ponto mostra origem, marcacoes, justificativas e ajuste',()=>{
  const rota=ler('routes/ponto.js');
  const tela=ler('public/ponto.html');
  assert.match(rota,/horario_entrada_previsto/);
  assert.match(rota,/almoco_corrido_justificativa/);
  assert.match(tela,/Entrada antecipada/);
  assert.match(tela,/Saída após horário/);
  assert.match(tela,/Justificativa do funcionário/);
  assert.match(tela,/Ajustar ponto/);
});

test('rh centraliza jornada ferias e afastamentos',()=>{
  const rota=ler('routes/ponto.js');
  const rh=ler('public/rh.html');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS ponto_ausencias/);
  assert.match(rota,/r\.post\('\/ausencias'/);
  assert.match(rota,/r\.post\('\/ausencias\/:id\/cancelar'/);
  assert.match(rota,/r\.get\('\/jornada-config\/:funcionario_id'/);
  assert.match(rh,/Jornada, Férias e Afastamentos/);
  assert.match(rh,/Registrar período/);
  assert.match(rh,/salvarJornadaRH/);
});

test('configuracao de jornada saiu da barra principal do ponto',()=>{
  const ponto=ler('public/ponto.html');
  assert.doesNotMatch(ponto,/id="btn-admin-ponto"/);
});


test('hora extra usa jornada efetiva do dia e nao jornada fixa do funcionario',()=>{
  const rota=ler('routes/ponto.js');
  const rh=ler('public/rh.html');
  assert.match(rota,/LEFT JOIN ponto_jornada_dia jd/);
  assert.match(rota,/jornada_horas_efetiva/);
  assert.match(rota,/EXTRACT\(DOW FROM p\.data_ref\)::int/);
  assert.match(rota,/COALESCE\(jd\.horario_entrada,f\.horario_entrada\)/);
  assert.match(rota,/COALESCE\(aprovacao_status,'nao_aplicavel'\) IN \('nao_aplicavel','pendente'\)/);
  assert.match(rh,/const extraMin=Math\.max\(0,Number\(p\.extra_minutos\|\|0\)\)/);
});

test('listagem do ponto recalcula pendencias recentes antes de renderizar',()=>{
  const rota=ler('routes/ponto.js');
  const trecho=rota.slice(rota.indexOf("r.get('/registros'"),rota.indexOf("r.put('/registros/:id'"));
  assert.match(trecho,/await recalcularPendenciasRecentes\(\)/);
});


test('cartao ponto mensal nao depende de dias_folga legado e mostra erro real na tela',()=>{
  const rota=ler('routes/ponto.js');
  const rh=ler('public/rh.html');
  const trecho=rota.slice(rota.indexOf("r.get('/resumo-mensal'"),rota.indexOf("// ── Férias e afastamentos"));
  assert.match(trecho,/ARRAY\[\]::TEXT\[\] AS dias_folga/);
  assert.doesNotMatch(trecho,/f\.dias_folga/);
  assert.match(rh,/Erro ao carregar dados do cartão ponto/);
});
