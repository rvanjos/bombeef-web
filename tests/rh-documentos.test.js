const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ler=p=>fs.readFileSync(path.join(root,p),'utf8');

test('documentos RH usam bucket privado e banco guarda apenas metadados',()=>{
  const rota=ler('routes/rh.js');
  assert.match(rota,/CREATE TABLE IF NOT EXISTS rh_documentos_funcionario/);
  assert.match(rota,/storage_key TEXT NOT NULL UNIQUE/);
  assert.match(rota,/arquivo_hash_sha256 TEXT NOT NULL/);
  assert.match(rota,/RH_DOCS_S3_ENDPOINT/);
  assert.match(rota,/s3Request\('PUT'/);
  assert.match(rota,/s3Request\('GET'/);
  assert.doesNotMatch(rota,/BYTEA/);
});

test('documentos respeitam loja e acesso do funcionario',()=>{
  const rota=ler('routes/rh.js');
  assert.match(rota,/d\.loja_id=NULLIF\(current_setting\('app\.loja_id',true\),''\)::int/);
  assert.match(rota,/Number\(doc\.usuario_id\)!==Number\(req\.user\?\.id\)/);
  assert.match(rota,/funcionarioDoUsuario/);
});

test('confirmacao exige visualizacao e nao apaga historico',()=>{
  const rota=ler('routes/rh.js');
  assert.match(rota,/visualizado_em IS NOT NULL OR exige_confirmacao=false/);
  assert.match(rota,/confirmado_em=COALESCE\(confirmado_em,NOW\(\)\)/);
  assert.match(rota,/SET status='arquivado'/);
  assert.doesNotMatch(rota,/DELETE FROM rh_documentos_funcionario/);
});

test('interface diferencia recebimento de concordancia',()=>{
  const tela=ler('public/rh.html');
  assert.match(tela,/Confirmar recebimento/);
  assert.match(tela,/não significa concordância com valores ou quitação/);
  assert.match(tela,/Abra o documento primeiro para liberar a confirmação/);
  assert.match(tela,/FormData/);
  assert.match(tela,/Authorization:'Bearer '/);
});
