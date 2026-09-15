'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { linhaTransacao, numBR, dataISO } = require('../lib/cartao-itau-pdf-v1');

assert.equal(numBR('10.404, 47'), 10404.47);
assert.equal(numBR('- 20,50'), -20.50);
assert.equal(dataISO('26/04','08/2026'),'2026-04-26');

assert.deepEqual(linhaTransacao('07/07 PORTO SEGURO SEGUROS 752,33'),{data:'07/07',descricao:'PORTO SEGURO SEGUROS',valor:752.33});
assert.deepEqual(linhaTransacao('05/08 ESTORNO ANUIDADE 10/12 - 20,50'),{data:'05/08',descricao:'ESTORNO ANUIDADE 10/12',valor:-20.50});
assert.equal(linhaTransacao('22/07 PAGAMENTO DEB AUTOMATIC -10.817,37'),null);
assert.equal(linhaTransacao('Lançamentos no cartão 1.630,96'),null);

const route = fs.readFileSync(path.join(__dirname,'../routes/agente_financeiro_cartao_v3.js'),'utf8');
assert.match(route,/interpretarItauPdfV1/);
assert.match(route,/interpretarPorBanco/);
assert.match(route,/interpretarCaixaPdfV3, interpretarItauPdfV1/);
assert.match(route,/urn:ietf:params:oauth:grant-type:jwt-bearer/);

console.log('cartao-itau-pdf-v1.test.js: OK');
