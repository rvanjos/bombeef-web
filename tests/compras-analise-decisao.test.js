const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('analise de compras expoe ultima compra com data e valor',()=>{
  const rota=ler('routes/compras_produto.js');
  const tela=ler('public/compras.html');
  assert.match(rota,/AS ultima_compra/);
  assert.match(rota,/'valor_unitario', valor_unitario/);
  assert.match(rota,/'data_entrada', data_entrada/);
  assert.match(rota,/ultima_compra:\s+h\.ultima_compra \|\| null/);
  assert.match(tela,/id="a-ult-custo"/);
  assert.match(tela,/id="a-ult-data"/);
});

test('cotacao fica no topo sem exigir fornecedor e compara em reais e percentual',()=>{
  const tela=ler('public/compras.html');
  assert.match(tela,/Decisão de Compra/);
  assert.match(tela,/Preço cotado agora/);
  assert.match(tela,/id="cot-valor"/);
  assert.match(tela,/id="cot-qtd"/);
  assert.doesNotMatch(tela,/id="cot-forn"/);
  assert.match(tela,/id="r-var-ult-rs"/);
  assert.match(tela,/Subiu/);
  assert.match(tela,/Baixou/);
});

test('layout da decisao de compra e responsivo',()=>{
  const tela=ler('public/compras.html');
  assert.match(tela,/\.compra-decisao-grid\{display:grid/);
  assert.match(tela,/\.compra-decisao-grid\{grid-template-columns:1fr!important\}/);
});


test('analise de compra mostra referencia de venda pelo fator 1,8',()=>{
  const tela=ler('public/compras.html');
  assert.match(tela,/Venda com fator 1,8/);
  assert.match(tela,/const precoFator18 = Number\(\(cotado \* 1\.8\)\.toFixed\(2\)\)/);
  assert.match(tela,/Para manter 1,8: subir/);
  assert.match(tela,/acima da referência/);
  assert.match(tela,/venda referência 1,8x/);
});


test('importacao de compras usa unidade base do produto e preserva unidade de compra',()=>{
  const rota=ler('routes/compras_produto.js');
  assert.match(rota,/const iQtdBase\s*=\s*nthExact\('quantidade',1\)/);
  assert.match(rota,/const iQtdCompra\s*=\s*nthExact\('quantidade',2\)/);
  assert.match(rota,/const iVlUnBase\s*=\s*nthContains\('valor unit',1\)/);
  assert.match(rota,/const iVlUnCompra\s*=\s*nthContains\('valor unit',2\)/);
  assert.match(rota,/quantidade_compra/);
  assert.match(rota,/unidade_compra/);
  assert.match(rota,/valor_unitario_compra/);
});

test('reimportacao da mesma compra corrige conversao em vez de ignorar',()=>{
  const rota=ler('routes/compras_produto.js');
  assert.match(rota,/let dupId = null/);
  assert.match(rota,/UPDATE compras_produto SET/);
  assert.match(rota,/atualizados\+\+/);
  assert.match(rota,/importados \+ atualizados/);
});


test('importacao de compras compara codigo como texto e exige cabecalho exato',()=>{
  const rota=ler('routes/compras_produto.js');
  assert.match(rota,/codigo::text = ANY\(\$1::text\[\]\)/);
  assert.match(rota,/codigos\.map\(String\)/);
  assert.match(rota,/const iCProdExact/);
  assert.match(rota,/Coluna exata de código do produto não encontrada/);
});


test('schema legado de compras converte identificadores para texto sem apagar dados',()=>{
  const rota=ler('routes/compras_produto.js');
  assert.match(rota,/ALTER TABLE compras_produto ALTER COLUMN \$\{col\} TYPE TEXT USING \$\{col\}::text/);
  assert.match(rota,/produto_codigo','fornecedor_codigo','numero_nfe','serie_nfe','cod_item_nfe','cfop/);
  assert.match(rota,/schema compras_produto/);
  assert.match(rota,/etapaImport/);
});


test('schema completo de compras aceita valores decimais em bases legadas',()=>{
  const rota=ler('routes/compras_produto.js');
  assert.match(rota,/colunasTexto/);
  assert.match(rota,/produto_nome','grupo','subgrupo','fornecedor_nome/);
  assert.match(rota,/colunasNumericas/);
  assert.match(rota,/valor_total','NUMERIC\(14,2\)'/);
  assert.match(rota,/quantidade','NUMERIC\(12,4\)'/);
  assert.match(rota,/USING \$\{col\}::numeric/);
  assert.match(rota,/schema compras_produto/);
});
