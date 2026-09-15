const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { montarSequencial } = require('../lib/pdf-layout-extractor');

const root = path.join(__dirname,'..');
const route = fs.readFileSync(path.join(root,'routes/agente_financeiro_drive.js'),'utf8');
const routeV2 = fs.readFileSync(path.join(root,'routes/agente_financeiro_drive_parser_v2.js'),'utf8');
const extractor = fs.readFileSync(path.join(root,'lib/pdf-layout-extractor.js'),'utf8');
const start = fs.readFileSync(path.join(root,'scripts/start.js'),'utf8');
const page = fs.readFileSync(path.join(root,'public/agente-financeiro-semanal.html'),'utf8');
const importPage = fs.readFileSync(path.join(root,'public/agente-financeiro-importacao.html'),'utf8');

assert.match(route,/drive\.readonly/);
assert.match(route,/GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL/);
assert.match(route,/GOOGLE_DRIVE_PRIVATE_KEY/);
assert.match(route,/GOOGLE_DRIVE_FATURAS_FOLDER_ID/);
assert.match(route,/CARTAO_PDF_PASSWORD/);
assert.match(route,/normalizarFolderId/);
assert.match(route,/supportsAllDrives/);
assert.match(route,/includeItemsFromAllDrives/);
assert.match(route,/listarVisiveis/);
assert.match(route,/varredura_visiveis/);
assert.match(route,/tentarMetadataPasta/);
assert.match(route,/contaServico/);
assert.match(route,/pastaConfiguradaId/);
assert.match(route,/itensEncontrados/);
assert.match(route,/candidatosFaturaVisiveis/);
assert.match(route,/\[Agente Financeiro\]\[Drive\]/);
assert.match(route,/r\.get\('\/status'/);
assert.match(route,/r\.get\('\/arquivos'/);
assert.match(route,/r\.post\('\/extrair'/);
assert.match(route,/r\.post\('\/interpretar'/);
assert.match(route,/r\.post\('\/importar'/);
assert.match(route,/DIVERGENCIA_TOTAL/);
assert.match(route,/FATURA_EXISTENTE/);
assert.match(route,/protegerPoolPorLoja/);

assert.match(routeV2,/extrairTextosPdf/);
assert.match(routeV2,/textos\.sequencial/);
assert.match(routeV2,/_origem:'sequencial'/);
assert.match(routeV2,/Parser candidatos/);
assert.match(routeV2,/metodo_extracao/);
assert.match(routeV2,/melhorPreview/);
assert.match(routeV2,/DIVERGENCIA_TOTAL/);
assert.match(routeV2,/FATURA_EXISTENTE/);
assert.match(extractor,/montarLinhas/);
assert.match(extractor,/montarSequencial/);
assert.match(extractor,/hasEOL/);
assert.match(extractor,/transform\?\.\[4\]/);
assert.match(extractor,/transform\?\.\[5\]/);

const seq = montarSequencial([
  {str:'06/12',transform:[0,0,0,0,10,100],hasEOL:false},
  {str:'TENDA ATACADO',transform:[0,0,0,0,50,100],hasEOL:false},
  {str:'10,75D',transform:[0,0,0,0,180,100],hasEOL:true},
  {str:'08/12',transform:[0,0,0,0,10,90],hasEOL:false},
  {str:'MARAVILHAS DO LAR',transform:[0,0,0,0,50,90],hasEOL:false},
  {str:'15,96D',transform:[0,0,0,0,180,90],hasEOL:true}
]);
assert.deepEqual(seq,['06/12 TENDA ATACADO 10,75D','08/12 MARAVILHAS DO LAR 15,96D']);

assert.ok(start.indexOf('agente_financeiro_drive_parser_v2') < start.indexOf("require('../routes/agente_financeiro_drive')"));
assert.match(start,/\/api\/agente-financeiro\/drive/);
assert.match(page,/drive\/status/);
assert.match(page,/drive\/arquivos/);
assert.match(importPage,/drive\/interpretar/);
assert.match(importPage,/drive\/importar/);
console.log('agente-financeiro-drive.test.js: OK');
