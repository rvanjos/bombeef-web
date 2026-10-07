'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ler=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('DRE possui auditoria bloqueadora antes do envio à franquia',()=>{
  const rota=ler('routes/dre.js');
  const dre=ler('public/dre.html');
  assert.match(rota,/auditoria-franquia\/:mes/);
  assert.match(rota,/status:bloqueios\.length===0\?'APTO_PARA_ENVIO':'NAO_APTO'/);
  assert.match(rota,/Receita do DRE diferente do faturamento/);
  assert.match(rota,/Itens de cartão sem categoria/);
  assert.match(rota,/Pagamento de cartão sem vínculo/);
  assert.match(rota,/Estoque para cálculo do CMV incompleto/);
  assert.match(dre,/Auditar envio/);
  assert.match(dre,/NÃO ENVIAR AINDA/);
});

test('classificação de cartão aprende recorrência persistente por loja',()=>{
  const rota=ler('routes/dre.js');
  const dre=ler('public/dre.html');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS cartao_classificacao_regras/);
  assert.match(rota,/UNIQUE\(loja_id,chave_norm\)/);
  assert.match(rota,/FORCE ROW LEVEL SECURITY/);
  assert.match(rota,/function _normalizarDescricaoCartao/);
  assert.match(rota,/async function _aprenderRegraCartao/);
  assert.match(rota,/ambiguo=true,categoria_dre=NULL/);
  assert.match(rota,/await _backfillRegrasCartaoLoja\(lojaId\)/);
  assert.match(rota,/const catRecorrente=regrasCartao\.get\(chaveNorm\) \|\| it\.categoria \|\| null/);
  assert.match(dre,/let _cartaoRegras = new Map/);
  assert.match(dre,/function aplicarRegrasRecorrentesCartao/);
  assert.match(dre,/!String\(t\.categoria\|\|''\)\.trim\(\)/);
});

test('sessão DRE e memória de cartão respeitam loja',()=>{
  const rota=ler('routes/dre.js');
  assert.match(rota,/SELECT \* FROM dre_sessoes WHERE id = \$1 AND loja_id=\$2/);
  assert.match(rota,/SELECT \* FROM dre_sessoes WHERE mes_ref = \$1 AND loja_id=\$2/);
  assert.match(rota,/WHERE id=\$3 AND loja_id=\$10 RETURNING id/);
  assert.match(rota,/DELETE FROM fornecedores_lookup WHERE cnpj_num='46237080000102'/);
});
