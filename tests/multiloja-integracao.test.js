'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const modulo=process.env.BOMBEEF_PGLITE_MODULE;
test('PostgreSQL: migração legada preserva histórico, aceita CNPJ em duas lojas e impede referência cruzada',{skip:!modulo},async()=>{
 const {PGlite}=require(modulo);const db=new PGlite();
 const pool={query:async(sql,p)=>{const r=await db.query(sql,p);return {...r,rowCount:r.affectedRows??r.rows.length};},connect:async()=>({...pool,release(){}})};
 const {garantirEstruturaMultiloja}=require('../lib/multiloja');const {auditarSegurancaMultiloja}=require('../lib/multiloja-security');
 try{
  await db.exec(`CREATE TABLE usuarios(id SERIAL PRIMARY KEY,nome text,email text,senha_hash text,perfil text,ativo boolean DEFAULT true,permissoes jsonb,ultimo_login timestamptz,atualizado_em timestamptz,criado_em timestamptz DEFAULT now());
   INSERT INTO usuarios(nome,perfil) VALUES('Administrador','admin');
   CREATE TABLE login_sessoes(id bigserial PRIMARY KEY,usuario_id int REFERENCES usuarios(id),iniciado_em timestamptz DEFAULT now(),ultima_atividade timestamptz DEFAULT now(),encerrado_em timestamptz,encerramento text,ip text,user_agent text);
   CREATE TABLE fornecedores(cnpj_fornecedor text PRIMARY KEY,razao_social text);
   INSERT INTO fornecedores VALUES('123','Fornecedor original');
   CREATE UNIQUE INDEX uq_fornecedores_cnpj_normalizado ON fornecedores((regexp_replace(cnpj_fornecedor,'[^0-9]','','g')));
   CREATE TABLE fornecedor_produtos(id serial PRIMARY KEY,cnpj_fornecedor text REFERENCES fornecedores(cnpj_fornecedor) ON DELETE SET NULL,produto_codigo text);
   INSERT INTO fornecedor_produtos(cnpj_fornecedor,produto_codigo) VALUES('123','PRODUTO');`);
  await garantirEstruturaMultiloja(pool,{operacional:true});
  let auditoria=await auditarSegurancaMultiloja(pool,{aplicarPoliticas:true});assert.equal(auditoria.ok,true,JSON.stringify(auditoria));
  const original=(await db.query('SELECT id,cnpj_fornecedor,loja_id FROM fornecedores')).rows[0];assert.equal(original.cnpj_fornecedor,'123');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM fornecedor_produtos')).rows[0].n,1);
  await garantirEstruturaMultiloja(pool,{operacional:true});assert.equal((await db.query('SELECT id FROM fornecedores')).rows[0].id,original.id);
  await db.exec(`INSERT INTO lojas(id,empresa_id,codigo,nome,pronta_operacao) VALUES(2,1,'segunda','Segunda',true);
   INSERT INTO fornecedores(cnpj_fornecedor,razao_social,loja_id) VALUES('123','Fornecedor segunda',2);
   INSERT INTO fornecedor_produtos(cnpj_fornecedor,produto_codigo,loja_id) VALUES('123','SEGUNDO',2);`);
  await assert.rejects(db.exec("INSERT INTO fornecedor_produtos(cnpj_fornecedor,produto_codigo,loja_id) VALUES('123','INVALIDO',999)"),/foreign key/i);
  await db.exec(`INSERT INTO fornecedores(cnpj_fornecedor,razao_social,loja_id) VALUES('456','Só primeira loja',1)`);
  await assert.rejects(db.exec("INSERT INTO fornecedor_produtos(cnpj_fornecedor,produto_codigo,loja_id) VALUES('456','CRUZADO',2)"),/foreign key/i);
  await db.exec(`CREATE ROLE operador;GRANT USAGE ON SCHEMA public TO operador;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO operador;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO operador;
   SET ROLE operador;SELECT set_config('app.bb_system','0',false);SELECT set_config('app.loja_id','1',false);`);
  assert.deepEqual((await db.query('SELECT razao_social FROM fornecedores')).rows.map(r=>r.razao_social),['Fornecedor original','Só primeira loja']);
  await assert.rejects(db.exec("INSERT INTO fornecedores(cnpj_fornecedor,razao_social,loja_id) VALUES('999','Vazamento',2)"),/row-level security/i);
  await db.exec("SELECT set_config('app.loja_id','2',false)");assert.deepEqual((await db.query('SELECT razao_social FROM fornecedores')).rows.map(r=>r.razao_social),['Fornecedor segunda']);
  await db.exec("SELECT set_config('app.loja_id','',false)");assert.equal((await db.query('SELECT * FROM fornecedores')).rows.length,0);
  await db.exec("RESET ROLE;SELECT set_config('app.bb_system','1',false)");
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM fornecedores')).rows[0].n,3);
  await db.exec("DELETE FROM fornecedores WHERE loja_id=2 AND cnpj_fornecedor='123'");
  const filho=(await db.query("SELECT cnpj_fornecedor,loja_id FROM fornecedor_produtos WHERE produto_codigo='SEGUNDO'")).rows[0];assert.deepEqual(filho,{cnpj_fornecedor:null,loja_id:2});
  await db.exec("INSERT INTO usuarios(nome,perfil) VALUES('Somente segunda','caixa');INSERT INTO usuario_lojas(usuario_id,loja_id,perfil) VALUES(2,2,'caixa')");
  await garantirEstruturaMultiloja(pool);assert.equal((await db.query('SELECT COUNT(*)::int n FROM usuario_lojas WHERE usuario_id=2 AND loja_id=1')).rows[0].n,0);
  // Exercitar a rota HTTP real de ativação com auditoria e vínculo ativo.
  const express=require('express'),jwt=require('jsonwebtoken');process.env.JWT_SECRET='teste-integracao-sem-segredo-real';
  await db.exec("UPDATE lojas SET pronta_operacao=false WHERE id=2;INSERT INTO login_sessoes(usuario_id,loja_id) VALUES(1,1)");
  const vinculo=(await db.query('SELECT id FROM usuario_lojas WHERE usuario_id=1 AND loja_id=1')).rows[0].id;
  const sessao=(await db.query('SELECT id FROM login_sessoes WHERE usuario_id=1')).rows[0].id;
  const token=jwt.sign({id:1,lojaId:1,perfil:'admin',vinculoLojaId:vinculo,sessaoId:sessao},process.env.JWT_SECRET);
  const app=express();app.use(express.json());app.use('/auth',require('../routes/auth')(pool));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    const url='http://127.0.0.1:'+server.address().port;
    let resposta=await fetch(url+'/auth/multiloja/lojas/2/ativar',{method:'POST',headers:{authorization:'Bearer '+token}});assert.equal(resposta.status,200,await resposta.text());
    await db.exec("INSERT INTO usuario_lojas(usuario_id,loja_id,perfil) VALUES(1,2,'admin')");
    resposta=await fetch(url+'/auth/loja-ativa',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({loja_id:2})});
    assert.equal(resposta.status,200);const troca=await resposta.json(),payload=jwt.verify(troca.token,process.env.JWT_SECRET);
    assert.equal(payload.lojaId,2);assert.notEqual(String(payload.sessaoId),String(sessao));
    resposta=await fetch(url+'/auth/me',{headers:{authorization:'Bearer '+troca.token}});assert.equal(resposta.status,200);assert.equal((await resposta.json()).data.loja.id,2);
    resposta=await fetch(url+'/auth/me',{headers:{authorization:'Bearer '+token}});assert.equal((await resposta.json()).data.loja.id,1);
    resposta=await fetch(url+'/auth/refresh',{method:'POST',headers:{authorization:'Bearer '+troca.token}});assert.equal(resposta.status,200);assert.equal(jwt.verify((await resposta.json()).token,process.env.JWT_SECRET).lojaId,2);
    await db.exec("UPDATE lojas SET pronta_operacao=false WHERE id=2;UPDATE usuarios SET ativo=false WHERE id=2;UPDATE usuario_lojas SET ativo=false WHERE usuario_id=1 AND loja_id=2");
    resposta=await fetch(url+'/auth/multiloja/lojas/2/ativar',{method:'POST',headers:{authorization:'Bearer '+token}});assert.equal(resposta.status,400,await resposta.text());
    assert.equal((await db.query('SELECT pronta_operacao FROM lojas WHERE id=2')).rows[0].pronta_operacao,false);
  }finally{await new Promise(r=>server.close(r));}
 }finally{await db.close();}
});
test('PostgreSQL: referência incoerente aborta e preserva chave e dados',{skip:!modulo},async()=>{
 const {PGlite}=require(modulo),db=new PGlite();const {migrarFornecedores}=require('../lib/multiloja-fornecedores');
 const c={query:async(s,p)=>{const r=await db.query(s,p);return {...r,rowCount:r.affectedRows??r.rows.length}}};
 try{
  await db.exec(`CREATE TABLE lojas(id int PRIMARY KEY);INSERT INTO lojas VALUES(1),(2);
   CREATE TABLE fornecedores(cnpj_fornecedor text PRIMARY KEY,loja_id int);INSERT INTO fornecedores VALUES('123',1);
   CREATE TABLE origem(id int,cnpj text REFERENCES fornecedores(cnpj_fornecedor),loja_id int);INSERT INTO origem VALUES(5,'123',2);`);await db.exec('BEGIN');
  await assert.rejects(migrarFornecedores(c),/fora da loja/);await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT * FROM origem')).rows,[{id:5,cnpj:'123',loja_id:2}]);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM pg_constraint WHERE conname='fornecedores_pkey'")).rows[0].n,1);
 }finally{await db.close();}
});
test('PostgreSQL: chaves legadas de catálogo, configuração e mês são independentes por loja',{skip:!modulo},async()=>{
 const {PGlite}=require(modulo),db=new PGlite();const {migrarChavesLegadas}=require('../lib/multiloja-legados');
 const c={query:async(s,p)=>{const r=await db.query(s,p);return {...r,rowCount:r.affectedRows??r.rows.length}}};
 try{
  await db.exec(`CREATE TABLE produtos_mestre(id serial PRIMARY KEY,codigo_produto text UNIQUE,loja_id int NOT NULL);INSERT INTO produtos_mestre(codigo_produto,loja_id) VALUES('CARNE',1);
   CREATE TABLE lotes_estoque(id serial PRIMARY KEY,codigo_produto text REFERENCES produtos_mestre(codigo_produto),loja_id int NOT NULL);INSERT INTO lotes_estoque(codigo_produto,loja_id) VALUES('CARNE',1);
   CREATE TABLE vld_config(chave text PRIMARY KEY,valor_json jsonb,loja_id int NOT NULL);INSERT INTO vld_config VALUES('metas','{}',1);
   CREATE TABLE vld_faturamento(mes_ref text PRIMARY KEY,loja_id int NOT NULL);INSERT INTO vld_faturamento VALUES('10/2026',1);`);
  await db.exec('BEGIN');await migrarChavesLegadas(c);await db.exec('COMMIT');
  await db.exec(`INSERT INTO produtos_mestre(codigo_produto,loja_id) VALUES('CARNE',2);INSERT INTO lotes_estoque(codigo_produto,loja_id) VALUES('CARNE',2);
   INSERT INTO vld_config VALUES('metas','{"meta":1}',2) ON CONFLICT(loja_id,chave) DO UPDATE SET valor_json=EXCLUDED.valor_json;
   INSERT INTO vld_faturamento VALUES('10/2026',2);`);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM produtos_mestre')).rows[0].n,2);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM vld_config')).rows[0].n,2);
  await assert.rejects(db.exec("INSERT INTO lotes_estoque(codigo_produto,loja_id) VALUES('CARNE',3)"),/foreign key/i);
  await db.exec('BEGIN');await migrarChavesLegadas(c);await db.exec('COMMIT');assert.equal((await db.query('SELECT id FROM produtos_mestre WHERE loja_id=1')).rows[0].id,1);
 }finally{await db.close();}
});
