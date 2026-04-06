/**
 * routes/dre.js — M2: DRE & Classificador
 *
 * Rotas:
 *   GET  /api/dre/sessoes              → lista sessões
 *   GET  /api/dre/sessoes/:id          → carrega sessão
 *   POST /api/dre/salvar               → salva/atualiza sessão (upsert por mes_ref)
 *   DELETE /api/dre/sessoes/:id        → remove sessão
 *   POST /api/dre/import-extrato       → importa extrato bancário (XLSX/CSV/OFX)
 *   GET  /api/dre/relatorio/:mes       → gera relatório DRE estruturado
 *   GET  /api/dre/kpis                 → KPIs financeiros
 *   GET  /api/dre/categorias           → lista categorias DRE configuradas
 */

const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const autenticar = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.UPLOAD_MAX_MB) || 15) * 1024 * 1024 },
});

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // Perfil contabil: somente leitura — bloqueia qualquer escrita
  r.use((req, res, next) => {
    if (req.user?.perfil === 'contabil' && req.method !== 'GET') {
      return res.status(403).json({ ok: false, erro: 'Perfil contábil tem acesso somente leitura' });
    }
    next();
  });

  // ── Init tabelas ───────────────────────────────────────────────────────────
  // Lookup de fornecedores por CNPJ
  async function seedFornecedores(pool) {
    await pool.query(`
      INSERT INTO fornecedores_lookup (cnpj_num, cnpj, nome) VALUES
        ('34417914000174', '34.417.914/0001-74', '34.417.914 JHONATAS FELIPE SILVA ABRAO'),
        ('22873332000113', '22.873.332/0001-13', '3GX COMERCIO DE ALIMENTOS EIRELI'),
        ('51442471000190', '51.442.471/0001-90', '51 442 471 LEANDRO BURRALDON MARIANO ME'),
        ('30750648000146', '30.750.648/0001-46', 'A. F. TRANSPORTES EIRELI'),
        ('33189715000193', '33.189.715/0001-93', 'ACEZO COM. DE CARVO VEGETAL'),
        ('38239999000107', '38.239.999/0001-07', 'ADRIANA LEARDINE HENRIQUE 30716476894'),
        ('28835156000101', '28.835.156/0001-01', 'ADRIANA RODRIGUES DA SILVA TRANSPORTES - ME'),
        ('67434506000180', '67.434.506/0001-80', 'AEREO LESTE CARGAS E ENCOMENDAS LTDA'),
        ('31584187000141', '31.584.187/0001-41', 'AGNALDO APARECIDO PRESTES'),
        ('3289830000135', '32.89.830/0001-35', 'AGROTAN BRIQUETES LTDA'),
        ('10792120000203', '10.792.120/0002-03', 'AGROPECUARIA MFL LTDA'),
        ('12657682000199', '12.657.682/0001-99', 'ALL TIME - CONFECCOES EIRELI'),
        ('37823131000189', '37.823.131/0001-89', 'ALLEGRA COMERCIO DE ALIMENTOS LTDA'),
        ('22389802000178', '22.389.802/0001-78', 'ALPACK IND E COMER DE EMBAL E PAPEL'),
        ('43921948000192', '43.921.948/0001-92', 'ALMAFUERTE ALIMENTOS LTDA'),
        ('47387341000125', '47.387.341/0001-25', 'ALSSABAK COMERCIO E INDUSTRIA DE CARNES LTDA'),
        ('07526557008003', '07.526.557/0080-03', 'AMBEV S.A. - CDD CAMPINAS'),
        ('07526557010504', '07.526.557/0105-04', 'AMBEV S/A CDD - SAO PAULO'),
        ('44904635000199', '44.904.635/0001-99', 'ANNA CAROLINA ALONSO AGOSTINI DE SOUZA SANTANA'),
        ('33118792000152', '33.118.792/0001-52', 'APJ TRANSPORTES DE CARGAS EIRELI'),
        ('48547159000157', '48.547.159/0001-57', 'ARMAZEM SPECIALLI LTDA'),
        ('43621518000155', '43.621.518/0001-55', 'ATAIDES FRANCISCO BAPTISTA 16936245838'),
        ('41326688000181', '41.326.688/0001-81', 'ATELIE DAS MASSAS COMERCIO DE ALIMENTOS LTDA'),
        ('21602806000120', '21.602.806/0001-20', 'ATIMO BRASIL MARCENARIA E EMPREENDIMENTOS EIRELI'),
        ('46237080000102', '46.237.080/0001-02', 'ARTMILL ACESSORIOS LTDA EPP'),
        ('45047216000140', '45.047.216/0001-40', 'AUSBRA BOUTIQUE DE CARNES LTDA'),
        ('17574269000184', '17.574.269/0001-84', 'ALCALA MANUTENÇÃO E REPARAÇÃO DE PECAS LTDA'),
        ('46237080000147', '46.237.080/0001-47', 'BARRA MANSA COMÉRCIO DE CARNES E DEVERIADOS LTDA'),
        ('21980140000143', '21.980.140/0001-43', 'B C FELIX TRANSPORTES ME'),
        ('17801097000134', '17.801.097/0001-34', 'BELLA BUARQUE COMERCIO DE REFEICOES E DELIVERY LTDA'),
        ('17672730000131', '17.672.730/0001-31', 'BELLA BUARQUE PANIFICADORA E CONFEITARIA LTDA'),
        ('44659874000120', '44.659.874/0001-20', 'BRASEIRO IND E COM DE PROD LTDA'),
        ('48740351001722', '48.740.351/0017-22', 'BRASPRESS TRANSPORTES URGENTES'),
        ('48740351003695', '48.740.351/0036-95', 'BRASPRESS TRANSPORTES URGENTES LTDA'),
        ('09437474000170', '09.437.474/0001-70', 'BRAZILIAN DRINKS INDUSTRIA COMERCIO E EXPORTACAO LTDA'),
        ('47780123000156', '47.780.123/0001-56', 'BRUNO RAMIRES FERREIRA MACHADO 43004115816'),
        ('46237080000102', '46.237.080/0001-02', 'B2B - HOME23 COMERCIO'),
        ('01838723032592', '01.838.723/0325-92', 'BRF S.A.'),
        ('00923077000133', '00.923.077/0001-33', 'CALIMP IMP EXPORT LTDA'),
        ('01932232000221', '01.932.232/0002-21', 'CALLAMARYS INDUSTRIA E COMERCIO COSMETICOS SANEANTES EIRELI'),
        ('36098889000139', '36.098.889/0001-39', 'CARLIATTO COM E REP LTDA'),
        ('38331417000100', '38.331.417/0001-00', 'CAM TRANSPORTES LTDA'),
        ('04318616000166', '04.318.616/0001-66', 'CAMPO VERDE ALIMENTOS LTDA'),
        ('618585710000626', '61.858.571/00006-26', 'COMGAS'),
        ('30435064000186', '30.435.064/0001-86', 'CANTAGALLO PRODUTOS ALIMENTICIOS LTDA'),
        ('43811597000400', '43.811.597/0004-00', 'CARGOFRIO LOGISTICA E ARMAZENAMENTO LTDA - VALINHOS'),
        ('30583000000122', '30.583.000/0001-22', 'CARNEARIA LTDA'),
        ('10742363000156', '10.742.363/0001-56', 'CARRION LOGISTICA E TRANSPORTES LTDA'),
        ('54719042000106', '54.719.042/0001-06', 'CARVOARIA IPE LTDA'),
        ('53437566000141', '53.437.566/0001-41', 'SABORMOR INDUSTRIA E COMERCIO DE ALIMEN'),
        ('34577317000107', '34.577.317/0001-07', 'CX7 Comercio de Embalagens e Papelaria LTDA'),
        ('50326977000171', '50.326.977/0001-71', 'CASA DO PADEIRO'),
        ('03639618000194', '03.639.618/0001-94', 'CENTROSUL TRASNPORTES E LOGISTICA'),
        ('716804820000116', '71680482/00001-16', 'CICERO FERREIRA LIMA PARAPUA'),
        ('32666253000195', '32.666.253/0001-95', 'COMERCIAL SANTO ANTONIO DE MOGI MIRIM LTDA'),
        ('69158285000351', '69.158.285/0003-51', 'COMERCIAL TUDO EM CARNES LIMITADA'),
        ('00262286000183', '00.262.286/0001-83', 'COMERCIO DE FRIOS SERFRAN LTDA'),
        ('13039120000497', '13.039.120/0004-97', 'COMFRIO TRANSPORTES EIRELI'),
        ('83310441007553', '83.310.441/0075-53', 'COOPERATIVA CENTRAL AURORA ALIMENTOS'),
        ('16908690000111', '16.908.690/0001-11', 'CUCINA DELLO CHEF'),
        ('60795978000208', '60.795.978/0002-08', 'CACO COMERCIAL DE FRUTAS LTDA'),
        ('23415237000139', '23.415.237/0001-39', 'D & J TRANSPORTES LTDA'),
        ('23257609000146', '23.257.609/0001-46', 'D B TRANSPORTES LTDA ME'),
        ('11879837000179', '11.879.837/0001-79', 'DALE IND E COM DE ALIMENTOS LTDA'),
        ('39526289000112', '39.526.289/0001-12', 'DC COMPANY TRANSPORTES LTDA'),
        ('55113659000146', '55.113.659/0001-46', 'DE BRAGA PRODUTOS ALIMENTICIOS LTDA'),
        ('07043601000120', '07.043.601/0001-20', 'DECABRON'),
        ('08442327851', '084.423.278-51', 'DEUSDETE AILTA (FRETEIRO)'),
        ('39472173000148', '39.472.173/0001-48', 'DIEGO BURRALDON MARIANO TRANSPORTE RODOVIARIO UNIPESSOAL LTD'),
        ('24978869000173', '24.978.869/0001-73', 'DISTRIBUIDORA MIOTTO LTDA'),
        ('07790200000134', '07.790.200/0001-34', 'DMG PRODUTOS ALIMENTICIOS LTDA'),
        ('29637454000150', '29.637.454/0001-50', 'DOS TRANSPORTES LTDA'),
        ('30251539000184', '30.251.539/0001-84', 'DOUGLAS HENRIQUE DA SILVA ROCHA TRANSPORTES'),
        ('42634540000177', '42.634.540/0001-77', 'DORATO DOCES E SORVETES PREMIUM'),
        ('57622466000146', '57.622.466/0001-46', 'DISTRIBUIDORA DE CARNES  VALE DO MOGI IMP EXP LTDA'),
        ('57317133000103', '57.317.133/0001-03', 'DV3 SOLUCOES LOGISTICAS LTDA'),
        ('01754239001868', '01.754.239/0018-68', 'REFRIGERAÇÃO DUFRIO COMERCIO E IMPORTAÇÃO S.A'),
        ('46783432000117', '46.783.432/0001-17', 'EFRAIM TRANSPORTES'),
        ('42239824000169', '42.239.824/0001-69', 'ELGIDIO NUNES DA SILVA 14393623860'),
        ('31866183000156', '31.866.183/0001-56', 'ELSON HERLY DA SILVA 38804338873'),
        ('27470795000158', '27.470.795/0001-58', 'EMBUTIDOS SPECIALLI LTDA'),
        ('41471081000195', '41.471.081/0001-95', 'EMPORIO SPECIALLI LTDA'),
        ('46174884000100', '46.174.884/0001-00', 'EXPRESSO DE PRATA CARGAS LTDA'),
        ('46174884004601', '46.174.884/0046-01', 'EXPRESSO DE PRATA CARGAS LTDA'),
        ('26341222000161', '26.341.222/0001-61', 'EXPRESSO M-2000 LTDA'),
        ('00428307001917', '00.428.307/0019-17', 'EXPRESSO SAO MIGUEL LTDA'),
        ('00428307001240', '00.428.307/0012-40', 'EXPRESSO SAO MIGUEL LTDA'),
        ('00428307000198', '00.428.307/0001-98', 'EXPRESSO SAO MIGUEL LTDA'),
        ('35589759000136', '35.589.759/0001-36', 'ENCOVAC COMERCIO DE EMBALAGENS LTDA'),
        ('37180287000199', '37.180.287/0001-99', 'F LOG TRANSPORTES E SOLUCOES AUTOMOTIVAS'),
        ('26148313000185', '26.148.313/0001-85', 'FA DEFUMADOS EIRELI'),
        ('13619204000157', '13.619.204/0001-57', 'FAMPACK EMBALAGENS LTDA - EPP'),
        ('26128047000129', '26.128.047/0001-29', 'FENIX LOG - SOLUCOES LOGISTICAS'),
        ('23416516000117', '23.416.516/0001-17', 'FERNANDA DE MELO SILVA TRANSPORTES'),
        ('19483764000103', '19.483.764/0001-03', 'FERNANDA RODRIGUES NARCISO COMERCIO DE SALAMES'),
        ('33870288817', '338.702.888-17', 'FERNANDO NUNES DALL ACQUA'),
        ('10458829000196', '10.458.829/0001-96', 'FEVARI INDUSTRIA E COMERCIO DE CONFECCOES LTDA'),
        ('51531439000181', '51.531.439/0001-81', 'FALCAO SOBREMESSAS LTDA'),
        ('36226780000130', '36.226.780/0001-30', 'FABENE CIA DE ALIMENTOS LTDA'),
        ('15149275000169', '15.149.275/0001-69', 'FLAVIA RIBEIRO DOS SANTOS DE ANDRADA E SILVA'),
        ('09367315000146', '09.367.315/0001-46', 'FORT - TRANSPORTE E DISTRIBUIC'),
        ('68067446002463', '68.067.446/0024-63', 'FRIGOL S.A.'),
        ('68067446002110', '68.067.446/0021-10', 'FRIGOL S.A.'),
        ('37962897000144', '37.962.897/0001-44', 'FRIGORIFICO BDS FOODS LTDA'),
        ('44734044000110', '44.734.044/0001-10', 'FRIGORIFICO CANCIAN LTDA'),
        ('00896467000161', '00.896.467/0001-61', 'FRIGORIFICO COWPIG'),
        ('88728027000146', '88.728.027/0001-46', 'FRIGORIFICO SILVA INDUSTRIA E COMERCIO LTDA'),
        ('36295880001009', '36.295.880/0010-09', 'FRIGORIFICO HUMAITA LTDA'),
        ('25036392000501', '25.036.392/0005-01', 'FRONERI BRASIL DIST.DE SORV E CONG. LTDA'),
        ('00163222000125', '00.163.222/0001-25', 'FUTURA COMERCIAL TRADING LTDA'),
        ('18694478000105', '18.694.478/0001-05', 'FG7 COMERCIO E DISTRIBUIDORA DE BEBIDAS'),
        ('46237080000102', '46.237.080/0001-02', 'GARDEN FOODS DISTRIBUIDORA DE ALIMENTOS LTDS'),
        ('32533557000184', '32.533.557/0001-84', 'GEAUD DISTRIBUIDORA DE ALIMENTOS LTDA.'),
        ('42292415000126', '42.292.415/0001-26', 'GH1 LOGGI TRANSPORTES LTDA'),
        ('29512603000154', '29512603/0001-54', 'G.A.M. M. PIAIA COMERCIO DE BEBIDAS'),
        ('02294739000189', '02294739/0001-89', 'CL GERMANO EIRELI'),
        ('24312876000131', '24.312.876/0001-31', 'GRAULOG JPG LTDA - EPP'),
        ('03011776000103', '03.011.776/0001-03', 'GRILAZER INDUSTRIA E COMERCIO DE UTILIDADES D'),
        ('18293459000196', '18.293.459/0001-96', 'GUIDARA INDUSTRIA E COMERCIO DE ALIMENTOS EIRELI'),
        ('23441411000118', '23.441.411/0001-18', 'GUSTAVO MONTEIRO CARDOSO'),
        ('46237080000102', '46.237.080/0001-02', 'GF COMERCIO DE GELO LTDA'),
        ('44173629000109', '44.173.629/0001-09', 'HAUS10 COMERCIO DE BENS DE CONSUMO LTDA'),
        ('33400055000148', '33.400.055/0001-48', 'HL MARTINS TRANSPORTES LTDA'),
        ('49086478000175', '49.086.478/0001-75', 'HOLZDREW WOODWORK LTDA'),
        ('33630440000181', '33.630.440/0001-81', 'Helmavi Alimentos Ltda'),
        ('27854440000162', '27.854.440/0001-62', 'IFC - DISTR DE ALIMENTOS CONGELADOS LTDA'),
        ('32310478000104', '32.310.478/0001-04', 'ISABEL MARIA DA SILVA FRANCO 06695007802'),
        ('16950996000306', '16.950.996/0003-06', 'ISAVIC TRANSPORTE E ARMAZENAMENTO LTDA'),
        ('56603025000146', '56.603.025/0001-46', 'INOVE BOLSAS INDUSTRIAS E COMEERCIO LTDA'),
        ('17216114000176', '17216114/0001-76', 'IMPERIO DO CHURRASCO EIRELI'),
        ('39453707000199', '39.453.707/0001-99', 'J J S DE OLIVEIRA TRANSPORTES'),
        ('41149528000104', '41.149.528/0001-04', 'J R T TRANSPORTES'),
        ('20416098000170', '20.416.098/0001-70', 'J S FERREIRA TRANSPORTES E LOGISTICA'),
        ('35961132000164', '35.961.132/0001-64', 'J&A TRANSPORTES LTDA'),
        ('13294850000191', '13.294.850/0001-91', 'J.A COM. DE GEN. ALIM. E SERV. EIRELI'),
        ('12040186000191', '12.040.186/0001-91', 'JAML M.A.H SULEIMAN-PIMENTAS -ME'),
        ('51091656000106', '51.091.656/0001-06', 'JC BARBOSA TRANSPORTES DE CARGAS LTDA'),
        ('32649292000184', '32.649.292/0001-84', 'JOAO NUNES TRANSPORTES'),
        ('14618175877', '146.181.758-77', 'JORGE AUGUSTO CARRIEL'),
        ('23154251000126', '23.154.251/0001-26', 'JR TRANSPORTADORA EIRELI - ME'),
        ('20527393000101', '20.527.393/0001-01', 'KHALIL YEPES HOJEIJE E OUTROS'),
        ('00153705000300', '00.153.705/0003-00', 'KORIN AGROPECUARIA LTDA'),
        ('31038210000100', '31.038.210/0001-00', 'LAINE TRANSPORTE RODOVIARIO CARGAS LTDA'),
        ('03788359000163', '03.788.359/0001-63', 'LARADIN TRANSPORTES EIRELI'),
        ('58844424000112', '58.844.424/0001-12', 'LAGOA AZUL COM. E REPRESENTANT LTDA'),
        ('29331589000192', '29.331.589/0001-92', 'LABELBEER IND. E COM. DE ADESIVOS E ROT. LTDA'),
        ('41576807000154', '41.576.807/0001-54', 'LEONARDO MARQUES TRANSPORTES'),
        ('22333433000100', '22.333.433/0001-00', 'LETICIA FERREIRA DA SILVA SOARES'),
        ('12656321000128', '12.656.321/0001-28', 'LOG VISION TRANSP ROD CARG LTDA'),
        ('20674481000128', '20.674.481/0001-28', 'LOPES TRANSPORTES E SERVICOS LTDA'),
        ('28055653000197', '28.055.653/0001-97', 'LS SULEIMAN COZINHA INDUSTRIAL - ME'),
        ('33325748000113', '33.325.748/0001-13', 'LUIS CARLOS DE SOUZA TRANSPORTES'),
        ('48397349000135', '48.397.349/0001-35', 'LUIZ CARLOS FERREIRA DIAS'),
        ('22601812000125', '22.601.812/0001-25', 'LUIZ FERNANDO NUTTI 13088611844'),
        ('22368481000125', '22.368.481/0001-25', 'LURAGON TRANSPORTES EIRELI'),
        ('44739369000196', '44.739.369/0001-96', 'M L TRANSPORTES'),
        ('28521181000110', '28.521.181/0001-10', 'M. VIEIRA TRANSPORTES DE CARGAS EIRELI'),
        ('41188359000111', '41.188.359/0001-11', 'M.J. COMERCIO DE TEMPEROS E LATICINIOS EIRELI'),
        ('08602684000103', '08.602.684/0001-03', 'MASTER FOODS COMERCIO E IMPORT'),
        ('21114068000171', '21.114.068/0001-71', 'MADEIRAS PARA CHURRASCO PICA-PAU LTDA-ME'),
        ('47960950089785', '47.960.950/0897-85', 'MAGAZINE LUIZA S/A'),
        ('66003344000162', '66.003.344/0001-62', 'MANOEL QUINTANA RODRIGUES ME'),
        ('61515383000125', '61.515.383/0001-25', 'MARCEL ALIMENTOS LTDA'),
        ('18499175000150', '18.499.175/0001-50', 'MARCELO ALVES DE LIMA TRANSPORTES - EPP'),
        ('03853896000301', '03.853.896/0003-01', 'MARFRIG GLOBAL FOODS S.A.'),
        ('03853896004137', '03.853.896/0041-37', 'MARFRIG GLOBAL FOODS S.A.'),
        ('38255474854', '382.554.748-54', 'MARVIE TRANSPORTES E FACILITIES LTDA'),
        ('41534514000104', '41.534.514/0001-04', 'MATHEUS CARDOSO PINTO 11504728980'),
        ('48704879000189', '48.704.879/0001-89', 'MATHEUS DE SOUZA 47022315884'),
        ('07766358000179', '07.766.358/0001-79', 'MDG COMERCIO DE ALIMENTOS LTDA'),
        ('13752012000203', '13.752.012/0002-03', 'MDG TRANSPORTES LTDA ROTA 10'),
        ('67620377005183', '67.620.377/0051-83', 'MINERVA S A'),
        ('19759192000142', '19.759.192/0001-42', 'MIRANDA BOLSAS E ACESSORIOS EIRELI - EPP'),
        ('48588633000199', '48.588.633/0001-99', 'MISTER GELO COMERCIO DE GELO LTDA EPP'),
        ('19930193000108', '19.930.193/0001-08', 'MJ COMPANY - DISTRIBUIDORA DE ALIMENTOS EIRELI'),
        ('511876760000177', '51.187.676/00001-77', 'MM BOLD WOODS LTDA'),
        ('50066936000193', '50.066.936/0001-93', 'MMJD TRANSPORTES LTDA'),
        ('38266028000148', '38.266.028/0001-48', 'MONTEIRO FREITAS TRANSPORTES LTDA'),
        ('02360122000114', '02.360.122/0001-14', 'MOSCA LOGISTICA LTDA'),
        ('46237080000102', '46.237.080-0001-02', 'NOVA CAMPINAS DISTRIBUIDORA DE PRODUTOS ALIMETICIOS LTDA'),
        ('32474102000135', '32.474.102/0001-35', 'MV SOUZA TRANPORTES'),
        ('21942544000142', '21.942.544/0001-42', 'N F TRANSPORTES LTDA'),
        ('08142803000192', '08.142.803/0001-92', 'NOVA MIX INDL. E COML. DE ALIMENTOS LTDA.'),
        ('36009238000125', '36.009.238/0001-25', 'P R SANTOS TRANSPORT CARGAS LTDA'),
        ('11660951000294', '11.660.951/0002-94', 'PAMA COMERCIO DE GENEROS ALIMENTICIOS LTDA'),
        ('45787678000102', '45787678/0001-02', 'PREFEITURA DO MUNICIPIO DE VALINHOS'),
        ('26221058000159', '26.221.058/0001-59', 'PREMIUM DISTRIBUIDORA LTDA'),
        ('17283362000130', '17.283.362/0001-30', 'PRIME CATER COMERCIAL DE PROD. ALIMENTICIOS SA'),
        ('55895031000140', '55.895.031/0001-40', 'PRODUTOS ALIMENTICIOS CEFER LTDA'),
        ('26602883000101', '26.602.883/0001-01', 'PRONI ALIMENTOS LTDA'),
        ('52015955000116', '52.015.955/0001-16', 'Q´BRAZA COMÉRCIO DE CARVÃO VEGETAL LTDA - ME'),
        ('37629654000199', '37.629.654/0001-99', 'R F VIEIRA TRANSPORTES EIRELI'),
        ('42269668000189', '42.269.668/0001-89', 'R P FRIOS TRANSPORTES LTDA ME'),
        ('13929637000109', '13.929.637/0001-09', 'R&N TRANSPORTES DE ENCOMEDAS LTDA'),
        ('29157516000126', '29.157.516/0001-26', 'R. Q. DE BRITO'),
        ('35977523000177', '35.977.523/0001-77', 'RAQUEL REGINA R SALGUEIRO TRANSPORTES'),
        ('43523770000121', '43.523.770/0001-21', 'RBA TRANSPORTES'),
        ('25464928000158', '25.464.928/0001-58', 'RCS TRANSPORTES EIRELI'),
        ('00137998000170', '00.137.998/0001-70', 'R FERNANDEZ & CIA LTDA'),
        ('02780640000197', '02.780.640/0001-97', 'REAL COMERCIAL LTDA'),
        ('34797772000118', '34.797.772/0001-18', 'REI DOS CORDEIROS GRILL LTDA'),
        ('10466983000100', '10.466.983/0001-00', 'REITER TRANSP.E LOGISTICA LTDA'),
        ('12077062000180', '12.077.062/0001-80', 'RENATA FARHAT ME'),
        ('36646431000177', '36.646.431/0001-77', 'RENATO CONCIANI VILAS BOAS - ME'),
        ('20474467000180', '20.474.467/0001-80', 'RENTAI ALIMENTOS LTDA - ME'),
        ('38385804000129', '38.385.804/0001-29', 'RESILIENCIA TRANSPORTADORA E LOGISTICA LTDA'),
        ('00153269000108', '00.153.269/0001-08', 'RETHA MAXIMA EIRELI'),
        ('20239395000197', '20.239.395/0001-97', 'RHAYQUE GUSTAVO CORREA SIQUEIRA 43648923862'),
        ('21525319000100', '21.525.319/0001-00', 'ROCCA INDUSTRIA E COMERCIO DE ALIMENTOS LTDA'),
        ('06895037000101', '06.895.037/0001-01', 'RODOMASTER PIRACICABA LOGISTICA EIRELI'),
        ('13206664000153', '13.206.664/0001-53', 'RODOMAXLOG ARMAZENAGEM E LOGISTICA'),
        ('44914992001371', '44.914.992/0013-71', 'RODONAVES TRANSPORTES E ENCOMENDAS LTDA'),
        ('44914992003315', '44.914.992/0033-15', 'RODONAVES TRANSPORTES E ENCOMENDAS LTDA'),
        ('44914992000138', '44.914.992/0001-38', 'RODONAVES TRANSPORTES E ENCOMENDAS LTDA'),
        ('49487803000101', '49.487.803/0001-01', 'RODOPATRIA LOGISTICA LTDA'),
        ('19451038004287', '19.451.038/0042-87', 'RODOVIARIO CAMILO DOS SANTOS FILHO LTDA'),
        ('01920934000104', '01.920.934/0001-04', 'RODOVIARIO CRISMARA LTDA'),
        ('27822869000178', '27.822.869/0001-78', 'RODOXICO TRANSPORTES LTDA'),
        ('67567222000161', '67.567.222/0001-61', 'RONEI MAURICIO DIETRICH'),
        ('03906510000110', '03.906.510/0001-10', 'ROPI TRANSPORTES DE JORNAIS E REVISTAS L'),
        ('41033826000134', '41.033.826/0001-34', 'ROSA NOEMI SILVA COSTA MARTINS'),
        ('10350187000107', '10.350.187/0001-07', 'ROSSINI IND. COM. DE ALIMENTOS IND. LTDA'),
        ('10996444000506', '10.996.444/0005-06', 'RXM - JANDIRA'),
        ('10349430000177', '10.349.430/0001-77', 'SCHREIBER LOGISTICA LTDA'),
        ('2903131000199', '29.031.31/0001-99', 'Sam Wilson Alimentos LTDA'),
        ('37323339000139', '37.323.339/0001-39', 'SERGIO BARBOSA IGLESIAS 05512390856'),
        ('40082442000149', '40.082.442/0001-49', 'SILVIA SUELI PEREIRA LIMA 14754548809'),
        ('33777353000151', '33.777.353/0001-51', 'SIMPLE COMERCIO DE PRODUTOS ALIMENTICIOS LTDA'),
        ('33004476000150', '33.004.476/0001-50', 'SOUL CHEF PRODUTOS ALIMENTICIOS LTDA'),
        ('61186888001831', '61.186.888/0018-31', 'SPAL INDUSTRIA BRASILEIRA DE BEBIDAS S/A'),
        ('61186888018211', '61.186.888/0182-11', 'SPAL INDUSTRIA BRASILEIRA DE BEBIDAS S/A'),
        ('61186888009905', '61.186.888/0099-05', 'SPAL INDUSTRIA BRASILEIRA DE BEBIDAS S/A'),
        ('27591313000118', '27.591.313/0001-18', 'SPARTA ALIMENTOS LTDA'),
        ('25015283000176', '25.015.283/0001-76', 'SPECIALMEATS BUFFET LTDA'),
        ('17216489000136', '17.216.489/0001-36', 'SRL DE MORAES TRANSPORTES LTDA'),
        ('293109218540', '29310921854.0', 'Silvia Fernandes'),
        ('29686774000108', '29.686.774/0001-08', 'STEPPENWOOD & AVENTARE CO LTDA'),
        ('18171266000162', '18.171.266/0001-62', 'TAG DEL SOL TRANSPORTES LTDA'),
        ('08890381000133', '08.890.381/0001-33', 'TCE TRANSPORTES E LOGISTICA URGENTE'),
        ('01157555001852', '01.157.555/0018-52', 'TENDA ATACADO SA'),
        ('34989299000170', '34.989.299/0001-70', 'TOP-X FOODS PRODUTOS ALIMENTICIOS LTDA'),
        ('61652608000195', '61.652.608/0001-95', 'TRAMONTINA SUDESTE S.A.'),
        ('44373617000128', '44.373.617/0001-28', 'TRANS ALBUQUERQUE EPP'),
        ('02816931000198', '02.816.931/0001-98', 'TRANSJUB JUNDIAI TRANSPORTES LTDA'),
        ('67531772000120', '67.531.772/0001-20', 'TRANSLABAF TRANSPORTES RODOVIARIOS DE CARGA LTDA'),
        ('08708477000138', '08.708.477/0001-38', 'TRANSPORTADORA ARRIECHE DA SILVA LTDA'),
        ('00367894000586', '00.367.894/0005-86', 'TRANSPORTADORA REAL 94 LTDA'),
        ('73105595000113', '73.105.595/0001-13', 'TRANSPORTADORA REBECCHI LTDA'),
        ('00825011000100', '00.825.011/0001-00', 'TRANSPORTADORA VAB LTDA'),
        ('02930495000183', '02.930.495/0001-83', 'TRANSPORTES GUABEIRA LTDA ME'),
        ('00560156000127', '00.560.156/0001-27', 'TRANSPORTES GUAIANAZES LTDA ME'),
        ('49151483000114', '49.151.483/0001-14', 'TRANSPORTES IMEDIATO LTDA'),
        ('49151483000629', '49.151.483/0006-29', 'TRANSPORTES IMEDIATO LTDA EMBU'),
        ('31799878000162', '31.799.878/0001-62', 'TRANSPORTES J.P.G. LTDA'),
        ('58969676000178', '58.969.676/0001-78', 'TRANSPORTES KENTAK LTDA ME'),
        ('02191083000179', '02.191.083/0001-79', 'TRANSPORTES RIMASA LTDA ME'),
        ('48697715000171', '48.697.715/0001-71', 'TRANSPORTES RODOVIARIO MARIANO LTDA ME'),
        ('60174281000120', '60.174.281/0001-20', 'TRANSPORTES RONDONOPOLIS LTDA'),
        ('89823918001388', '89.823.918/0013-88', 'TRANSPORTES TRANSLOVATO LTDA'),
        ('39339778000165', '39.339.778/0001-65', 'VAGNER DONIZETE ALVES 27213252801'),
        ('27864219000195', '27.864.219/0001-95', 'VICTOR NOGUEIRA LABADESSA'),
        ('32310178000125', '32.310.178/0001-25', 'VILA BRAS COMERCIO DE REFEICOES E DELIVERY EIRELI'),
        ('30832515000119', '30.832.515/0001-19', 'VILA BRAS PANIFICADORA E CONFEITARIA EIRELI'),
        ('46681449000163', '46.681.449/0001-63', 'VISION LOG TRANSP RODO DE CARGAS LTDA'),
        ('26051578000160', '26.051.578/0001-60', 'VL TRANSPORTES LTDA - ME'),
        ('07162028000417', '07.162.028/0004-17', 'VPJ COMERCIO DE PRODUTOS ALIMENTICIOS LTDA'),
        ('41090301000130', '41.090.301/0001-30', 'WAGNER DOS SANTOS FERREIRA 24978174805'),
        ('11606343000173', '11,606,343/0001-73', 'FORTALEZA SANTA TERESINHA'),
        ('17524782000160', '17.524.782/0001-60', 'ZADOK LOG TRANSP COMERCIO LTDA ME'),
        ('64559589000238', '64.559.589/0002-38', 'WEW IMPORTAÇÃO E EXPORTACAO LTDA'),
        ('10688551000143', '10.688.551/0001-43', 'SR GRAFICA LTDA'),
        ('44635233000136', '44.635.233/0001-36', 'DAEV'),
        ('57189065000144', '57.189.065/0001-44', 'TOQUINHOS E CARVÃO LTDA'),
        ('28674985000150', '28.674.985/0001-50', 'CABANHA INTERLAGOS GOURMET LTDA'),
        ('62162243000345', '62.162.243/0003-45', 'INDUSTRIA E COMERCIO DE PRODUTOS ALIMENTICIOS CEPERA LTDA'),
        ('718898910000116', '71.889.891/00001-16', 'D.M.L COMUNICAÇÃO E SINALIZAÇÃO LTDA'),
        ('030631470000208', '03.063.147/00002-08', 'POLO AGENCIAMENTO PUBLICITARIO'),
        ('20415805000103', '20.415.805/0001-03', 'BONFA PAES ARTESANAIS LTDA'),
        ('36078911000189', '36078911/0001-89', 'RICAR IND COM DE EMBALAGENS E TRANSP GERAL LTDA'),
        ('23577462000252', '23.577.462/0002-52', 'VALLE FOODS COMERCIO DE PRODUTOS ALIMENTICIOS LTDA')
      ON CONFLICT (cnpj_num) DO UPDATE SET nome=EXCLUDED.nome
    `).catch(e => console.error('[dre] seed fornecedores:', e.message));
    console.log('[dre] fornecedores_lookup populado');
  }

  async function initTable() {
    // Tabela de fornecedores para lookup por CNPJ
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fornecedores_lookup (
        id        SERIAL PRIMARY KEY,
        cnpj_num  TEXT UNIQUE NOT NULL,
        cnpj      TEXT,
        nome      TEXT NOT NULL,
        categoria TEXT
      )
    `).catch(() => {});
    // Seed dos fornecedores (idempotente)
    const count = await pool.query(`SELECT COUNT(*) FROM fornecedores_lookup`).then(r => parseInt(r.rows[0].count)).catch(() => 0);
    if (count < 10) {
      await seedFornecedores(pool);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dre_sessoes (
        id            SERIAL PRIMARY KEY,
        mes_ref       TEXT NOT NULL,
        descricao     TEXT,
        dados_json    JSONB,
        usuario_id    INTEGER,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (mes_ref, usuario_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dre_lancamentos (
        id            SERIAL PRIMARY KEY,
        sessao_id     INTEGER REFERENCES dre_sessoes(id) ON DELETE CASCADE,
        fonte         TEXT DEFAULT 'MANUAL',
        lancamento    TEXT NOT NULL,
        valor         NUMERIC(14,2) NOT NULL DEFAULT 0,
        data_lanc     TEXT,
        mes           TEXT,
        mes_caixa     TEXT,
        categoria     TEXT,
        grupo_dre     TEXT,
        ignorar       BOOLEAN DEFAULT false,
        boleto_id     INTEGER,
        usuario_id    INTEGER,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Garante colunas extras na dre_lancamentos
    for (const [col, def] of [
      ['fitid',       'TEXT'],
      ['razao_social','TEXT'],
      ['portador',    'TEXT'],
      ['mes_caixa',   'TEXT'],
      ['atualizado_em','TIMESTAMPTZ DEFAULT NOW()'],
    ]) {
      await pool.query(`ALTER TABLE dre_lancamentos ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(()=>{});
    }
    // Índice por fitid para deduplicação rápida
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_lanc_fitid ON dre_lancamentos(fitid) WHERE fitid IS NOT NULL`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_sessoes_mes  ON dre_sessoes(mes_ref)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_lanc_sessao  ON dre_lancamentos(sessao_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_lanc_mes     ON dre_lancamentos(mes)`).catch(()=>{});
  }
  initTable().catch(e => console.error('[dre] initTable:', e.message));

  // ── GET /categorias ────────────────────────────────────────────────────────
  r.get('/categorias', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM categorias_dre WHERE ativo=true ORDER BY grupo ASC, ordem ASC, subgrupo ASC`
      );
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /categorias — cria nova categoria ─────────────────────────────────
  r.post('/categorias', async (req, res) => {
    const { grupo, subgrupo, label_exibicao, ordem } = req.body;
    if (!grupo || !subgrupo) return res.status(400).json({ ok: false, erro: 'grupo e subgrupo obrigatórios' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [grupo, subgrupo, label_exibicao || subgrupo, parseInt(ordem) || 0]
      );
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /categorias/:id — atualiza categoria ───────────────────────────────
  r.put('/categorias/:id', async (req, res) => {
    const { grupo, subgrupo, label_exibicao, ordem } = req.body;
    try {
      await pool.query(
        `UPDATE categorias_dre SET grupo=$1, subgrupo=$2, label_exibicao=$3, ordem=$4 WHERE id=$5`,
        [grupo, subgrupo, label_exibicao || subgrupo, parseInt(ordem) || 0, parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /categorias/:id — desativa categoria ────────────────────────────
  r.delete('/categorias/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE categorias_dre SET ativo=false WHERE id=$1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const mes = req.query.mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();

      // Busca sessão do mês
      const { rows: sessoes } = await pool.query(
        `SELECT id, dados_json FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`,
        [mes]
      );

      // Busca meta do mês
      const { rows: metas } = await pool.query(
        `SELECT faturamento_meta, faturamento_real FROM metas WHERE mes = $1 LIMIT 1`,
        [mes]
      );

      let receitas = 0, despesas = 0, resultado = 0;

      if (sessoes.length && sessoes[0].dados_json) {
        const dados = sessoes[0].dados_json;
        const txs = dados.transactions || [];
        for (const t of txs) {
          if (t.ignorar) continue;
          const v = parseFloat(t.valor || 0);
          if (v > 0) receitas += v;
          else despesas += Math.abs(v);
        }
        resultado = receitas - despesas;
      }

      const meta = metas[0] || {};
      res.json({
        ok: true, data: {
          mes,
          receitas,
          despesas,
          resultado,
          margemBruta: receitas > 0 ? ((resultado / receitas) * 100).toFixed(1) : '0.0',
          faturamentoMeta: parseFloat(meta.faturamento_meta || 0),
          faturamentoReal: parseFloat(meta.faturamento_real || receitas || 0),
        }
      });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /sessoes ───────────────────────────────────────────────────────────
  r.get('/sessoes', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const { rows } = await pool.query(`
        SELECT id, mes_ref, descricao, criado_em, atualizado_em,
               jsonb_array_length(dados_json->'transactions') AS total_lancamentos
        FROM dre_sessoes
        ORDER BY atualizado_em DESC
        LIMIT $1
      `, [limit]);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /sessoes/:id ───────────────────────────────────────────────────────
  r.get('/sessoes/:id(*)', async (req, res) => {
    try {
      const raw = decodeURIComponent(req.params.id);
      const isNum = /^\d+$/.test(raw);
      const query = isNum
        ? `SELECT * FROM dre_sessoes WHERE id = $1`
        : `SELECT * FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`;
      const { rows } = await pool.query(query, [isNum ? parseInt(raw) : raw]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Sessão não encontrada' });
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── Espelha lançamentos do JSON na tabela dre_lancamentos ────────────────
  // Garante que os dados nunca se percam — tabela é a fonte de verdade para backup
  async function espelharLancamentos(sessaoId, transacoes) {
    if (!sessaoId || !Array.isArray(transacoes)) return;
    try {
      for (const t of transacoes) {
        if (!t.lancamento || t.valor === undefined) continue;
        const fitid = t.fitid || null;
        // Se tem fitid, upsert por fitid+sessao_id
        if (fitid) {
          await pool.query(`
            INSERT INTO dre_lancamentos
              (sessao_id, fitid, fonte, lancamento, razao_social, valor, data_lanc, mes, mes_caixa,
               categoria, grupo_dre, ignorar, portador, atualizado_em)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
            ON CONFLICT DO NOTHING
          `, [sessaoId, fitid, t.fonte||'EXTRATO', t.lancamento||'',
              t.razaoSocial||null, parseFloat(t.valor||0),
              t.data||null, t.mes||null, t.mesCaixa||null,
              t.categoria||null, t.grupoKey||null,
              t.ignorar||false, t.portador||null]);
          // Atualiza categoria se foi classificado depois
          if (t.categoria) {
            await pool.query(`
              UPDATE dre_lancamentos SET categoria=$1, grupo_dre=$2, atualizado_em=NOW()
              WHERE sessao_id=$3 AND fitid=$4
            `, [t.categoria, t.grupoKey||null, sessaoId, fitid]);
          }
        } else {
          // Sem fitid — usa hash para evitar duplicata
          const hash = `${t.data||''}_${String(t.valor||'')}`.replace(/\./g,'_');
          await pool.query(`
            INSERT INTO dre_lancamentos
              (sessao_id, fonte, lancamento, razao_social, valor, data_lanc, mes, mes_caixa,
               categoria, grupo_dre, ignorar, portador, atualizado_em)
            SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()
            WHERE NOT EXISTS (
              SELECT 1 FROM dre_lancamentos
              WHERE sessao_id=$1 AND data_lanc=$6 AND valor=$5
                AND lancamento=$3
            )
          `, [sessaoId, t.fonte||'MANUAL', t.lancamento||'',
              t.razaoSocial||null, parseFloat(t.valor||0),
              t.data||null, t.mes||null, t.mesCaixa||null,
              t.categoria||null, t.grupoKey||null,
              t.ignorar||false, t.portador||null]);
        }
      }
      // Atualiza categorias de lançamentos existentes (classificações feitas pelo usuário)
      for (const t of transacoes.filter(t => t.fitid && t.categoria)) {
        await pool.query(`
          UPDATE dre_lancamentos SET categoria=$1, grupo_dre=$2, ignorar=$3, atualizado_em=NOW()
          WHERE sessao_id=$4 AND fitid=$5
        `, [t.categoria, t.grupoKey||null, t.ignorar||false, sessaoId, t.fitid]);
      }
    } catch(e) {
      console.error('[dre/espelhar]', e.message);
    }
  }

  // Helper: extrai array de transações de qualquer formato (string, objeto, array)
  function extrairTransacoes(dados) {
    if (!dados) return [];
    // PostgreSQL JSONB já retorna objeto JS — não precisa de JSON.parse
    const obj = typeof dados === 'string' ? (() => { try { return JSON.parse(dados); } catch(_){ return []; } })() : dados;
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.transactions)) return obj.transactions;
    return [];
  }

  // ── Merge de transações — deduplicação por FITID ─────────────────────────
  // Preserva classificações existentes, adiciona novos lançamentos
  function mergeTransacoes(existentes, novos) {
    if (!Array.isArray(existentes)) existentes = [];
    if (!Array.isArray(novos)) return existentes;

    // Índice dos existentes por FITID
    const porFitid = {};
    for (const t of existentes) {
      if (t.fitid) porFitid[t.fitid] = t;
    }

    // Hash para lançamentos sem FITID
    function hashSemFitid(t) {
      return `${t.data||''}_${t.valor||''}_${(t.lancamento||'').slice(0,30)}`;
    }
    const porHash = {};
    for (const t of existentes) {
      if (!t.fitid) porHash[hashSemFitid(t)] = t;
    }

    // Começa com existentes mas atualiza com novos que têm classificação
    // REGRA: novo com categoria > existente sem categoria (preserva classificações feitas)
    const resultado = [...existentes];
    let novosAdicionados = 0, atualizados = 0, duplicatasIgnoradas = 0;

    for (const t of novos) {
      if (t.fitid) {
        const idx = resultado.findIndex(x => x.fitid === t.fitid);
        if (idx >= 0) {
          // Já existe — atualiza categoria/ignorar se o novo tiver classificação
          if (t.categoria && !resultado[idx].categoria) {
            resultado[idx] = { ...resultado[idx], categoria: t.categoria, grupoKey: t.grupoKey, ignorar: t.ignorar };
            atualizados++;
          } else if (t.categoria && resultado[idx].categoria !== t.categoria) {
            // Usuário mudou a classificação — novo tem prioridade
            resultado[idx] = { ...resultado[idx], categoria: t.categoria, grupoKey: t.grupoKey };
            atualizados++;
          } else {
            duplicatasIgnoradas++;
          }
        } else {
          resultado.push(t);
          porFitid[t.fitid] = t;
          novosAdicionados++;
        }
      } else {
        const h = hashSemFitid(t);
        const idx = resultado.findIndex(x => !x.fitid && hashSemFitid(x) === h);
        if (idx >= 0) {
          if (t.categoria && resultado[idx].categoria !== t.categoria) {
            resultado[idx] = { ...resultado[idx], categoria: t.categoria, grupoKey: t.grupoKey };
            atualizados++;
          } else {
            duplicatasIgnoradas++;
          }
        } else {
          resultado.push(t);
          porHash[h] = t;
          novosAdicionados++;
        }
      }
    }

    console.log(`[dre/merge] ${existentes.length} exist + ${novos.length} novos → ${resultado.length} total (${novosAdicionados} add, ${atualizados} atualiz, ${duplicatasIgnoradas} dup)`);
    return resultado;
  }

  // ── POST /salvar ───────────────────────────────────────────────────────────
  r.post('/salvar', async (req, res) => {
    const { sessao_id, mes_ref, descricao, dados_json } = req.body;
    if (!mes_ref) return res.status(400).json({ ok: false, erro: 'mes_ref obrigatório' });
    try {
      const uid = req.user?.id || null;
      // ESTRATÉGIA: frontend é a fonte da verdade para classificações.
      // O banco pode ter lançamentos extras (de outros imports) que o frontend não tem.
      // Merge: começa com o que o frontend enviou (com todas as classificações),
      // e adiciona apenas lançamentos do banco que o frontend não conhece.
      function mergeComFrontendPrioritario(txsDoFrontend, txsDoBanco) {
        if (!Array.isArray(txsDoBanco) || txsDoBanco.length === 0) return txsDoFrontend;
        if (!Array.isArray(txsDoFrontend) || txsDoFrontend.length === 0) return txsDoBanco;

        // IDs conhecidos pelo frontend
        const fitidsFront = new Set(txsDoFrontend.filter(t=>t.fitid).map(t=>t.fitid));
        function hashT(t){ return `${t.data||''}_${t.valor||''}_${(t.lancamento||'').slice(0,30)}`; }
        const hashesFront = new Set(txsDoFrontend.filter(t=>!t.fitid).map(t=>hashT(t)));

        // Adiciona do banco apenas o que o frontend não tem
        const extras = txsDoBanco.filter(t => {
          if (t.fitid) return !fitidsFront.has(t.fitid);
          return !hashesFront.has(hashT(t));
        });

        console.log(`[dre/merge] frontend=${txsDoFrontend.length} banco=${txsDoBanco.length} extras=${extras.length}`);
        return [...txsDoFrontend, ...extras];
      }

      let rows;
      if (sessao_id) {
        const cur = await pool.query(`SELECT dados_json FROM dre_sessoes WHERE id=$1`, [sessao_id]);
        const txsFront = extrairTransacoes(dados_json);
        const txsBanco = extrairTransacoes(cur.rows[0]?.dados_json);
        const txsMerge = mergeComFrontendPrioritario(txsFront, txsBanco);
        const dadosMerge = { ...(typeof dados_json === 'object' && !Array.isArray(dados_json) ? dados_json : {}), transactions: txsMerge };
        const upd = await pool.query(`
          UPDATE dre_sessoes SET descricao=$1, dados_json=$2, atualizado_em=NOW()
          WHERE id=$3 RETURNING id
        `, [descricao || `Sessão ${mes_ref}`, JSON.stringify(dadosMerge), sessao_id]);
        if (upd.rows.length) { rows = upd.rows; }
      }
      if (!rows || !rows.length) {
        const existing = await pool.query(
          `SELECT id FROM dre_sessoes WHERE mes_ref=$1 AND (usuario_id=$2 OR usuario_id IS NULL) ORDER BY atualizado_em DESC LIMIT 1`,
          [mes_ref, uid]
        );
        if (existing.rows.length) {
          const cur2 = await pool.query(`SELECT dados_json FROM dre_sessoes WHERE id=$1`, [existing.rows[0].id]);
          const txsFront2 = extrairTransacoes(dados_json);
          const txsBanco2 = extrairTransacoes(cur2.rows[0]?.dados_json);
          const txsMerge2 = mergeComFrontendPrioritario(txsFront2, txsBanco2);
          const dadosMerge2 = { ...(typeof dados_json === 'object' && !Array.isArray(dados_json) ? dados_json : {}), transactions: txsMerge2 };
          const upd = await pool.query(`
            UPDATE dre_sessoes SET descricao=$1, dados_json=$2, usuario_id=$3, atualizado_em=NOW()
            WHERE id=$4 RETURNING id
          `, [descricao || `Sessão ${mes_ref}`, JSON.stringify(dadosMerge2), uid, existing.rows[0].id]);
          rows = upd.rows;
        } else {
          const ins = await pool.query(`
            INSERT INTO dre_sessoes (mes_ref, descricao, dados_json, usuario_id)
            VALUES ($1, $2, $3, $4) RETURNING id
          `, [mes_ref, descricao || `Sessão ${mes_ref}`, JSON.stringify(dados_json), uid]);
          rows = ins.rows;
        }
      }
      const sid = rows[0]?.id;
      if (sid) {
        espelharLancamentos(sid, extrairTransacoes(dados_json)).catch(()=>{});
      }
      res.json({ ok: true, sessao_id: sid });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /recuperar/:mes — reconstrói sessão a partir da tabela dre_lancamentos
  r.post('/recuperar/:mes', async (req, res) => {
    try {
      const mes = decodeURIComponent(req.params.mes);
      // Busca sessão ou cria nova
      let sessao = await pool.query(
        `SELECT id, dados_json FROM dre_sessoes WHERE mes_ref=$1 ORDER BY atualizado_em DESC LIMIT 1`, [mes]
      );
      let sessaoId;
      if (!sessao.rows.length) {
        const ins = await pool.query(
          `INSERT INTO dre_sessoes (mes_ref, descricao) VALUES ($1,$2) RETURNING id`,
          [mes, `Sessão ${mes} — recuperada da tabela`]
        );
        sessaoId = ins.rows[0].id;
      } else {
        sessaoId = sessao.rows[0].id;
      }
      // Busca todos os lançamentos salvos na tabela
      const { rows } = await pool.query(
        `SELECT * FROM dre_lancamentos WHERE sessao_id=$1 ORDER BY data_lanc ASC, id ASC`,
        [sessaoId]
      );
      if (!rows.length) {
        // Tenta por mês sem sessão específica
        const { rows: r2 } = await pool.query(
          `SELECT dl.* FROM dre_lancamentos dl
           JOIN dre_sessoes ds ON ds.id=dl.sessao_id
           WHERE dl.mes=$1 ORDER BY dl.data_lanc ASC, dl.id ASC`, [mes]
        );
        if (!r2.length) return res.json({ ok: false, erro: 'Nenhum lançamento encontrado na tabela para este mês' });
        rows.push(...r2);
      }
      // Reconstrói o formato que o frontend espera
      const transactions = rows.map(r => ({
        id: r.id,
        fitid: r.fitid||null,
        lancamento: r.lancamento,
        razaoSocial: r.razao_social||'',
        valor: parseFloat(r.valor||0),
        data: r.data_lanc||'',
        mes: r.mes||mes,
        mesCaixa: r.mes_caixa||r.mes||mes,
        fonte: r.fonte||'EXTRATO',
        categoria: r.categoria||'',
        grupoKey: r.grupo_dre||'',
        ignorar: r.ignorar||false,
        portador: r.portador||'',
      }));
      // Reconstrói e salva o dados_json
      const dadosJson = { transactions, loadedFiles:[], supplierMem:{}, _recoveredAt: new Date().toISOString() };
      await pool.query(
        `UPDATE dre_sessoes SET dados_json=$1, descricao=$2, atualizado_em=NOW() WHERE id=$3`,
        [JSON.stringify(dadosJson), `Sessão ${mes} — ${transactions.length} lançamentos (recuperado)`, sessaoId]
      );
      res.json({ ok: true, sessao_id: sessaoId, total: transactions.length, transactions });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /lancamentos/:mes — lançamentos salvos na tabela (backup seguro) ────
  r.get('/lancamentos/:mes', async (req, res) => {
    try {
      const mes = decodeURIComponent(req.params.mes); // ex: "03/2026"
      const { rows } = await pool.query(`
        SELECT dl.*, ds.mes_ref, ds.descricao AS sessao_desc
        FROM dre_lancamentos dl
        JOIN dre_sessoes ds ON ds.id = dl.sessao_id
        WHERE dl.mes = $1
        ORDER BY dl.data_lanc ASC, dl.id ASC
      `, [mes]);
      res.json({ ok: true, data: rows, total: rows.length });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /salvar-beacon — chamado pelo sendBeacon ao fechar a aba ──────────
  // sendBeacon não envia headers de autenticação facilmente, usamos body
  r.post('/salvar-beacon', async (req, res) => {
    try {
      const { sessao_id, mes_ref, dados_json } = req.body;
      if (!mes_ref || !dados_json) return res.sendStatus(204);
      const descricao = `Sessão ${mes_ref} — auto-save ao fechar`;
      if (sessao_id) {
        const cur = await pool.query(`SELECT dados_json FROM dre_sessoes WHERE id=$1`, [sessao_id]);
        const txsB = extrairTransacoes(cur.rows[0]?.dados_json);
        const txsNovosB = extrairTransacoes(dados_json);
        const merge = txsNovosB.length > 0 ? mergeTransacoes(txsB, txsNovosB) : (txsB.length > 0 ? txsB : txsNovosB);
        await pool.query(
          `UPDATE dre_sessoes SET dados_json=$1, atualizado_em=NOW() WHERE id=$2`,
          [JSON.stringify({...dados_json, transactions: merge}), sessao_id]
        );
        espelharLancamentos(sessao_id, merge).catch(()=>{});
      } else {
        const existing = await pool.query(
          `SELECT id FROM dre_sessoes WHERE mes_ref=$1 ORDER BY atualizado_em DESC LIMIT 1`, [mes_ref]
        );
        if (existing.rows.length) {
          await pool.query(
            `UPDATE dre_sessoes SET dados_json=$1, atualizado_em=NOW() WHERE id=$2`,
            [JSON.stringify(dados_json), existing.rows[0].id]
          );
          espelharLancamentos(existing.rows[0].id, dados_json?.transactions||[]).catch(()=>{});
        }
      }
      res.sendStatus(204);
    } catch(e) { console.error('[dre/beacon]', e.message); res.sendStatus(204); }
  });

  // ── DELETE /sessoes/:id ────────────────────────────────────────────────────
  r.delete('/sessoes/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM dre_sessoes WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import-extrato ───────────────────────────────────────────────────
  r.post('/import-extrato', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });

    try {
      const ext  = (req.file.originalname || '').split('.').pop().toLowerCase();
      let lancamentos = [];

      if (ext === 'ofx' || ext === 'ofc') {
        // Parse OFX (texto estruturado)
        const rawLancs = parseOFX(req.file.buffer.toString('utf8'));
      // Enriquece com nome do fornecedor via CNPJ da tabela de lookup
      lancamentos = await Promise.all(rawLancs.map(async l => {
        if (l.cnpjDoc) {
          try {
            const { rows } = await pool.query(
              `SELECT nome FROM fornecedores_lookup WHERE cnpj_num=$1 LIMIT 1`, [l.cnpjDoc]
            );
            if (rows.length) l.razaoSocial = rows[0].nome;
          } catch(_) {}
        }
        return l;
      }));
      } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        // Parse XLSX / CSV
        lancamentos = parseXLSXExtrato(req.file.buffer, ext);
      } else {
        return res.status(422).json({ ok: false, erro: 'Formato não suportado. Use XLSX, CSV ou OFX.' });
      }

      if (!lancamentos.length) {
        return res.status(422).json({ ok: false, erro: 'Nenhum lançamento encontrado no arquivo.' });
      }

      // ── Auto-baixa de boletos: se lançamento do extrato bate com boleto pelo valor ──
      let boletosQuitados = 0;
      const lancamentosComBoleto = [];
      for (const l of lancamentos) {
        if (!l.valor || parseFloat(l.valor) >= 0) continue; // só débitos
        const valorCentavos = Math.round(Math.abs(parseFloat(l.valor)) * 100);
        if (!valorCentavos) continue;

        try {
          // Busca boletos em aberto com valor próximo (±1 centavo) e data de vencimento próxima
          const { rows: boletos } = await pool.query(`
            SELECT id, valor, vencimento, fornecedor
            FROM boletos
            WHERE status IN ('avencer','vencido')
              AND ABS(ROUND(valor::numeric * 100) - $1) <= 1
              AND (vencimento IS NULL OR vencimento <= CURRENT_DATE + INTERVAL '60 days')
            ORDER BY ABS(ROUND(valor::numeric * 100) - $1) ASC, vencimento ASC
            LIMIT 1
          `, [valorCentavos]);

          if (boletos.length) {
            const boleto = boletos[0];
            const dtPag = l.data || new Date().toISOString().slice(0,10);
            await pool.query(`
              UPDATE boletos SET
                status = 'pago',
                dt_pagamento = $1::date,
                vinculado_extrato = true,
                extrato_lancamento = $2,
                atualizado_em = NOW()
              WHERE id = $3
            `, [dtPag, l.lancamento || l.memo || '', boleto.id]);
            boletosQuitados++;
            lancamentosComBoleto.push({ lancamento: l, boletoId: boleto.id });
            // Marca o lançamento com o boletoId para deduplicação no frontend
            l.boletoId = boleto.id;
            l.categoria = l.categoria || 'BOLETO PAGO';
          }
        } catch(e) {
          console.warn('[dre/import-extrato] auto-baixa boleto:', e.message);
        }
      }

      // Verifica sessão existente do mês para informar sobre possíveis duplicatas
      const mesImport = lancamentos[0]?.mes || '';
      let duplicatasEstimadas = 0;
      if (mesImport) {
        const sessaoExist = await pool.query(
          `SELECT dados_json FROM dre_sessoes WHERE mes_ref=$1 ORDER BY atualizado_em DESC LIMIT 1`,
          [mesImport]
        ).catch(()=>({ rows: [] }));
        if (sessaoExist.rows.length) {
          const txExist = extrairTransacoes(sessaoExist.rows[0].dados_json);
          const fitidsExist = new Set(txExist.filter(t=>t.fitid).map(t=>t.fitid));
          duplicatasEstimadas = lancamentos.filter(l => l.fitid && fitidsExist.has(l.fitid)).length;
        }
      }
      res.json({ ok: true, lancamentos, total: lancamentos.length, duplicatasEstimadas, boletosQuitados });
    } catch (e) {
      console.error('[dre/import-extrato]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro ao processar arquivo: ' + e.message });
    }
  });

  // ── GET /relatorio/:mes ────────────────────────────────────────────────────
  r.get('/relatorio/:mes', async (req, res) => {
    try {
      const mes = req.params.mes; // MM/YYYY
      const { rows } = await pool.query(
        `SELECT dados_json FROM dre_sessoes WHERE mes_ref = $1 ORDER BY atualizado_em DESC LIMIT 1`,
        [mes]
      );

      if (!rows.length || !rows[0].dados_json) {
        return res.status(404).json({ ok: false, erro: 'Nenhuma sessão encontrada para este mês' });
      }

      const dados   = rows[0].dados_json;
      const txs     = (dados.transactions || []).filter(t => !t.ignorar);

      // Estrutura DRE padrão
      const estrutura = buildDRE(txs);
      res.json({ ok: true, mes, data: estrutura });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function parseOFX(text) {
    // Prefixos de operação bancária — o que vem após é o favorecido
    const OFX_PREF = [
      'PAGAMENTOS PIX QR-CODE','PAGAMENTOS PIX','PAGAMENTOS TRANSF CC ITAU','PAGAMENTOS TRANSF CC',
      'PAGAMENTOS TRANSF','PAGAMENTOS BOLETO','PAGAMENTOS ',
      'PIX RECEBIDO','PIX ENVIADO','PIX QR CODE RECEBIDO','PIX QR CODE',
      'TED RECEBIDA','TED ENVIADA','DOC RECEBIDO','DOC ENVIADO',
      'RECEBIMENTO REDE','RECEBIMENTOS','RECEBIMENTO',
      'DEBITO AUTOMATICO','DEBITO EM CONTA',
      'TRANSFERENCIA ENTRE CONTAS','TRANSFERENCIA',
    ];
    function splitMemo(memo) {
      // 1. CNPJ/CPF no final — extrai razão social do bloco antes do doc
      const docRe = /^(.*?)\s+([A-Z][A-Z0-9 .&'\/\-]{3,}?)\s+(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\s*$/;
      const dm = docRe.exec(memo);
      if (dm) {
        const lancamento  = dm[1].trim();
        const razaoRaw    = dm[2].trim();
        const cnpjDoc     = dm[3].replace(/\D/g, ''); // só dígitos para lookup
        const razaoSocial = razaoRaw.replace(/^(PAGO|ENVIADO|DEVOLVIDO|RECEBIDO|DA)\s+/i, '').trim();
        return { lancamento, razaoSocial, cnpjDoc };
      }
      // 2. Prefixo bancário conhecido
      const up = memo.toUpperCase();
      for (const p of OFX_PREF) {
        if (up.startsWith(p)) {
          const resto = memo.slice(p.length).trim();
          if (resto.length > 2) return { lancamento: p.trim(), razaoSocial: resto, cnpjDoc: '' };
          break;
        }
      }
      return { lancamento: memo, razaoSocial: '', cnpjDoc: '' };
    }

    const txRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    const result  = [];
    let m;
    while ((m = txRegex.exec(text)) !== null) {
      const bloco = m[1];
      const get   = tag => { const r = bloco.match(new RegExp(`<${tag}>([^<\\n\\r]+)`)); return r ? r[1].trim() : ''; };
      const dtRaw = get('DTPOSTED');
      const dt    = dtRaw.length >= 8 ? `${dtRaw.slice(0,4)}-${dtRaw.slice(4,6)}-${dtRaw.slice(6,8)}` : '';
      const val   = parseFloat(get('TRNAMT').replace(',', '.')) || 0;
      const memo  = get('MEMO') || get('NAME') || 'Lançamento';
      if (!val) continue;
      const mes = dt ? dt.slice(5,7) + '/' + dt.slice(0,4) : '';
      const { lancamento, razaoSocial, cnpjDoc } = splitMemo(memo);
      const fitid = get('FITID') || get('CHECKNUM') || '';
      result.push({ lancamento, razaoSocial, cnpjDoc, valor: val, data: dt, mes, mesCaixa: mes, fonte: 'EXTRATO', categoria: '', fitid });
    }
    return result;
  }

  function parseXLSXExtrato(buffer, ext) {
    const wb    = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length < 2) return [];

    // Detecta cabeçalho
    const header = rows[0].map(c => String(c).toLowerCase().trim());
    const iCol = (nomes) => {
      for (const n of nomes) {
        const i = header.findIndex(h => h.includes(n));
        if (i >= 0) return i;
      }
      return -1;
    };

    const colData  = iCol(['data', 'date', 'dt']);
    const colDesc  = iCol(['histórico', 'historico', 'descri', 'memo', 'lancamento', 'lançamento']);
    const colVal   = iCol(['valor', 'value', 'montante', 'quantia']);
    const colCred  = iCol(['crédito', 'credito', 'entrada', 'credit']);
    const colDeb   = iCol(['débito', 'debito', 'saída', 'saida', 'debit']);

    const result = [];
    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const desc = String(row[colDesc] ?? '').trim();
      if (!desc) continue;

      let val = 0;
      if (colVal >= 0) {
        val = parseFloat(String(row[colVal]).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
      } else if (colCred >= 0 || colDeb >= 0) {
        const cred = parseFloat(String(row[colCred] ?? '0').replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
        const deb  = parseFloat(String(row[colDeb]  ?? '0').replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
        val = cred > 0 ? cred : -deb;
      }

      if (val === 0) continue;

      let dtStr = '';
      if (colData >= 0 && row[colData]) {
        const d = row[colData];
        if (d instanceof Date) {
          dtStr = d.toISOString().slice(0, 10);
        } else {
          // tenta parsear DD/MM/YYYY
          const parts = String(d).split('/');
          if (parts.length === 3) dtStr = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
          else dtStr = String(d).slice(0, 10);
        }
      }

      const mes = dtStr ? dtStr.slice(5, 7) + '/' + dtStr.slice(0, 4) : '';
      result.push({ lancamento: desc, valor: val, data: dtStr, mes, mesCaixa: mes, fonte: 'EXTRATO', categoria: '' });
    }
    return result;
  }

  function buildDRE(txs) {
    const grupos = {};
    for (const t of txs) {
      const cat = t.categoria || 'Sem categoria';
      if (!grupos[cat]) grupos[cat] = { total: 0, lancamentos: [] };
      grupos[cat].total += parseFloat(t.valor || 0);
      grupos[cat].lancamentos.push(t);
    }

    const receitas  = Object.entries(grupos).filter(([,v]) => v.total > 0);
    const despesas  = Object.entries(grupos).filter(([,v]) => v.total < 0);
    const totRec    = receitas.reduce((s, [,v]) => s + v.total, 0);
    const totDesp   = despesas.reduce((s, [,v]) => s + Math.abs(v.total), 0);

    return {
      receitas:  receitas.map(([cat, v]) => ({ categoria: cat, total: v.total, lancamentos: v.lancamentos })),
      despesas:  despesas.map(([cat, v]) => ({ categoria: cat, total: Math.abs(v.total), lancamentos: v.lancamentos })),
      totalReceitas:  totRec,
      totalDespesas:  totDesp,
      resultado:      totRec - totDesp,
      margemBruta:    totRec > 0 ? (((totRec - totDesp) / totRec) * 100).toFixed(2) : '0.00',
    };
  }

  return r;
};
