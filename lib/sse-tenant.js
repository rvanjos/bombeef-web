'use strict';
const { lojaAtual } = require('./tenant-context');

function chaveSSE(lojaId, canal) {
  const id=Number(lojaId);
  if(!Number.isSafeInteger(id)||id<=0||typeof canal!=='string'||!/^[a-z][a-z0-9_-]{0,49}$/i.test(canal))return null;
  return `${id}:${canal}`;
}
function publicarSSE(clientes, canal, dados) {
  const chave=chaveSSE(lojaAtual(),canal);
  if(!chave)return; // Nunca publicar globalmente sem contexto explícito de loja.
  const set=clientes.get(chave);
  if(!set)return;
  const payload='data: '+JSON.stringify(dados)+'\n\n';
  for(const res of set){try{res.write(payload);}catch(_){set.delete(res);}}
}
module.exports={chaveSSE,publicarSSE};
