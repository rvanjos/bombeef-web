'use strict';
function centavos(valor) {
  if (valor === null || valor === '' || typeof valor === 'boolean') return NaN;
  const n = Number(valor);
  const c = Math.round((n + Number.EPSILON) * 100);
  return Number.isFinite(n) && Number.isSafeInteger(c) ? c : NaN;
}
function distribuirPagamento(valor, vendas) {
  let restante = valor;
  const abatidas = [];
  for (const v of vendas) {
    const saldo = centavos(v.saldo_restante);
    if (!Number.isSafeInteger(saldo) || saldo < 0) throw new Error('Saldo inválido');
    const abatido = Math.min(restante,saldo);
    if (abatido > 0) abatidas.push({id:v.id,abatido,saldo:saldo-abatido});
    restante -= abatido;
    if (restante === 0) break;
  }
  return {vendas:abatidas,aplicado:valor-restante,credito:restante};
}
module.exports = {centavos,distribuirPagamento};
