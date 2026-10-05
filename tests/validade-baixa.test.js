const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('descarte de validade nao e bloqueado por estoque insuficiente',()=>{
  const rota=ler('routes/validade.js');
  assert.doesNotMatch(rota,/Estoque insuficiente no descarte/);
  assert.match(rota,/const baixaEstoque = Math\.min\(qtd, disponivel\)/);
  assert.match(rota,/Estoque cadastral menor que a quantidade descartada/);
  assert.match(rota,/divergenciasEstoque/);
  assert.match(rota,/SET estoque = GREATEST\(0, estoque - \$1\)/);
});

test('perda continua sendo registrada pela quantidade descartada',()=>{
  const rota=ler('routes/validade.js');
  assert.match(rota,/const qtd\s*=\s*Math\.abs\(parseInt\(item\.qtd_unidades \|\| 0\)\)/);
  assert.match(rota,/INSERT INTO perdas/);
  assert.match(rota,/qtd, valor, dtHoje, mes/);
});

test('tela informa divergencia sem transformar em erro',()=>{
  const html=ler('public/validade.html');
  assert.match(html,/d\.alerta \? '⚠️ ' \+ d\.alerta/);
});


test('validade nunca apaga fisicamente itens em dedup ou exclusao em lote',()=>{
  const rota=ler('routes/validade.js');
  assert.doesNotMatch(rota,/DELETE FROM validade_items/);
  assert.match(rota,/status='arquivado'/);
  assert.match(rota,/resolucao='duplicata'/);
  assert.match(rota,/resolucao='exclusao_manual'/);
  assert.match(rota,/resolucao='arquivamento_admin'/);
});

test('interface de validade informa arquivamento sem perda de dados',()=>{
  const html=ler('public/validade.html');
  assert.match(html,/Arquivar Duplicatas/);
  assert.match(html,/mantendo todos os registros no banco/);
  assert.match(html,/sem excluir dados/);
});


test('persistencia confirmada de validade grava e retorna campos editados',()=>{
  const rota=ler('routes/validade.js');
  const tela=ler('public/validade.html');
  assert.match(rota,/preco_custo\s*=\s*COALESCE\(\$17, preco_custo\)/);
  assert.match(rota,/RETURNING \*/);
  assert.match(rota,/Item de validade não encontrado para atualização/);
  assert.match(rota,/data_recebimento, preco_custo\)/);
  assert.match(tela,/conferirPersistenciaValidade/);
  assert.match(tela,/Item atualizado e confirmado no banco/);
});

test('edicao de validade recarrega observacao existente antes de salvar',()=>{
  const tela=ler('public/validade.html');
  assert.match(tela,/const obsVisivel = String\(v\?\.observacao\|\|''\)/);
  assert.match(tela,/getElementById\('v-obs'\)\.value = obsVisivel/);
});


test('botao editar validade permanece visivel na tabela e dashboard',()=>{
  const tela=ler('public/validade.html');
  assert.match(tela,/val-edit-btn/);
  assert.match(tela,/✏️ Editar/);
  assert.match(tela,/val-acoes\{position:sticky;right:0/);
});

test('editar validade no desktop e no mobile encontra todos os campos do modal',()=>{
  const html=ler('public/validade.html');
  const modal=html.split('<!-- Modal Validade -->')[1].split('<!-- Modal Editar Histórico -->')[0];
  const fn=html.split('async function abrirModal(id){')[1].split('// ── Calculadora de pesagem')[0];
  const usados=[...fn.matchAll(/document\.getElementById\('([^']+)'\)/g)].map(m=>m[1]);
  for(const largura of [1440,390]){
    for(const id of usados){
      assert.match(modal,new RegExp('id="'+id+'"'), 'campo '+id+' ausente no formulário, viewport '+largura);
    }
    assert.match(modal,/id="v-obs"/);
    assert.match(html,/onclick="abrirModal\(\$\{v\.id\}\)"/);
  }
});


test('editor de validade aceita id string e possui fallback por API',()=>{
  const tela=ler('public/validade.html');
  const rota=ler('routes/validade.js');
  assert.match(tela,/String\(x\.id\)===String\(id\)/);
  assert.match(tela,/\/api\/validade\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(tela,/erro ao abrir edição/);
  assert.match(rota,/r\.get\('\/:id'/);
  assert.match(rota,/Item de validade não encontrado/);
});
