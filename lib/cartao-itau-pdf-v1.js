'use strict';

const crypto = require('crypto');

function limpar(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function hash(v) { return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function numBR(v) {
  const s = String(v || '').replace(/R\$\s*/gi, '').replace(/\s+/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function dataISO(ddmm, competencia) {
  const m = String(ddmm || '').match(/^(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const [mesComp, anoComp] = String(competencia || '').split('/').map(Number);
  const dia = Number(m[1]), mes = Number(m[2]);
  const ano = mes > mesComp ? anoComp - 1 : anoComp;
  return `${ano}-${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
}
function parcelas(desc) {
  const m = String(desc || '').match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  return m ? { parcela_atual:Number(m[1]), parcelas_total:Number(m[2]) } : { parcela_atual:null, parcelas_total:null };
}
function agruparLinhas(items, toleranciaY = 2.5) {
  const toks = (items || []).map((it,idx)=>({texto:limpar(it.str),x:Number(it.transform?.[4]||0),y:Number(it.transform?.[5]||0),idx})).filter(t=>t.texto);
  toks.sort((a,b)=>b.y-a.y||a.x-b.x||a.idx-b.idx);
  const linhas=[];
  for (const t of toks) {
    let l=linhas.find(x=>Math.abs(x.y-t.y)<=toleranciaY);
    if(!l){l={y:t.y,tokens:[]};linhas.push(l)}
    l.tokens.push(t);
  }
  linhas.sort((a,b)=>b.y-a.y);
  return linhas.map(l=>{l.tokens.sort((a,b)=>a.x-b.x||a.idx-b.idx);return{y:l.y,tokens:l.tokens,texto:limpar(l.tokens.map(t=>t.texto).join(' '))}});
}
function textoPagina(items){return agruparLinhas(items,3).map(l=>l.texto).join('\n')}
function normalizarTexto(s){return String(s||'').replace(/(\d)\s*,\s*(\d{2})/g,'$1,$2').replace(/(\d{2})\/\s*(\d{2})\/\s*(\d{4})/g,'$1/$2/$3').replace(/\s+/g,' ')}

function acharCabecalho(paginas){
  const bruto=paginas.map(p=>textoPagina(p)).join('\n');
  const txt=normalizarTexto(bruto);
  if(!/Ita[uú]\s+(Empresas|Cart[oõ]es)|Banco Ita[uú]|itau\.com\.br\/empresas\/cartoes/i.test(txt)) return {ok:false,codigo:'FORMATO_NAO_SUPORTADO',erro:'PDF não reconhecido como fatura Itaú.'};
  const venc=txt.match(/Vencimento\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || txt.match(/Com vencimento em\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
  const total=txt.match(/Total desta fatura\s*([\d.]+,\d{2})/i) || txt.match(/O total da sua fatura [ée]:?\s*R\$\s*([\d.]+,\d{2})/i);
  if(!venc||!total) return {ok:false,codigo:'CABECALHO_INCOMPLETO',erro:'Não foi possível identificar vencimento e total da fatura Itaú.'};
  const [dd,mm,aaaa]=venc[1].split('/');
  const conta=(txt.match(/(?:N[uú]mero da conta|Cart[aã]o)\s+(?:\d{4}\.)?X{4}\.X{4}\.(\d{4})/i)||[])[1]||'SN';
  return {ok:true,competencia:`${mm}/${aaaa}`,vencimento:`${aaaa}-${mm}-${dd}`,valor_total_fatura:numBR(total[1]),conta_final:conta,texto:txt};
}

function splitColunas(items, corte=350){
  return {
    esquerda:agruparLinhas((items||[]).filter(it=>Number(it.transform?.[4]||0)<corte),2.6),
    direita:agruparLinhas((items||[]).filter(it=>Number(it.transform?.[4]||0)>=corte),2.6)
  };
}
function linhaTransacao(t){
  const s=normalizarTexto(t);
  const m=s.match(/^(\d{2}\/\d{2})\s+(.+?)\s+(-?\s*[\d.]+,\d{2})$/);
  if(!m) return null;
  const desc=limpar(m[2]);
  if(/^(DATA|VALOR EM R\$|ESTABELECIMENTO)|Lançamentos no cartão|Total dos lançamentos|Próxima fatura|Demais faturas|Total para próximas faturas/i.test(desc)) return null;
  if(/PAGAMENTO|PAGAM ENTO|DEB AUTOM/i.test(desc)) return null;
  const neg=/^-/.test(m[3].trim());
  const valor=Math.abs(numBR(m[3]));
  return {data:m[1],descricao:desc,valor:Number((neg?-valor:valor).toFixed(2))};
}
function movimento(desc,valor){
  const s=String(desc||'').toUpperCase();
  if(valor<0){if(/ESTORNO/.test(s))return'ESTORNO';if(/DESCONTO/.test(s))return'DESCONTO';return'CREDITO'}
  if(/ANUIDADE/.test(s))return'ANUIDADE';if(/IOF/.test(s))return'IOF';if(/JUROS/.test(s))return'JUROS';if(/TARIFA/.test(s))return'TARIFA';if(/\b\d{1,2}\/\d{1,2}\b/.test(s))return'COMPRA PARCELADA';return'COMPRA';
}
function itemFinal(tx,cab,seq,final){
  const p=parcelas(tx.descricao);
  return {data_compra:dataISO(tx.data,cab.competencia),data_original:tx.data,descricao:tx.descricao,valor:tx.valor,tipo:tx.valor<0?'CREDITO':'DEBITO',natureza_cartao:tx.valor<0?'C':'D',movimento:movimento(tx.descricao,tx.valor),efeito:tx.valor<0?'ABATE_FATURA':'AUMENTA_FATURA',contexto:'ITAU',...p,hash_item:hash([final,cab.competencia,tx.data,tx.descricao,tx.valor,seq])};
}

function interpretarColuna(linhas,cab,{finalInicial,agruparPorFinal=true,ajustesFinal=null}={}){
  const grupos=new Map(); let final=finalInicial||cab.conta_final||'SN'; let modo='COMPRAS'; let seq=0;
  const g=f=>{const k=f||cab.conta_final||'SN';if(!grupos.has(k))grupos.set(k,{final:k,itens:[]});return grupos.get(k)};
  for(const l of linhas){const t=normalizarTexto(l.texto);if(!t)continue;
    const h=t.match(/\(final\s+(\d{4})\)/i); if(h&&agruparPorFinal){final=h[1];modo='COMPRAS';continue}
    if(/Lançamentos:?\s*produtos e serviços/i.test(t)){modo='AJUSTES';if(ajustesFinal)final=ajustesFinal;continue}
    if(/Compras parceladas\s*-\s*pr[oó]ximas faturas/i.test(t))break;
    const tx=linhaTransacao(t); if(!tx)continue;
    if(modo==='AJUSTES'&&ajustesFinal)final=ajustesFinal;
    g(final).itens.push(itemFinal(tx,cab,seq++,final));
  }
  return grupos;
}
function mesclarGrupos(dest,src){for(const [k,v] of src){if(!dest.has(k))dest.set(k,{final:k,itens:[]});dest.get(k).itens.push(...v.itens)}}

function montarCartoes(grupos,cab){
  return [...grupos.values()].filter(g=>g.itens.length).map(g=>{
    const valor=Number(g.itens.reduce((s,i)=>s+Number(i.valor||0),0).toFixed(2));
    return {final:g.final,cartao:`Itaú final ${g.final}`,bandeira:'VISA',portador:null,competencia:cab.competencia,vencimento:cab.vencimento,valor_total:valor,qtd_itens:g.itens.length,itens:g.itens};
  });
}

async function interpretarItauPdfV1(buf,password='',arquivoNome=''){
  const PDFJS=require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  const loading=PDFJS.getDocument({data:new Uint8Array(buf),password:String(password||'')});
  const doc=await(loading.promise||loading); const paginas=[];
  try{for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p);const tc=await page.getTextContent({normalizeWhitespace:true});paginas.push(tc.items||[])}}finally{try{await doc.destroy()}catch(_){}}
  const cab=acharCabecalho(paginas); if(!cab.ok)return cab;
  if(paginas.length<2)return{ok:false,codigo:'SEM_LANCAMENTOS',erro:'Fatura Itaú sem página de lançamentos.'};
  const p2=splitColunas(paginas[1],350); const txt2=normalizarTexto(textoPagina(paginas[1]));
  const porFinal=/\(final\s+\d{4}\)/i.test(txt2);
  const grupos=new Map();
  if(porFinal){
    mesclarGrupos(grupos,interpretarColuna(p2.esquerda,cab,{finalInicial:cab.conta_final,agruparPorFinal:true,ajustesFinal:cab.conta_final}));
    mesclarGrupos(grupos,interpretarColuna(p2.direita,cab,{finalInicial:cab.conta_final,agruparPorFinal:true,ajustesFinal:cab.conta_final}));
  }else{
    mesclarGrupos(grupos,interpretarColuna(p2.esquerda,cab,{finalInicial:cab.conta_final,agruparPorFinal:false}));
    mesclarGrupos(grupos,interpretarColuna(p2.direita,cab,{finalInicial:cab.conta_final,agruparPorFinal:false}));
  }
  const cartoes=montarCartoes(grupos,cab);
  const soma=Number(cartoes.reduce((s,c)=>s+c.valor_total,0).toFixed(2));
  const diferenca=Number((soma-cab.valor_total_fatura).toFixed(2));
  const qtd=cartoes.reduce((s,c)=>s+c.qtd_itens,0);
  const previewHash=hash({arquivoNome,competencia:cab.competencia,vencimento:cab.vencimento,total:cab.valor_total_fatura,cartoes:cartoes.map(c=>({final:c.final,valor:c.valor_total,itens:c.itens.map(i=>i.hash_item)}))});
  return {ok:true,banco:'ITAU',competencia:cab.competencia,vencimento:cab.vencimento,valor_total_fatura:cab.valor_total_fatura,soma_itens:soma,diferenca,conferencia_ok:Math.abs(diferenca)<=0.02,cartoes,qtd_itens:qtd,preview_hash:previewHash,arquivo_nome:arquivoNome,parser:'itau-coordenadas-v1'};
}

module.exports={interpretarItauPdfV1,acharCabecalho,linhaTransacao,numBR,dataISO,agruparLinhas};
