(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.DRECartaoC6=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const meses={jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12};
  const normalizar=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const centavos=s=>Math.round(Number(s.replace(/\./g,'').replace(',','.'))*100);

  // Apenas linhas da seção de transações. Resumo, limites e boleto não são despesas.
  function interpretar(texto){
    const linhas=String(texto).split(/\r?\n/).map(s=>s.trim());
    if(!/c6\s*(?:ban\s*k|carbon)/i.test(texto))throw Error('A leitura por imagem ainda requer uma fatura C6 identificável.');
    const venc=String(texto).match(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/);
    if(!venc)throw Error('Não foi possível conferir o ano de vencimento impresso no PDF.');
    const total=String(texto).match(/valor\s+da\s+fatura\s*:\s*R\$\s*([\d.]+,\d{2})/i);
    if(!total)throw Error('Não foi possível conferir o total impresso na fatura.');
    const totalCentavos=centavos(total[1]);
    let secao=false,cartao='',portador='';
    const itens=[],ocorrencias=new Map();
    for(const original of linhas){
      const n=normalizar(original);
      if(/transa.{0,6}es\s+d[oa]s?\s+cart/.test(n)){secao=true;continue;}
      if(/resumo da fatura|formas de pagamento|saldo obriga/.test(n)){secao=false;continue;}
      if(!secao)continue;
      const cab=original.match(/C6\s+Carbon(?:\s+Virtual)?\s+Final\s+(\d{4})\s*[-–]\s*(.+?)(?:\s+(?:Subtotal|[B©®]|Cart[aã][oõ])|$)/i);
      if(cab){cartao=cab[1];portador=cab[2].trim();continue;}
      // O OCR pode confundir zero com O nas datas e deixar ícones antes do dia.
      const m=original.match(/^.{0,8}?\b([\dOo]{1,3})\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|o[ou0]?ut|nov|dez)\s+(.+?)\s+([−–-]?\s*[\d.]+,\d{2})\s*$/i);
      if(!m||!cartao)continue;
      const descricao=m[3].replace(/^[^\p{L}\p{N}]+/u,'').replace(/\s+/g,' ').trim();
      if(/pag\s+fatura|pagamento\s+(?:da\s+)?fatura|obrigado\s+pelo\s+pagamento|total da fatura anterior/i.test(descricao))continue;
      const dia=Number(m[1].replace(/o/ig,'0'));
      const mes=meses[m[2].toLowerCase().startsWith('o')?'out':m[2].toLowerCase()];
      const ano=Number(venc[3])-(mes>Number(venc[2])?1:0);
      const data=ano+'-'+String(mes).padStart(2,'0')+'-'+String(dia).padStart(2,'0');
      if(!dia||new Date(data+'T12:00:00Z').toISOString().slice(0,10)!==data)throw Error('Data de compra ilegível. Confira o PDF.');
      const credito=/^[−–-]/.test(m[4])||/estorno|cashback|credito|desconto/i.test(normalizar(descricao));
      const valorCentavos=centavos(m[4].replace(/[−–-\s]/g,''))*(credito?-1:1);
      if(!Number.isSafeInteger(valorCentavos)||!valorCentavos)continue;
      const parcela=descricao.match(/parcela\s+(\d+)\s*\/\s*(\d+)/i);
      const chave=JSON.stringify([cartao,data,normalizar(descricao),valorCentavos]);
      const ordem=(ocorrencias.get(chave)||0)+1;ocorrencias.set(chave,ordem);
      itens.push({data,descricao,cartao,portador,valorCentavos,parcela:parcela?parcela[1]+'/'+parcela[2]:null,chave:chave+':'+ordem});
    }
    const somaCentavos=itens.reduce((s,i)=>s+i.valorCentavos,0);
    return {itens,totalCentavos,somaCentavos,conferenciaOk:itens.length>0&&somaCentavos===totalCentavos};
  }
  return {interpretar};
});
