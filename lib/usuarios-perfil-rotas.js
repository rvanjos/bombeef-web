'use strict';
const crypto=require('node:crypto'),autenticar=require('../middleware/auth');
const {salvarPerfil,hashCodigo}=require('./usuarios-perfil'),mail=require('./rh-email-avisos');
const {exigirAdminGlobal}=require('./admin-global');
function instalar(r,pool,pronto){
 const ler=async id=>(await pool.query(`SELECT id,nome,email,telefone,cargo,departamento,nome_social,email_notificacoes,email_confirmado_em,avisos_email FROM usuarios WHERE id=$1`,[id])).rows[0];
 r.get('/perfil',autenticar(),async(req,res)=>{try{await pronto();res.json({ok:true,data:await ler(req.user.id),email_configurado:mail.configurado()});}catch(_){res.status(503).json({ok:false,erro:'Não foi possível consultar seu perfil'});}});
 r.put('/perfil',autenticar(),async(req,res)=>{try{await pronto();await salvarPerfil(pool,req.user.id,req.body);res.json({ok:true,data:await ler(req.user.id)});}catch(_){res.status(400).json({ok:false,erro:'Confira o e-mail e os dados do cadastro'});}});
 r.post('/perfil/email/codigo',autenticar(),async(req,res)=>{
  if(!mail.configurado())return res.status(503).json({ok:false,erro:'O administrador precisa configurar o envio de e-mails. Seus dados podem ser salvos normalmente.'});
  try{
   await pronto();const u=await ler(req.user.id);if(!u.email_notificacoes)return res.status(400).json({ok:false,erro:'Cadastre seu e-mail de avisos primeiro'});
   const codigo=String(crypto.randomInt(100000,1000000)),hash=hashCodigo(u.id,u.email_notificacoes,codigo);
   const {rows}=await pool.query(`UPDATE usuarios SET email_codigo_hash=$2,email_codigo_expira=NOW()+INTERVAL '15 minutes',email_codigo_tentativas=0,email_codigo_enviado_em=NOW() WHERE id=$1 AND email_notificacoes=$3 AND (email_codigo_enviado_em IS NULL OR email_codigo_enviado_em<NOW()-INTERVAL '1 minute') RETURNING id`,[u.id,hash,u.email_notificacoes]);
   if(!rows.length)return res.status(429).json({ok:false,erro:'Aguarde um minuto para solicitar outro código'});
   await mail.enviar(u.email_notificacoes,{assunto:'Bom Beef — Confirme seu e-mail',texto:'Seu código de confirmação do e-mail de avisos é '+codigo+'. Ele vale por 15 minutos. Se você não solicitou, ignore esta mensagem.'});
   res.json({ok:true});
  }catch(_){res.status(502).json({ok:false,erro:'Não foi possível enviar o código. Tente novamente em um minuto.'});}
 });
 r.post('/perfil/email/confirmar',autenticar(),async(req,res)=>{
  if(!/^\d{6}$/.test(String(req.body.codigo||'')))return res.status(400).json({ok:false,erro:'Informe o código de 6 dígitos'});
  try{
   const {rows:[u]}=await pool.query(`UPDATE usuarios SET email_codigo_tentativas=email_codigo_tentativas+1 WHERE id=$1 AND email_codigo_hash IS NOT NULL AND email_codigo_expira>NOW() AND email_codigo_tentativas<5 RETURNING email_notificacoes,email_codigo_hash`,[req.user.id]);
   if(!u||u.email_codigo_hash!==hashCodigo(req.user.id,u.email_notificacoes,String(req.body.codigo)))return res.status(400).json({ok:false,erro:'Código inválido ou expirado. Solicite outro código.'});
   const {rowCount}=await pool.query(`UPDATE usuarios SET email_confirmado_em=NOW(),email_codigo_hash=NULL,email_codigo_expira=NULL WHERE id=$1 AND email_notificacoes=$2 AND email_codigo_hash=$3 AND email_codigo_expira>NOW()`,[req.user.id,u.email_notificacoes,u.email_codigo_hash]);
   if(!rowCount)return res.status(409).json({ok:false,erro:'Seu e-mail foi alterado. Solicite outro código.'});
   res.json({ok:true});
  }catch(_){res.status(500).json({ok:false,erro:'Não foi possível confirmar o e-mail'});}
 });
 r.get('/perfil/avisos/status',autenticar('admin'),exigirAdminGlobal(pool),async(req,res)=>{
  try{const {rows}=await pool.query(`SELECT status,COUNT(*)::integer AS quantidade FROM rh_email_avisos WHERE loja_id=$1 GROUP BY status`,[req.user.lojaId]);res.json({ok:true,configurado:mail.configurado(),data:rows});}catch(_){res.status(503).json({ok:false,erro:'Fila indisponível'});}
 });
 r.post('/perfil/avisos/reprocessar',autenticar('admin'),exigirAdminGlobal(pool),async(req,res)=>{
  if(!mail.configurado())return res.status(503).json({ok:false,erro:'Configure RESEND_API_KEY e EMAIL_FROM no servidor'});
  try{await pool.query(`UPDATE rh_email_avisos SET status='pendente',tentativas=0 WHERE loja_id=$1 AND status='falha'`,[req.user.lojaId]);res.json({ok:true,...await mail.processar(pool,req.user.lojaId)});}catch(_){res.status(503).json({ok:false,erro:'Não foi possível reprocessar os avisos'});}
 });
}
module.exports={instalar};
