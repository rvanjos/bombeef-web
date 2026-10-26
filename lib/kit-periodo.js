'use strict';
function validarPeriodo(inicio, fim) {
  for (const data of [inicio, fim]) {
    if (data == null || data === '') continue;
    if (typeof data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data) ||
        !Number.isFinite(Date.parse(data)) || new Date(data).toISOString().slice(0,10) !== data)
      return 'Informe datas válidas para o período do kit.';
  }
  if (inicio && fim && inicio > fim) return 'A data de fim deve ser igual ou posterior à data de início.';
  return null;
}
module.exports = { validarPeriodo };
