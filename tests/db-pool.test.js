const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const ler=p=>fs.readFileSync(path.join(root,p),'utf8');

const runtime=[
  'server.js',
  'routes/dre_planejamento.js',
  'routes/dre_conferencia_v2.js',
  'routes/agente_financeiro_drive.js',
  'routes/agente_financeiro_cartao_v3.js',
  'routes/agente_financeiro_drive_parser_v2.js'
];

test('runtime usa um unico pool PostgreSQL compartilhado',()=>{
  const db=ler('lib/db.js');
  assert.match(db,/new Pool\(/);
  assert.match(db,/DB_POOL_MAX \|\| 8/);
  assert.match(db,/protegerPoolPorLoja/);

  for(const p of runtime){
    const src=ler(p);
    assert.doesNotMatch(src,/new Pool\(/, p+' nao deve criar Pool proprio');
    assert.match(src,p==='server.js'?/require\('\.\/lib\/db'\)/:/require\('\.\.\/lib\/db'\)/);
  }
});

test('limite do pool e conservador e configuravel',()=>{
  const db=ler('lib/db.js');
  assert.match(db,/Math\.max\(2, Math\.min\(20/);
  assert.match(db,/idleTimeoutMillis/);
  assert.match(db,/connectionTimeoutMillis/);
});


test('release nao executa rollback fora de transacao',()=>{
  const tenant=ler('lib/tenant-context.js');
  assert.match(tenant,/let emTransacao = false/);
  assert.match(tenant,/emTransacao \? queryOriginal\('ROLLBACK'\) : null/);
  assert.match(tenant,/\^\(BEGIN\|START TRANSACTION\)/);
  assert.match(tenant,/\^\(COMMIT\|ROLLBACK\)/);
});


test('startup normal nao executa reparos legados',()=>{
  const pkg=JSON.parse(ler('package.json'));
  assert.equal(pkg.scripts.start,'node scripts/start.js');
  assert.match(pkg.scripts['maintenance:legacy'],/finalize-multiloja/);
  assert.match(pkg.scripts['maintenance:legacy'],/fix-dre-ofx-creditos/);
  assert.match(pkg.scripts['maintenance:legacy'],/audit-multiloja/);
});


test('migracao operacional multiloja nao roda automaticamente',()=>{
  const auth=ler('routes/auth.js');
  assert.match(auth,/RUN_MULTILOJA_MIGRATIONS === '1'/);
  assert.match(auth,/migração operacional automática desativada/);
});
