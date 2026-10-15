const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const rota = fs.readFileSync(require('node:path').join(__dirname, '../routes/ponto.js'), 'utf8');
const trecho = rota.slice(rota.indexOf('  function calcularExtraMinutos('), rota.indexOf('  function calcularIntervaloSuprimido('));
const calcular = vm.runInNewContext(trecho + '\ncalcularExtraMinutos');
for (const [minutos, esperado] of [[-20,0],[0,0],[5,0],[10,0],[14,0],[15,0],[16,16],[30,30],[60,60]]) {
  test(`jornada de 8h com saldo ${minutos}min apura ${esperado}min extra`, () => {
    assert.equal(calcular(8 + minutos/60, 8), esperado);
  });
}
test('jornada curta, folga e troca de folga respeitam o limite', () => {
  assert.equal(calcular(4.25,4),0);
  assert.equal(calcular(4+16/60,4),16);
  assert.equal(calcular(15/60,0),0);
  assert.equal(calcular(16/60,0),16);
  assert.equal(calcular(10,8,true),0);
  assert.equal(calcular(null,8),0);
});
test('scripts inline de RH e Ponto compilam', () => {
  for(const arquivo of ['public/ponto.html','public/rh.html']) {
    const html=fs.readFileSync(require('node:path').join(__dirname,'..',arquivo),'utf8');
    for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if(m[1].trim()) new vm.Script(m[1],{filename:arquivo});
    }
  }
});
