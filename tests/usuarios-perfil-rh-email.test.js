'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const P=require('../lib/usuarios-perfil'),M=require('../lib/rh-email-avisos');
test('perfil próprio não aceita alteração de papel, loja nem confirmação de e-mail',()=>{
 assert.deepEqual(P.dadosPerfil({perfil:'admin',permissoes:{rh_documentos_publicar:true},loja_id:2,email_confirmado_em:'hoje',telefone:' 19 9999 ',email_notificacoes:'TESTE@example.com',avisos_email:true}),{telefone:'19 9999',email_notificacoes:'teste@example.com',avisos_email:true});
 for(const b of [{email_notificacoes:'erro'},{avisos_email:'true'},{telefone:'a'.repeat(31)}])assert.throws(()=>P.dadosPerfil(b));
});
test('trocar e-mail de avisos invalida a confirmação sem mudar login e vínculo RH',async()=>{
 let sql,params;await P.salvarPerfil({query:async(s,p)=>{sql=s;params=p}},5,{email_notificacoes:'nova@example.com',cargo:'Gerente'});
 assert.match(sql,/email_confirmado_em=CASE WHEN email_notificacoes IS DISTINCT/);assert.match(sql,/WHERE id=\$3/);assert.doesNotMatch(sql,/SET email =|UPDATE funcionarios|perfil=/);assert.equal(params.at(-1),5);
});
test('aviso individual resolve somente titular ativo, confirmado e vinculado na loja',async()=>{
 let sql,params;const r=await M.enfileirar({query:async(s,p)=>{sql=s;params=p;return {rows:[{id:1}]}}},{id:8,funcionario_id:13},2);
 assert.match(sql,/ul.loja_id=\$1/);assert.match(sql,/f.loja_id=\$1/);assert.match(sql,/email_confirmado_em IS NOT NULL/);assert.match(sql,/f.id=\$3/);assert.match(sql,/ON CONFLICT\(documento_id,usuario_id\) DO NOTHING/);assert.deepEqual(params,[2,8,13]);assert.equal(r.enfileirados,1);
});
test('destinatário removido ou e-mail alterado cancela o envio antes do provedor',async()=>{
 const old=[process.env.RESEND_API_KEY,process.env.EMAIL_FROM];process.env.RESEND_API_KEY='fixture';process.env.EMAIL_FROM='fixture@example.com';const qs=[];
 try{const pool={query:async(s,p)=>{qs.push([s,p]);if(s.startsWith('UPDATE rh_email_avisos a'))return {rows:[{id:1,loja_id:2,usuario_id:3,documento_id:4,email_destino:'fixture@example.com'}]};return {rows:[]};}};const r=await M.processar(pool,2);assert.equal(r.enviados,0);assert.match(qs[0][0],/FOR UPDATE SKIP LOCKED/);assert.match(qs[1][0],/d.loja_id=\$2/);assert.match(qs[1][0],/f.id=d.funcionario_id/);assert.match(qs.at(-1)[0],/status='cancelado'/);}finally{for(const [i,k] of ['RESEND_API_KEY','EMAIL_FROM'].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];}}
});
test('envio sem configuração não consulta banco nem informa sucesso falso',async()=>{
 const key=process.env.RESEND_API_KEY;delete process.env.RESEND_API_KEY;try{assert.equal((await M.processar({query:()=>assert.fail('não deve consultar')})).configurado,false);await assert.rejects(M.enviar('fixture@example.com',{}),/EMAIL_NAO_CONFIGURADO/);}finally{if(key!==undefined)process.env.RESEND_API_KEY=key;}
});
test('provedor usa aviso sem documento, sem cc e com idempotência',async()=>{
 const old=[process.env.RESEND_API_KEY,process.env.EMAIL_FROM];process.env.RESEND_API_KEY='fixture';process.env.EMAIL_FROM='fixture@example.com';try{await M.enviar('dest@example.com',{assunto:'Aviso',texto:'Entre no portal',chave:'doc-1'},async(url,args)=>{assert.equal(url,'https://api.resend.com/emails');const b=JSON.parse(args.body);assert.deepEqual(b.to,['dest@example.com']);assert.equal(b.attachments,undefined);assert.equal(b.cc,undefined);assert.equal(args.headers['Idempotency-Key'],'doc-1');return {ok:true};});}finally{for(const [i,k] of ['RESEND_API_KEY','EMAIL_FROM'].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];}}
});
test('permissão de publicação não concede leitura dos documentos dos outros',()=>{
 const s=fs.readFileSync('routes/rh.js','utf8');const from=s.indexOf('  function gestorRH'),to=s.indexOf('  // BB-SSE',from);const ctx={};vm.createContext(ctx);vm.runInContext(s.slice(from,to),ctx);
 const gerente={user:{perfil:'gestor',permissoes:{rh_documentos_publicar:true}}};assert.equal(ctx.podePublicarDocumento(gerente),true);assert.equal(ctx.gestorRH(gerente),false);assert.equal(ctx.podePublicarDocumento({user:{perfil:'caixa',permissoes:{rh_documentos_publicar:true}}}),false);
 assert.match(s,/Number\(proprio\.id\)!==Number\(doc\.funcionario_id\)/);
 const ponto=fs.readFileSync('routes/ponto.js','utf8');assert.match(ponto,/req\.user\?\.perfil !== 'admin'/);
 const dre=fs.readFileSync('routes/dre.js','utf8');assert.match(dre,/r.use\(autenticar\(\['admin','financeiro','contabil'\]\)\)/);
});
test('código de confirmação tem limite de tentativas, expiração e envio com intervalo',()=>{
 const s=fs.readFileSync('lib/usuarios-perfil-rotas.js','utf8');assert.match(s,/email_codigo_tentativas<5/);assert.match(s,/email_codigo_expira>NOW\(\)/);assert.match(s,/INTERVAL '1 minute'/);assert.match(s,/exigirAdminGlobal\(pool\)/);assert.notEqual(P.hashCodigo(1,'a@example.com','123456'),P.hashCodigo(2,'a@example.com','123456'));
});
