'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),audit=require('../lib/auditoria');
const esperar=()=>new Promise(r=>setImmediate(r));
async function evento({method='PUT',path='/api/fiado/pagamentos/7/correcao',status=200,user={id:2,nome:'Daniela',perfil:'gestor',lojaId:3},body={valor_pago:500,codigo:'123456',senha:'segredo',motivo:'Valor incorreto'},response={ok:true,data:{id:7}}}={}){
 const inserts=[];const pool={query:async(sql,p)=>{if(sql.includes('INSERT INTO auditoria_eventos'))inserts.push(p);return {rows:[]};}};
 const req={method,originalUrl:path,headers:{},body,params:{},user,ip:'127.0.0.1',auditoria:{antes:{valor_pago:970}}};let finish;
 const res={statusCode:status,json:()=>{},once:(nome,fn)=>finish=fn};audit.middleware(pool)(req,res,()=>{});res.json(response);finish?.();await esperar();await esperar();return inserts;
}
test('auditoria guarda ator, horário, loja, antes/depois, identificação e motivo sem credenciais',async()=>{
 const [p]=await evento();assert.equal(p[0],2);assert.equal(p[1],'Daniela');assert.equal(p[18],3);assert.equal(p[4],'CORRIGIR_PAGAMENTO');assert.equal(p[6],'7');assert.equal(JSON.parse(p[9]).valor_pago,970);const depois=JSON.parse(p[10]);assert.equal(depois.entrada.codigo,'[PROTEGIDO]');assert.equal(depois.entrada.senha,'[PROTEGIDO]');assert.equal(depois.entrada.valor_pago,500);assert.equal(p[11],'Valor incorreto');assert.match(p[14],/^[\da-f-]+$/);
});
test('login e logout têm ações claras; sessão de login fornece o autor',async()=>{
 const [p]=await evento({method:'POST',path:'/auth/login',user:null,response:{ok:true,usuario:{id:2,nome:'Daniela',perfil:'gestor',loja:{id:3}},token:'sensivel'}});assert.equal(p[4],'LOGIN');assert.equal(p[0],2);assert.equal(p[18],3);assert.equal(JSON.parse(p[10]).resposta.token,'[PROTEGIDO]');assert.equal(audit.acaoDoMetodo('POST','/auth/logout'),'LOGOUT');
});
test('acesso negado fica registrado sem incluir segredos da URL; leituras normais não enchem o log',async()=>{
 const [p]=await evento({method:'GET',path:'/api/dre?token=sensivel',status:403,response:{ok:false,erro:'Sem acesso'}});assert.equal(p[4],'ACESSO_NEGADO');assert.equal(p[7],'/api/dre');assert.equal(p[15],false);assert.equal((await evento({method:'GET'})).length,0);
 assert.equal((await evento({method:'POST',path:'/auth/heartbeat'})).length,0);
});
test('anônimo não é atribuído a uma loja arbitrária e reenvio é identificado',async()=>{assert.equal((await evento({user:null,response:{ok:false},status:401})).length,0);const [p]=await evento({response:{ok:true,repetido:true}});assert.equal(p[4],'REPETICAO_SEM_ALTERACAO');});
test('documento visualizado tem registro de acesso e IDs são preservados',async()=>{const [p]=await evento({method:'GET',path:'/api/rh/documentos/15/arquivo',response:null});assert.equal(p[4],'VISUALIZAR_DOCUMENTO');assert.equal(p[6],'15');});
test('consulta e histórico de logins exigem admin geral e filtram a loja com horários de Brasília',()=>{
 const s=fs.readFileSync('routes/auditoria.js','utf8');assert.match(s,/r.use\(autenticar\('admin'\),exigirAdminGlobal\(pool\)\)/);assert.match(s,/r.get\('\/acessos'/);assert.match(s,/const params=\[req.user.lojaId\],cond=\['s.loja_id=\$1'\]/);assert.match(s,/const conds = \['loja_id=\$1'\]/);assert.match(s,/AT TIME ZONE 'America\/Sao_Paulo'/);
 const h=fs.readFileSync('public/auditoria.html','utf8');assert.match(h,/Atividades e alterações/);assert.match(h,/Acessos e horários/);assert.match(h,/timeZone:'America\/Sao_Paulo'/);
});
