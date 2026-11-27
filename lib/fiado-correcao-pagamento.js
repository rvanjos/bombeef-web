'use strict';
const {centavos,distribuirPagamento}=require('./fiado-pagamento');
const erro=(status,msg)=>Object.assign(new Error(msg),{status});
const podeCorrigir=u=>u?.perfil==='admin'||(u?.perfil==='gestor'&&u?.permissoes?.fiado_corrigir_pagamentos===true);
function validar(b){
 const valor=centavos(b.valor_pago),versao=Number(b.versao);
 if(!Number.isSafeInteger(valor)||valor<0||valor>999999999999||!Number.isSafeInteger(versao)||versao<0||b.versao==null)throw erro(400,'Informe valor válido e versão do pagamento.');
 if(!['dinheiro','pix','debito','credito','transferencia','outro','saldo_cliente'].includes(b.forma_pagamento))throw erro(400,'Forma de pagamento inválida.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(b.data_pagamento||'')||!Number.isFinite(Date.parse(b.data_pagamento))||new Date(b.data_pagamento).toISOString().slice(0,10)!==b.data_pagamento)throw erro(400,'Data inválida.');
 const motivo=typeof b.motivo==='string'?b.motivo.trim():'';if(motivo.length<5||motivo.length>1000)throw erro(400,'Informe o motivo da correção (5 a 1.000 caracteres).');
 if(typeof b.idempotencia!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(b.idempotencia))throw erro(400,'Identificador da correção inválido.');
 if(b.venda_id!=null&&(!Number.isSafeInteger(Number(b.venda_id))||Number(b.venda_id)<=0))throw erro(400,'Venda selecionada inválida.');
 if(typeof b.observacoes!=='string'||b.observacoes.length>3000)throw erro(400,'Observação inválida.');
 return {valor,versao,motivo};
}
function planejar(pag,cliente,vendas,rateios,b){
 const {valor}=validar(b),origem=centavos(pag.valor_pago)+centavos(pag.credito_utilizado),abatido=rateios.reduce((s,v)=>s+centavos(v.valor_abatido),0);
 if(abatido+centavos(pag.credito_gerado)!==origem)throw erro(409,'Este pagamento antigo não tem rateio completo. É necessária conferência antes da correção.');
 const devolvidos=new Map();for(const r of rateios){const k=Number(r.venda_id);devolvidos.set(k,(devolvidos.get(k)||0)+centavos(r.valor_abatido));}
 const restauradas=vendas.map(v=>{
  const volta=devolvidos.get(Number(v.id))||0;
  if(volta&&!['aberto','parcial','pago'].includes(v.status))throw erro(409,'Uma venda deste pagamento foi cancelada ou alterada. Confira seu histórico.');
  const saldo=centavos(v.saldo_restante)+volta;
  if(!Number.isSafeInteger(saldo)||saldo<0||saldo>centavos(v.total_final))throw erro(409,'Os saldos das vendas precisam de conferência.');
  return {...v,saldo_restante:saldo/100};
 });
 if([...devolvidos.keys()].some(id=>!vendas.some(v=>Number(v.id)===id)))throw erro(409,'Uma venda vinculada não foi encontrada nesta loja.');
 const alvo=restauradas.filter(v=>['aberto','parcial','pago'].includes(v.status)&&(!b.venda_id||Number(v.id)===Number(b.venda_id))&&centavos(v.saldo_restante)>0);
 if(b.venda_id&&!restauradas.some(v=>Number(v.id)===Number(b.venda_id)&&['aberto','parcial','pago'].includes(v.status)))throw erro(409,'Venda indisponível para este cliente.');
 const plano=distribuirPagamento(valor,alvo),usarCredito=b.forma_pagamento==='saldo_cliente';
 if(usarCredito&&plano.credito)throw erro(409,'O uso de crédito não pode exceder as dívidas selecionadas.');
 const gerado=usarCredito?0:plano.credito,utilizado=usarCredito?valor:0;
 const credito=centavos(cliente.credito_saldo)-centavos(pag.credito_gerado)+centavos(pag.credito_utilizado)+gerado-utilizado;
 if(!Number.isSafeInteger(credito))throw erro(409,'O saldo de crédito precisa de conferência.');
 if(credito<0)throw erro(409,'O crédito gerado por esse pagamento já foi utilizado. Corrija os usos de crédito antes de reduzir este valor.');
 const pagos=new Map(plano.vendas.map(v=>[Number(v.id),v]));
 return {plano,credito,gerado,utilizado,recebido:usarCredito?0:valor,vendas:restauradas.filter(v=>devolvidos.has(Number(v.id))||pagos.has(Number(v.id))).map(v=>{
  const saldo=pagos.get(Number(v.id))?.saldo??centavos(v.saldo_restante);return {id:v.id,saldo,status:saldo===0?'pago':saldo===centavos(v.total_final)?'aberto':'parcial'};
 })};
}
async function corrigir(pool,id,loja,user,b){
 if(!podeCorrigir(user))throw erro(403,'Sem permissão para corrigir pagamentos.');
 const {versao,motivo}=validar(b),client=await pool.connect();
 const requisicao={id:Number(id),valor_pago:centavos(b.valor_pago),data_pagamento:b.data_pagamento,forma_pagamento:b.forma_pagamento,observacoes:b.observacoes,motivo,venda_id:Number(b.venda_id)||null,versao};
 try{
  await client.query('BEGIN');
  const {rows:[ref]}=await client.query(`SELECT cliente_id FROM pagamentos_fiado WHERE id=$1 AND loja_id=$2`,[id,loja]);if(!ref)throw erro(404,'Pagamento não encontrado nesta loja.');
  const {rows:[cliente]}=await client.query(`SELECT * FROM clientes_fiado WHERE id=$1 AND loja_id=$2 AND tipo_cliente<>'funcionario' FOR UPDATE`,[ref.cliente_id,loja]);if(!cliente)throw erro(404,'Cliente não encontrado nesta loja.');
  const {rows:[repetida]}=await client.query(`SELECT requisicao,depois FROM fiado_pagamento_revisoes WHERE loja_id=$1 AND idempotencia=$2`,[loja,b.idempotencia]);
  if(repetida){if(JSON.stringify(repetida.requisicao)!==JSON.stringify(requisicao)){
    const iguais=Object.keys(requisicao).every(k=>repetida.requisicao?.[k]===requisicao[k]);if(!iguais)throw erro(409,'Identificador já utilizado para outra correção.');
   }await client.query('ROLLBACK');return {...repetida.depois,repetido:true};}
  const {rows:[pag]}=await client.query(`SELECT * FROM pagamentos_fiado WHERE id=$1 AND loja_id=$2 FOR UPDATE`,[id,loja]);
  if(Number(pag.cliente_id)!==Number(cliente.id))throw erro(409,'O vínculo do cliente mudou. Reabra a correção.');
  if(Number(pag.versao)!==versao)throw erro(409,'Este pagamento foi alterado. Atualize a tela antes de corrigir.');
  const {rows:vendas}=await client.query(`SELECT * FROM vendas_fiado WHERE cliente_id=$1 AND loja_id=$2 ORDER BY data_compra,id FOR UPDATE`,[pag.cliente_id,loja]);
  if(b.saldo_esperado==null||b.credito_esperado==null||centavos(b.saldo_esperado)!==vendas.filter(v=>['aberto','parcial'].includes(v.status)).reduce((s,v)=>s+centavos(v.saldo_restante),0)||centavos(b.credito_esperado)!==centavos(cliente.credito_saldo))throw erro(409,'O saldo do cliente mudou. Reabra a correção para conferir os valores atuais.');
  const {rows:rateios}=await client.query(`SELECT venda_id,valor_abatido FROM pagamento_venda_fiado WHERE pagamento_id=$1 AND loja_id=$2 AND revisao=$3 ORDER BY id`,[id,loja,versao]);
  const p=planejar(pag,cliente,vendas,rateios,b),novaVersao=versao+1;
  for(const v of p.vendas)await client.query(`UPDATE vendas_fiado SET saldo_restante=$1,status=$2,updated_at=NOW() WHERE id=$3 AND loja_id=$4`,[v.saldo/100,v.status,v.id,loja]);
  for(const v of p.plano.vendas)await client.query(`INSERT INTO pagamento_venda_fiado(pagamento_id,venda_id,valor_abatido,loja_id,revisao) VALUES($1,$2,$3,$4,$5)`,[id,v.id,v.abatido/100,loja,novaVersao]);
  await client.query(`UPDATE clientes_fiado SET credito_saldo=$1,updated_at=NOW() WHERE id=$2 AND loja_id=$3`,[p.credito/100,cliente.id,loja]);
  const {rows:[novo]}=await client.query(`UPDATE pagamentos_fiado SET valor_pago=$1,credito_gerado=$2,credito_utilizado=$3,data_pagamento=$4,forma_pagamento=$5,observacoes=$6,versao=$7 WHERE id=$8 AND loja_id=$9 RETURNING *`,[p.recebido/100,p.gerado/100,p.utilizado/100,b.data_pagamento,b.forma_pagamento,b.observacoes,novaVersao,id,loja]);
  const depois={data:novo,credito_saldo:p.credito/100,valor_aplicado:p.plano.aplicado/100,vendas_abatidas:p.plano.vendas.map(v=>({venda_id:v.id,valor_abatido:v.abatido/100}))};
  await client.query(`INSERT INTO fiado_pagamento_revisoes(pagamento_id,loja_id,versao,idempotencia,requisicao,antes,depois,motivo,usuario_id,usuario_nome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,loja,novaVersao,b.idempotencia,JSON.stringify(requisicao),JSON.stringify({pagamento:pag,rateios,credito_saldo:cliente.credito_saldo,vendas:vendas.map(v=>({id:v.id,saldo_restante:v.saldo_restante,status:v.status}))}),JSON.stringify(depois),motivo,user.id,user.nome]);
  await client.query(`INSERT INTO historico_fiado(cliente_id,pagamento_id,tipo_evento,descricao,usuario,loja_id) VALUES($1,$2,'pagamento_corrigido',$3,$4,$5)`,[pag.cliente_id,id,`Correção #${novaVersao}: recebido de R$ ${Number(pag.valor_pago).toFixed(2)} para R$ ${(p.recebido/100).toFixed(2)}; aplicado R$ ${(p.plano.aplicado/100).toFixed(2)}; crédito gerado R$ ${(p.gerado/100).toFixed(2)}; crédito utilizado R$ ${(p.utilizado/100).toFixed(2)}. Motivo: ${motivo}`,user.nome,loja]);
  await client.query('COMMIT');return {...depois,auditoria_antes:{pagamento:pag,rateios,credito_saldo:cliente.credito_saldo}};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={podeCorrigir,validar,planejar,corrigir};
