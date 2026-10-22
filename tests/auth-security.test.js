'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),jwt=require('jsonwebtoken'),fs=require('node:fs');
const {verificarToken}=require('../lib/auth-token');
const {alterarSenha}=require('../lib/auth-password');
const autenticar=require('../middleware/auth');
process.env.JWT_SECRET='fixture-local-sem-credenciais-reais';
const payload={id:1,lojaId:2,vinculoLojaId:3,sessaoId:4};
const assinar=(p=payload,options={expiresIn:'1h'})=>jwt.sign(p,process.env.JWT_SECRET,options);
test('aceita token completo assinado com HS256',()=>assert.equal(verificarToken(assinar()).sessaoId,4));
test('rejeita tokens sem sessão, vínculo, loja, usuário ou expiração',()=>{
 for(const k of Object.keys(payload)){const p={...payload};delete p[k];assert.throws(()=>verificarToken(assinar(p)));}
 assert.throws(()=>verificarToken(assinar(payload,{})));
 assert.throws(()=>verificarToken(assinar({...payload,sessaoId:[]})));
 assert.throws(()=>verificarToken(assinar(payload,{algorithm:'HS384',expiresIn:'1h'})));
});
test('token expirado só é lido no refresh; formato continua obrigatório',()=>{
 const t=assinar({...payload,iat:Math.floor(Date.now()/1000)-100},{expiresIn:1});
 assert.throws(()=>verificarToken(t));assert.equal(verificarToken(t,{ignoreExpiration:true}).id,1);
 assert.throws(()=>verificarToken(assinar(payload,{}),{ignoreExpiration:true}));
});
test('middleware rejeita sessão ausente antes de consultar banco',async()=>{
 let consultas=0;autenticar.configurarPool({query:async()=>{consultas++;return {rows:[{perfil:'admin'}]}}});
 const p={...payload};delete p.sessaoId;const res={status(n){this.code=n;return this},json(){return this}};
 await autenticar()({headers:{authorization:'Bearer '+assinar(p)}},res,()=>assert.fail('acesso indevido'));
 assert.equal(res.code,401);assert.equal(consultas,0);
});
function poolFixture({found=true,fail=false}={}){
 const queries=[];let released=false;
 return {queries,get released(){return released},async connect(){return {async query(sql,params){queries.push({sql,params});if(sql.includes('UPDATE login_sessoes')&&fail)throw Error('falha simulada');return {rows:sql.includes('UPDATE usuarios')&&found?[{id:1}]:[]}},release(){released=true}}}};
}
test('troca senha e revoga todas as sessões atomicamente, preservando histórico',async()=>{
 const p=poolFixture();assert.equal(await alterarSenha(p,1,'hash-fixture',{lojaId:2}),true);
 assert.match(p.queries[1].sql,/ul.loja_id=\$4/);assert.equal(p.queries[1].params[3],2);
 assert.match(p.queries[2].sql,/usuario_id=\$1 AND encerrado_em IS NULL/);assert.doesNotMatch(p.queries[2].sql,/loja_id|DELETE/);
 assert.equal(p.queries.at(-1).sql,'COMMIT');assert.equal(p.released,true);
});
test('falha ao revogar sessões desfaz a alteração de senha',async()=>{
 const p=poolFixture({fail:true});await assert.rejects(alterarSenha(p,1,'hash-fixture'));assert.equal(p.queries.at(-1).sql,'ROLLBACK');assert.equal(p.released,true);
});
test('senha concorrente ou usuário fora da loja não é alterado',async()=>{
 const p=poolFixture({found:false});assert.equal(await alterarSenha(p,1,'hash-fixture',{hashAnterior:'anterior'}),false);
 assert.equal(p.queries[1].params[2],'anterior');assert.equal(p.queries.at(-1).sql,'ROLLBACK');assert.equal(p.queries.length,3);
});
test('recuperação administrativa pública foi removida e refresh não cria sessão',()=>{
 const src=fs.readFileSync('routes/auth.js','utf8');assert.doesNotMatch(src,/reset-admin/);
 const refresh=src.slice(src.indexOf("r.post('/refresh'"),src.indexOf('// ── POST /login'));
 assert.doesNotMatch(refresh,/abrirSessao/);assert.match(refresh,/verificarToken/);assert.match(refresh,/vinculo_id/);
});
test('login verifica senha novamente sob bloqueio antes de criar sessão',async()=>{
 const {abrirSessaoAutenticada}=require('../lib/auth-password');
 for(const found of [true,false]) {
  const sqls=[];const p={connect:async()=>({query:async(sql)=>{sqls.push(sql);return {rows:found?[{id:8}]:[]}},release(){}})};
  const id=await abrirSessaoAutenticada(p,1,'hash-fixture',2,{headers:{}});
  assert.equal(id,found?8:null);assert.match(sqls[1],/senha_hash=\$2\) AND ativo=true FOR UPDATE/);
  assert.equal(sqls.some(s=>s.startsWith('INSERT')),found);assert.equal(sqls.at(-1),found?'COMMIT':'ROLLBACK');
 }
});
test('administrador de loja não recebe administração global por herdar o perfil local',async()=>{
 const {exigirAdminGlobal}=require('../lib/admin-global');
 for(const [rows,code] of [[[],403],[[{id:1}],200]]) {
  let called=false,sql;const res={status(n){this.code=n;return this},json(){return this}};
  await exigirAdminGlobal({query:async(s)=>{sql=s;return {rows}}})({user:{id:1,perfil:'admin'}},res,()=>called=true);
  assert.match(sql,/ativo=true AND perfil='admin'/);assert.equal(called,code===200);assert.equal(res.code||200,code);
 }
});
test('indisponibilidade do banco não libera administração global',async()=>{
 const {exigirAdminGlobal}=require('../lib/admin-global');const res={status(n){this.code=n;return this},json(){return this}};
 await exigirAdminGlobal({query:async()=>{throw Error('offline')}})({user:{id:1}},res,()=>assert.fail('acesso indevido'));assert.equal(res.code,503);
});
test('texto malicioso é escapado na configuração e nomes não são interpolados em eventos',()=>{
 const vm=require('node:vm'),src=fs.readFileSync('public/config.html','utf8');const fn=src.match(/function escLoja\(v\)\{[^\n]+/)[0];const ctx={};vm.runInNewContext(fn,ctx);
 assert.equal(ctx.escLoja('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
 assert.match(src,/escLoja\(u.nome\)/);assert.match(src,/escLoja\(f.nome\)/);assert.match(src,/escLoja\(c.grupo \|\| ''\)/);
 assert.doesNotMatch(src,/onclick="(?:inativarUsr|excluirUsr)\([^\n]*u.nome/);
});
test('troca de loja não abre sessão se a senha foi trocada durante a requisição',async()=>{
 const {abrirSessaoAutenticada}=require('../lib/auth-password'),queries=[];
 const p={connect:async()=>({query:async(sql)=>{queries.push(sql);return {rows:sql.startsWith('SELECT id FROM usuarios')?[{id:1}]:[]}},release(){}})};
 assert.equal(await abrirSessaoAutenticada(p,1,null,2,{headers:{}},4),null);
 assert.equal(queries.some(s=>s.startsWith('INSERT')),false);assert.equal(queries.at(-1),'ROLLBACK');
});
