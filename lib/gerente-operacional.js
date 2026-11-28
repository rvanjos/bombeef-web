'use strict';
const PERFIL='gerente_operacional';
// Perfil novo: não altera o significado nem as permissões do gestor legado.
const PERMISSOES=Object.freeze(Object.fromEntries([
 'retiradas_visualizar_equipe','retiradas_lancar_equipe','retiradas_pagamentos','retiradas_pdv','retiradas_editar',
 'fiado_clientes','fiado_lancar','fiado_editar','fiado_cancelar','fiado_pagamentos','fiado_corrigir_pagamentos','fiado_pdv',
 'kits_gerenciar','rh_documentos_publicar'
].map(k=>[k,true])));
async function migrarDaniela(pool){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='10s'");
  await c.query("SET LOCAL statement_timeout='30s'");
  await c.query(`CREATE TABLE IF NOT EXISTS usuario_perfil_migracoes(
   chave TEXT NOT NULL,usuario_id INTEGER NOT NULL REFERENCES usuarios(id),loja_id INTEGER NOT NULL REFERENCES lojas(id),
   antes JSONB NOT NULL,depois JSONB NOT NULL,criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   motivo TEXT NOT NULL,PRIMARY KEY(chave,usuario_id,loja_id))`);
  // Identidade exata já conferida no cadastro; não seleciona por cargo/nome ou por perfil.
  const {rows}=await c.query(`SELECT u.id,u.perfil,u.permissoes,ul.id AS vinculo_id,ul.loja_id,
   ul.perfil AS perfil_loja,ul.permissoes AS permissoes_loja
   FROM usuarios u JOIN usuario_lojas ul ON ul.usuario_id=u.id JOIN lojas l ON l.id=ul.loja_id
   WHERE lower(u.email)='dani@valinhos' AND l.codigo='valinhos' AND u.ativo=true AND ul.ativo=true
   AND u.perfil='gestor' AND ul.perfil='gestor'
   AND NOT EXISTS(SELECT 1 FROM usuario_perfil_migracoes m WHERE m.chave='daniela-gerente-operacional-v1' AND m.usuario_id=u.id AND m.loja_id=ul.loja_id)
   FOR UPDATE OF u,ul`);
  for(const u of rows){
   const depois={perfil:PERFIL,permissoes:{...u.permissoes,...PERMISSOES},perfil_loja:PERFIL,permissoes_loja:{...u.permissoes_loja,...PERMISSOES}};
   await c.query(`UPDATE usuarios SET perfil=$2,permissoes=$3::jsonb,atualizado_em=NOW() WHERE id=$1 AND perfil='gestor'`,[u.id,PERFIL,JSON.stringify(depois.permissoes)]);
   await c.query(`UPDATE usuario_lojas SET perfil=$3,permissoes=$4::jsonb,atualizado_em=NOW() WHERE usuario_id=$1 AND loja_id=$2 AND id=$5 AND perfil='gestor'`,[u.id,u.loja_id,PERFIL,JSON.stringify(depois.permissoes_loja),u.vinculo_id]);
   await c.query(`INSERT INTO usuario_perfil_migracoes(chave,usuario_id,loja_id,antes,depois,motivo) VALUES('daniela-gerente-operacional-v1',$1,$2,$3::jsonb,$4::jsonb,$5)`,[u.id,u.loja_id,JSON.stringify(u),JSON.stringify(depois),'Separação do perfil da Daniela e liberação operacional solicitadas por Rafael em 28/11/2026; gestor legado preservado.']);
  }
  await c.query('COMMIT');
  for(const u of rows)await require('./auditoria').registrar(pool,{modulo:'acessos',acao:'ALTERAR_PERFIL_OPERACIONAL',entidade:'usuarios',entidade_id:u.id,usuario_nome:'Sistema — solicitação de Rafael',loja_id:u.loja_id,dados_antes:u,dados_depois:{perfil:PERFIL,permissoes:PERMISSOES},justificativa:'Separação do perfil da Daniela; gestor legado preservado. Snapshot completo em usuario_perfil_migracoes.'});
  return rows.length;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={PERFIL,PERMISSOES,migrarDaniela};
