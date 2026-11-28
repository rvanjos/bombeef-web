'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PERFIL,PERMISSOES,migrarDaniela}=require('../lib/gerente-operacional');
const {PERFIS,dadosPerfil}=require('../lib/usuarios-perfil');
const correcao=require('../lib/fiado-correcao-pagamento');
test('gerente operacional é separado do gestor e perfil próprio não concede acesso',()=>{
 assert.ok(PERFIS.includes('gestor'));assert.ok(PERFIS.includes(PERFIL));assert.notEqual(PERFIL,'gestor');
 assert.deepEqual(dadosPerfil({perfil:PERFIL,permissoes:PERMISSOES}),{});
 assert.equal(correcao.podeCorrigir({perfil:PERFIL,permissoes:PERMISSOES}),true);
 assert.equal(correcao.podeCorrigir({perfil:'gestor'}),false);
 assert.equal(correcao.podeCorrigir({perfil:PERFIL,permissoes:{}}),false);
 for(const k of ['dre','aprovar_ponto','usuarios','rh_documentos_visualizar_equipe'])assert.equal(PERMISSOES[k],undefined);
});
function fixture(falha=false){
 let feito=false;const sqls=[];const original={id:21,perfil:'gestor',permissoes:{existente:true},vinculo_id:30,loja_id:1,perfil_loja:'gestor',permissoes_loja:{exclusiva:true}};
 return {sqls,pool:{query:async()=>({rows:[]}),connect:async()=>({release(){},query:async(sql,p=[])=>{sqls.push({sql,p});if(sql.includes('SELECT u.id')){assert.match(sql,/lower\(u.email\)='dani@valinhos'/);assert.match(sql,/l.codigo='valinhos'/);assert.match(sql,/FOR UPDATE OF u,ul/);assert.match(sql,/NOT EXISTS/);return {rows:feito?[]:[original]};}if(sql.startsWith('UPDATE usuario_lojas')){assert.equal(p[0],21);assert.equal(p[1],1);assert.equal(p[4],30);assert.equal(JSON.parse(p[3]).exclusiva,true);if(falha)throw Error('falha banco');}if(sql.startsWith('UPDATE usuarios')){assert.equal(p[0],21);assert.equal(p[1],PERFIL);assert.equal(JSON.parse(p[2]).existente,true);}if(sql.includes('INSERT INTO usuario_perfil_migracoes')){assert.equal(JSON.parse(p[2]).perfil,'gestor');assert.equal(JSON.parse(p[3]).perfil,PERFIL);feito=true;}return {rows:[]};}})}};
}
test('migração restrita à Daniela/Valinhos mantém dados extras, guarda antes/depois e não reaplica',async()=>{const f=fixture();assert.equal(await migrarDaniela(f.pool),1);assert.equal(await migrarDaniela(f.pool),0);assert.equal(f.sqls.filter(x=>x.sql.startsWith('UPDATE usuarios')).length,1);assert.equal(f.sqls.filter(x=>x.sql==='COMMIT').length,2);});
test('falha em qualquer atualização reverte integralmente',async()=>{const f=fixture(true);await assert.rejects(()=>migrarDaniela(f.pool),/falha banco/);assert.ok(f.sqls.some(x=>x.sql==='ROLLBACK'));assert.ok(!f.sqls.some(x=>x.sql==='COMMIT'));});
test('autenticação do novo perfil não passa em rotas admin/DRE; aceita compras na loja ativa',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');const mod={exports:{}};let loja;
 vm.runInNewContext(fs.readFileSync(require.resolve('../middleware/auth'),'utf8'),{module:mod,exports:mod.exports,require:id=>id==='../lib/auth-token'?{verificarToken:()=>({id:21,lojaId:1,perfil:'gestor'})}:{executarNaLoja:async(id,f)=>{loja=id;return f();}}});
 const auth=mod.exports;auth.configurarPool({query:async()=>({rows:[{perfil:PERFIL,permissoes:PERMISSOES}]})});
 for(const [permitidos,esperado] of [['admin',403],[['admin','financeiro','contabil'],403],[['admin','gestor',PERFIL],200]]){
  const req={headers:{authorization:'Bearer teste'}};let next=false;const res={code:200,status(n){this.code=n;return this;},json(b){this.body=b;return this;}};
  await auth(permitidos)(req,res,()=>{next=true;});assert.equal(res.code,esperado);assert.equal(next,esperado===200);assert.equal(req.user.perfil,PERFIL);assert.equal(loja,1);
 }
});
