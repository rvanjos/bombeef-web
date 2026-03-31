// Seed histórico de perdas — importado de CONTROLE_DE_VENCIDOS
const SEED_PERDAS = [
  ['ALHO AREIA 60GR','vencimento',5,'2025-09-12','09/2025','Ação: Colocar para usar nos temperados - VOU SEPARAR - JIU']
  ['BRISKET PREMIUM DEFUMADO SAM WILSON','vencimento',10,'2025-09-12','09/2025','Ação: R$ 44,90 / Dany feito 30/08/2025']
  ['CERVEJA BUDWEISER ZERO 350ML','vencimento',5,'2025-09-17','09/2025','Ação: Baixar valor para R$ 4,99 - ALTERADO 11/09 JIU']
  ['CHÁ MATTE LEÃO COM GÁS LIMÃO 290ML','vencimento',1,'2025-09-19','09/2025',null]
  ['FILÉ MIGNON MONTANA STEAKHOUSE','vencimento',2,'2025-08-05','08/2025','Ação: Trazer para casa da iza fatiado | Destino: COPA']
  ['CERVEJA MICHELOB ULTRA LONG NECK 330ML','vencimento',5,'2025-08-09','08/2025','Destino: COPA']
  ['CERVEJA BUDWEISER SUPREME 330ML LONG NECK','vencimento',14,'2025-08-10','08/2025','Destino: COPA']
  ['SUCO DEL VALLE GOIABA 290ML','vencimento',2,'2025-08-11','08/2025','Destino: COPA']
  ['ÁGUA CRYSTAL AROMATIZADA MELANCIA 510ML','vencimento',2,'2025-08-11','08/2025','Destino: COPA']
  ['FAROFA TAMARA C/CASTANHA DO PARÁ 250GR JOAQUINA VPJ','vencimento',1,'2025-08-11','08/2025','Destino: COPA']
  ['MAMINHA MONTANA STEAKHOUSE','vencimento',1,'2025-08-11','08/2025','Ação: Trazer para casa da iza fatiado | Destino: COPA']
  ['LINGUIÇA COM ALHO SPECIALLI','vencimento',1,'2025-08-16','08/2025','Destino: FUTEBOL']
  ['LINGUIÇA MEDITERRÂNEA CORDEIRO SPECIALLI','vencimento',3,'2025-08-16','08/2025','Ação: promoção, baixar 10% , Dany R$ 43,90 13/08/2025 | Destino: COPA']
  ['LINGUIÇA COM PIMENTA BIQUINHO SPECIALLI','vencimento',8,'2025-08-16','08/2025','Ação: colocar 39,90 (HOJE, Não pode esperar pra colocar amanhã)   Dany 13/08 | Destino: FUTEBOL']
  ['FRALDA COM GORDURA PUL','vencimento',9,'2025-08-17','08/2025','Ação: fazer fralda RED | Destino: FUTEBOL']
  ['MAIONESE 350GR PRONI','vencimento',1,'2025-08-19','08/2025','Destino: COPA']
  ['MAIONESE 350GR PRONI','vencimento',1,'2025-08-19','08/2025','Destino: COPA - AZEDOU']
  ['TORRESMO DE ROLO PREMIUM AURORA','vencimento',5,'2025-08-20','08/2025','Ação: promoção, baixar 10%   Dany R$ 71,90  13/08/2025 | Destino: COPA']
  ['SAL PARA PIPOCA SABOR PICANHA CANTAGALLO','vencimento',2,'2025-08-22','08/2025','Ação: Separar pra mim | Destino: RAFAEL']
  ['LINGUIÇA TEX MEX SPECIALLI','vencimento',1,'2025-08-23','08/2025','Ação: Colocar 34,90 | Destino: COPA']
  ['FAROFA DE CEBOLA 250GR JOAQUINA VPJ','vencimento',1,'2025-08-24','08/2025','Ação: Colocar no caixa para vender e baixar preço 18,90, Dany 13/08/2025 | Destino: COPA']
  ['TÔNICA SCHWEPPES 350ML LATA','vencimento',6,'2025-08-24','08/2025',null]
  ['FAROFA DE LEMON PEPPER 250GR JOAQUINA VPJ','vencimento',7,'2025-08-24','08/2025','Ação: Colocar no caixa para vender e baixar preço 18,90, Dany 13/08/2025 | Destino: COPA']
  ['ÁGUA CRYSTAL 1,5LITROS C/GÁS PET','vencimento',4,'2025-08-25','08/2025','Destino: COPA']
  ['SCHWEPPES CITRUS ORIGINAL 2LT PET','vencimento',1,'2025-08-25','08/2025','Ação: Separar pra mim | Destino: RAFAEL']
  ['BOMBOM DA ALCATRA RESERVA ESPECIAL NETÃO BEST BEEF','vencimento',5,'2025-08-25','08/2025','Ação: Oferecer primeiro em todas as vendas | Destino: JIU - 2 FATIADO 2']
  ['DOCE DE LEITE BARDERA 410GR','vencimento',3,'2025-08-29','08/2025','Ação: Separar e tirar da loja / No armario da copa Dany | Destino: COPA']
  ['MAIONESE 350GR PRONI','vencimento',2,'2025-08-29','08/2025','Ação: Separar e tirar da loja / na geladeira da copa  Dany | Destino: COPA']
  ['PICANHA BBQ','vencimento',2,'2025-08-31','08/2025','Ação: Separar/resfriado | Destino: COPA']
  ['PICANHA SUÍNA MOSTARDA E MEL SAM WILSON','vencimento',6,'2025-09-03','09/2025','Ação: Separar | Destino: COPA']
  ['CHORIZO(CONTRA FILÉ) GRILL BEST BEEF','vencimento',3,'2025-09-04','09/2025','Ação: Não tinha fatiado tudo já??? TINHA COLOCADO PRA FATIAR. | Destino: COPA']
  ['PICANHA ESTANCIA 92','vencimento',1,'2025-09-22','09/2025','Ação: COLOCAR 149,90 O KG - OK JIU 19/09 | Destino: COPA']
  ['PICOLÉ NESTLÉ LA FRUTA MANGA','vencimento',12,'2025-09-30','09/2025','Ação: Brinde para as crianças que passarem no açougue | Destino: COPA']
  ['LINGUIÇA SUÍNA ERVAS FINAS 500GR DE BRAGA','vencimento',2,'2025-10-06','10/2025','Ação: FATIAR NO FINAL DE SEMANA (COLOCAR 92,90) | Destino: COPA']
  ['ÁGUA TONICA 350ML','vencimento',6,'2025-10-12','10/2025','Destino: COPA']
  ['DENVER TAURUS GUIDARA','vencimento',7,'2025-10-12','10/2025','Ação: Acompanhar diariamente a quantidade, atualizar a lista desse item todos os dias']
  ['LICOR BARDERA BANOFFEE','vencimento',0,'2025-10-18','10/2025','Ação: brinde se comprar acima de 500,00']
  ['MONSTER MANGO LOCO 269ML','vencimento',1,'2025-10-19','10/2025','Ação: Dar de brinde para algum cliente que comprar acima de 250,00 | Destino: COPA']
  ['CHORIZO GRILL GUIDARA','vencimento',2,'2025-10-23','10/2025','Ação: Acompanhar diariA a qte, atualizar todos os dias- VENCEU 02(1,722)']
  ['LINGUIÇA FINA DUROC MAIALE FABENE','vencimento',3,'2025-10-23','10/2025','Ação: Acompanhar diaria qte, atualizar todos os dias-VENCEU 03 (1,252)']
  ['CHORIZO RESERVA ESPECIAL NETÃO GUIDARA','vencimento',2,'2025-10-25','10/2025','Ação: Acompanhar diaria qte, atualizar todos os dias-VENCEU 2(2,712KG)']
  ['LINGUIÇA MINEIRA FRANGO COM QUEIJO COALHO SPECIALLI','vencimento',1,'2025-10-25','10/2025','Ação: Acompanhar para não vencer - VENCEU 01 PÇ']
  ['ÁGUA CRYSTAL COM GÁS 500ML','vencimento',7,'2025-10-28','10/2025','Ação: colocar a 3,00 | Destino: COPA']
  ['KIT KAT CONE SORVETE NESTLÉ  -  bonificação','vencimento',3,'2025-10-30','10/2025','Ação: Acompanhar diariamente a quantidade, atualizar a lista desse item todos os dias | Destino: ANA LUIZA']
  ['PICOLÉ LAFRUTA LIMÃO NESTLÉ','vencimento',15,'2025-10-30','10/2025','Ação: Acompanhar diariamente a quantidade, atualizar a lista desse item todos os dias | Destino: ANA LUIZA']
  ['PUDIM DAS GALÁXIAS PISTACHE','vencimento',9,'2025-10-30','10/2025','Ação: Acompanhar diariamente a quantidade, atualizar a lista desse item todos os dias | Destino: ANA LUIZA']
  ['PUDIM DAS GALÁXIAS LEITE CONDENSADO','vencimento',3,'2025-10-31','10/2025','Destino: ANA LUIZA']
  ['PICANHA BBQ','vencimento',3,'2025-11-01','11/2025','Ação: Colocar 129,90, marcar na placa la fora e oferecer | Destino: FATIADO - COPA']
  ['ANCHO BBQ','vencimento',1,'2025-11-03','11/2025','Destino: FATIAR COPA']
  ['LINGUIÇA TOSCANA 400GR SPECIALLI','vencimento',9,'2025-11-08','11/2025','Ação: colocar 19,90 / Dany 06/11/2025 | Destino: Geladeira do Estoque']
  ['ÁGUA COM GÁS 500ML','vencimento',6,'2025-11-13','11/2025','Destino: COPA']
  ['LINGUIÇA CANASTRA FINA DUROC FABENE','vencimento',3,'2025-11-15','11/2025','Ação: Podemos fazer promoção de quarta com ela  ou montar 1 kit churrasco | Destino: COPA']
  ['LINGUIÇA DUROC APIMENTADA FABENE','vencimento',1,'2025-11-15','11/2025','Ação: Podemos fazer promoção de quarta com ela  ou montar 1 kit churrasco | Destino: COPA']
  ['SHOULDER ESTANCIA 92','vencimento',0,'2025-11-15','11/2025','Ação: FAZER 1 FLAT SÁBADO PRA DEIXAR PRONTO JÁ | Destino: COPA']
  ['CERVEJA THERESÓPOLIS 350ML LATA','vencimento',4,'2025-11-22','11/2025','Ação: Brinde para cliente que levar mais de 300,00 | Destino: COPA']
  ['ENTRECOTE FRIGOL CHEF','vencimento',3,'2025-11-28','11/2025','Ação: Fatiar e vender por 59,90 o kg, fazer pacote com 2 bifes | Destino: COPA']
  ['SCHWEPPES TÔNICA 350ML LATA','vencimento',6,'2025-12-03','12/2025','Destino: COPA']
  ['LINGUIÇA TEX MEX SPECIALLI','vencimento',3,'2025-12-06','12/2025','Ação: Vender no final de semana | Destino: COPA']
  ['FANTA LARANJA 2LT PET','vencimento',1,'2025-12-10','12/2025','Destino: COPA']
  ['MAMINHA RESERVA BLACK NETÃO WESSEL','vencimento',1,'2025-12-24','12/2025','Ação: Fatiar e colocar pra vender | Destino: COPA']
  ['CHORIZO RESERVA BLACK NETÃO WESSEL','vencimento',1,'2025-12-24','12/2025','Ação: Fatiar e colocar pra vender | Destino: COPA']
  ['BOM BEEF STEAK RES BLACK NETÃO WESSEL - RIBEYE CAP','vencimento',6,'2026-01-02','01/2026','Ação: Reembalar e colocar a 179,90 / 03/01/2026 Dany | Destino: ESTOQUE']
  ['CERVEJA PATAGONIA BOHEMIAN 350ML','vencimento',5,'2026-01-03','01/2026','Ação: Separar o que sobrou | Destino: COPA']
  ['LINGUIÇA TEX MEX BOM BEEF SPECIALLI','vencimento',2,'2026-01-03','01/2026','Ação: Congelar   -   FEITO | Destino: COPA CONGELADO']
  ['SCHWEPPES CITRUS 1,5LT PET','vencimento',1,'2026-01-06','01/2026','Ação: separar pra mim   -   NA COPA | Destino: COPA']
  ['ANCHO RESERVA ESPECIAL NETÃO EL HAJI','vencimento',0,'2026-01-09','01/2026','Ação: Fatiar | Destino: COPA']
  ['FANTA CHUCKY PUNCH 350ML LATA','vencimento',1,'2026-01-13','01/2026','Destino: COPA']
  ['BOM BEEF STEAK - RIBYE CAP - RESERVA NETÃO WESSEL','vencimento',13,'2026-01-25','01/2026','Ação: Colocar R$ 179,90 | Destino: CHEIRO FORTE-FAZER DIA-A-DIA']
  ['SAL PARRILLA E SALSA CRIOULA 250GR NETÃO - PAULINIA','vencimento',1,'2026-01-16','01/2026','Ação: Esse estava na planilha? | Destino: COPA']
  ['FRALDA RED PUL SELECTION','vencimento',3,'2026-01-26','01/2026','Ação: abrir e reembalar se estiverem boas']
  ['MOLHO AMERICANO BURGUER 350GR MANTARELLA','vencimento',2,'2026-01-30','01/2026','Destino: COPA']
  ['ICE TEA LIMÃO PET 450ML CHÁ LEÃO','vencimento',1,'2026-02-02','02/2026','Destino: COPA']
  ['ICE TEA PESSEGO LEÃO 450ML','vencimento',2,'2026-02-02','02/2026','Destino: COPA']
  ['CEBOLA AREIA 40GR CANTAGALLO','vencimento',2,'2026-02-13','02/2026','Ação: Separar para temperados | Destino: COPA']
  ['CERVEJA EISENBAHN INFILTERED LONG NECK 355ML','vencimento',8,'2026-02-24','02/2026','Ação: Colocar no kit nacional primeiro | Destino: COPA']
  ['PICANHA RESERVA ESPECIAL NETÃO BEST BEFF','vencimento',4,'2026-02-26','02/2026','Ação: Vendeu no Domingo | Destino: COPA']
  ['KETCHUP GRILL 400GR MANTARELLA','vencimento',1,'2026-02-28','02/2026','Ação: Estava para venda no domingo, precisa identificar vencido quando tirar da venda | Destino: ARMÁRIO COPA']
  ['OREO SANDUICHE NESTLE','vencimento',8,'2026-02-28','02/2026','Ação: Vendedora retirou, para mandar bonificação dia 20/02/2026 | Destino: DEVOLVIDO']
  ['BERINJELA ITALIANA 350GR PRONI','vencimento',5,'2026-03-05','03/2026','Ação: Descartar dia 05/03 | Destino: DESCARTADO 7/3/25']
  ['LINGUIÇA PANCETA BOM BEEF SPECIALLI','vencimento',2,'2026-03-07','03/2026','Ação: Desconto de 20% | Destino: Troquei embalagem']
  ['PICANHA BBQ','vencimento',1,'2026-03-08','03/2026','Ação: Promoção | Destino: Na Geladeira do Estoque/ fatiando 1 peça por vez']
  ['CHORIZO RESERVA BLACK NETÃO WESSEL','vencimento',8,'2026-03-08','03/2026','Ação: Fatiar para vender sábado e domingo | Destino: Na Geladeira do Estoque/ fatiando 1 peça por vez']
  ['BRISKET RESERVA NETÃO HALAL','vencimento',5,'2026-03-09','03/2026','Ação: Fatiar para vender sábado e domingo | Destino: Na Geladeira do Estoque/ fatiando 1 peça por vez']
  ['CHORIZO BBQ BLACK','vencimento',8,'2026-03-09','03/2026','Ação: Fatiar para vender sábado e domingo | Destino: Na Geladeira do Estoque/ fatiando 1 peça por vez']
  ['MAMINHA DA ALCATRA BBQ','vencimento',1,'2026-03-17','03/2026','Destino: COPA']
];

async function seedPerdas(pool) {
  let ok = 0, skip = 0;
  for (const [desc, motivo, qtd, dt, mes, obs] of SEED_PERDAS) {
    // Evita duplicata: mesmo produto + mesma data
    const ex = await pool.query(
      `SELECT id FROM perdas WHERE descricao=$1 AND dt_perda=$2::date LIMIT 1`,
      [desc, dt]
    );
    if (ex.rows.length) { skip++; continue; }
    await pool.query(
      `INSERT INTO perdas (descricao, motivo, qtd_unidades, dt_perda, mes, observacao)
       VALUES ($1,$2,$3,$4::date,$5,$6)`,
      [desc, motivo, qtd, dt, mes, obs]
    );
    ok++;
  }
  console.log(`[seed-perdas] ${ok} inseridos, ${skip} já existiam`);
  return { ok, skip };
}

module.exports = seedPerdas;
