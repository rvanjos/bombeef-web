'use strict';
function validarPeriodo(body){
  const valido=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
  if(!['ferias','afastamento','licenca','atestado','outro'].includes(body.tipo)||!valido(body.data_inicio)||!valido(body.data_fim)||body.data_fim<body.data_inicio)throw Error('Confira o tipo e as datas: o fim deve ser igual ou posterior ao início.');
  return {tipo:body.tipo,data_inicio:body.data_inicio,data_fim:body.data_fim,motivo:String(body.motivo||'').trim()||null,observacao:String(body.observacao||'').trim()||null};
}
async function editarAusencia(pool,user,id,body){
  const p=validarPeriodo(body),versao=Number(body.versao),justificativa=String(body.justificativa||'').trim();
  if(!Number.isInteger(versao)||versao<0||!['ativo','cancelado'].includes(body.status)||!justificativa)throw Error('Informe o motivo da alteração e recarregue o período antes de editar.');
  const depois={...p,status:body.status};
  const {rows}=await pool.query(`UPDATE ponto_ausencias AS a SET tipo=$1,data_inicio=$2,data_fim=$3,motivo=$4,observacao=$5,status=$6,
    versao=a.versao+1,historico_edicoes=a.historico_edicoes||jsonb_build_array(jsonb_build_object(
      'acao','EDITAR','antes',to_jsonb(a)-'historico_edicoes','depois',$7::jsonb,'justificativa',$8::text,'usuario_id',$9::integer,'em',NOW()))
    WHERE a.id=$10 AND a.loja_id=$11 AND a.versao=$12 RETURNING *`,
  [p.tipo,p.data_inicio,p.data_fim,p.motivo,p.observacao,body.status,JSON.stringify(depois),justificativa,user.id,id,user.lojaId,versao]);
  if(!rows.length){const e=Error('O período mudou ou não está disponível nesta loja. Recarregue antes de salvar.');e.status=409;throw e;}
  return rows[0];
}
module.exports={validarPeriodo,editarAusencia};
