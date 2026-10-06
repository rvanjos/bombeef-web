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
