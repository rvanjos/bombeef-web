'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),jwt=require('jsonwebtoken');
const autenticar=require('../middleware/auth');
process.env.JWT_SECRET='segredo-apenas-fixtures-multiloja';
const payload={id:7,nome:'Admin',perfil:'admin',lojaId:2,vinculoLojaId:9,sessaoId:11};
async function executar(rows,perfil='admin'){
 let consulta,proximo=false;autenticar.configurarPool({query:async(s,p)=>{consulta={s,p};return {rows};}});
 const req={headers:{authorization:'Bearer '+jwt.sign(payload,process.env.JWT_SECRET)}};
 const res={status(n){this.code=n;return this},json(d){this.body=d;return this}};
 await autenticar(perfil)(req,res,()=>{proximo=true;});return {req,res,consulta,proximo};
}
test('perfil e permissões são os do vínculo atual, não os antigos do token',async()=>{
 const r=await executar([{perfil:'gestor',permissoes:{retiradas_pdv:true}}],'gestor');assert.equal(r.proximo,true);assert.equal(r.req.user.perfil,'gestor');assert.equal(r.req.user.permissoes.retiradas_pdv,true);assert.deepEqual(r.consulta.p,[7,2,9,11]);
});
test('revogação do vínculo, usuário ou sessão impede uso do token antigo',async()=>{
 const r=await executar([]);assert.equal(r.proximo,false);assert.equal(r.res.code,401);assert.match(r.consulta.s,/u\.ativo=true/);assert.match(r.consulta.s,/ul\.ativo=true/);assert.match(r.consulta.s,/l\.pronta_operacao=true/);assert.match(r.consulta.s,/s\.loja_id=l\.id/);assert.match(r.consulta.s,/s\.encerrado_em IS NULL/);
});
test('rebaixamento de perfil remove imediatamente permissão administrativa',async()=>{const r=await executar([{perfil:'caixa'}]);assert.equal(r.res.code,403);assert.equal(r.proximo,false);});
test('falha de banco não libera autenticação por token apenas',async()=>{
 autenticar.configurarPool({query:async()=>{throw Error('indisponível')}});const req={headers:{authorization:'Bearer '+jwt.sign(payload,process.env.JWT_SECRET)}};const res={status(n){this.code=n;return this},json(d){this.body=d}};await autenticar()(req,res,()=>assert.fail('não deve liberar'));assert.equal(res.code,503);
});
