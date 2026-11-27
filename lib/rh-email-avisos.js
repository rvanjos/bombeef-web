'use strict';
const {executarComoSistema}=require('./tenant-context');
const configurado=()=>!!(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM);
async function enviar(email,{assunto,texto,chave},fetcher=fetch){
 if(!configurado())throw Error('EMAIL_NAO_CONFIGURADO');
 const r=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json',...(chave?{'Idempotency-Key':chave}:{})},signal:AbortSignal.timeout(12000),body:JSON.stringify({from:process.env.EMAIL_FROM,to:[email],subject:assunto,text:texto})});
 if(!r.ok)throw Error('PROVEDOR_HTTP_'+r.status);return true;
}
async function enfileirar(pool,doc,lojaId){
 // Resolve destinatários no servidor pela loja e pelo vínculo RH; nunca pelo formulário.
 const {rows}=await pool.query(`INSERT INTO rh_email_avisos(loja_id,documento_id,usuario_id,email_destino)
 SELECT $1,$2,u.id,u.email_notificacoes FROM usuarios u
 JOIN usuario_lojas ul ON ul.usuario_id=u.id AND ul.loja_id=$1 AND ul.ativo=true
 WHERE u.ativo=true AND u.avisos_email=true AND u.email_confirmado_em IS NOT NULL AND u.email_notificacoes IS NOT NULL
 AND EXISTS(SELECT 1 FROM funcionarios f WHERE f.loja_id=$1 AND f.ativo=true AND COALESCE(f.freelancer,false)=false
 AND (f.usuario_id=u.id OR (f.usuario_id IS NULL AND LOWER(f.email)=LOWER(u.email))) AND ($3::integer IS NULL OR f.id=$3))
 ON CONFLICT(documento_id,usuario_id) DO NOTHING RETURNING id`,[lojaId,doc.id,doc.funcionario_id]);
 return {enfileirados:rows.length,servico_configurado:configurado()};
}
async function processar(pool,lojaId=null){
 if(!configurado())return {enviados:0,configurado:false};
 const {rows}=await pool.query(`UPDATE rh_email_avisos a SET status='enviando',atualizado_em=NOW(),tentativas=a.tentativas+1
 FROM (SELECT id FROM rh_email_avisos WHERE ($1::integer IS NULL OR loja_id=$1) AND tentativas<5
 AND (status='pendente' OR (status IN ('falha','enviando') AND atualizado_em<NOW()-INTERVAL '15 minutes'))
 ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED) fila WHERE a.id=fila.id RETURNING a.*`,[lojaId]);
 let enviados=0;
 for(const a of rows){
  try{
   const {rows:validos}=await pool.query(`SELECT u.id FROM usuarios u JOIN usuario_lojas ul ON ul.usuario_id=u.id AND ul.loja_id=$2 AND ul.ativo=true
   JOIN rh_documentos_funcionario d ON d.id=$3 AND d.loja_id=$2 AND d.status='ativo'
   WHERE u.id=$1 AND u.ativo=true AND u.avisos_email=true AND u.email_confirmado_em IS NOT NULL AND u.email_notificacoes=$4
   AND EXISTS(SELECT 1 FROM funcionarios f WHERE f.loja_id=$2 AND f.ativo=true AND COALESCE(f.freelancer,false)=false
    AND (f.usuario_id=u.id OR (f.usuario_id IS NULL AND LOWER(f.email)=LOWER(u.email))) AND (d.funcionario_id IS NULL OR f.id=d.funcionario_id))`,[a.usuario_id,a.loja_id,a.documento_id,a.email_destino]);
   if(!validos.length){await pool.query(`UPDATE rh_email_avisos SET status='cancelado',atualizado_em=NOW(),erro='DESTINATARIO_INDISPONIVEL' WHERE id=$1 AND loja_id=$2`,[a.id,a.loja_id]);continue;}
   await enviar(a.email_destino,{assunto:'Bom Beef — Novo documento no RH',texto:'Um novo documento está disponível para você no portal do RH. Entre no sistema com seu usuário e acesse RH > Documentos para visualizar e confirmar o recebimento, quando solicitado.\n\nhttps://bombeef-web-production.up.railway.app\n\nEste aviso não confirma o recebimento do documento.',chave:'rh-doc-'+a.documento_id+'-usuario-'+a.usuario_id});
   await pool.query(`UPDATE rh_email_avisos SET status='enviado',enviado_em=NOW(),atualizado_em=NOW(),erro=NULL WHERE id=$1 AND loja_id=$2`,[a.id,a.loja_id]);enviados++;
  }catch(e){await pool.query(`UPDATE rh_email_avisos SET status='falha',atualizado_em=NOW(),erro=$3 WHERE id=$1 AND loja_id=$2`,[a.id,a.loja_id,/^PROVEDOR_HTTP_\d+$/.test(e.message)?e.message:'FALHA_ENVIO']);}
 }
 return {enviados,configurado:true};
}
let iniciado=false;
function iniciar(pool){if(iniciado)return;iniciado=true;const rodar=()=>executarComoSistema(()=>processar(pool)).catch(()=>console.warn('[rh-email] fila indisponível; nova tentativa programada'));const timer=setInterval(rodar,60000);timer.unref();}
module.exports={configurado,enviar,enfileirar,processar,iniciar};
