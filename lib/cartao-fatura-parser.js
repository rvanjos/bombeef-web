'use strict';

const crypto = require('crypto');

function numeroBR(v) {
  if (v == null) return 0;
  const s = String(v).trim().replace(/R\$\s*/gi,'').replace(/\./g,'').replace(',','.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function dataISO(ddmm, competencia) {
  if (!ddmm) return null;
  const m = String(ddmm).match(/^(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const dia = Number(m[1]), mes = Number(m[2]);
  const [mesComp, anoComp] = String(competencia||'').split('/').map(Number);
  if (!mesComp || !anoComp) return null;
  const ano = mes > mesComp ? anoComp - 1 : anoComp;
  const dt = new Date(Date.UTC(ano, mes-1, dia));
  if (dt.getUTCDate() !== dia || dt.getUTCMonth() !== mes-1) return null;
  return `${ano}-${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
}

function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function limparDescricao(s) {
  return String(s||'').replace(/\s+/g,' ').trim();
}

function corrigirColagemParcelaValor(linha) {
  let s = String(linha||'');
  // Alguns PDFs da CAIXA saem do pdf-parse como "04/ 126,90D"
  // ("12" = total de parcelas; "6,90" = valor). Reinsere o espaço.
  s = s.replace(/(\b\d{1,2}\/\s*)(\d{2})(\d{1,3}(?:\.\d{3})*,\d{2}[CD])\s*$/i, '$1$2 $3');
  // Mesmo problema em "07 DE 12510,00D".
  s = s.replace(/(\b\d{1,2}\s+DE\s+)(\d{2})(\d{1,4}(?:\.\d{3})*,\d{2}[CD])\s*$/i, '$1$2 $3');
  return s;
}

function parseLinhaTransacao(linha, competencia, contexto='') {
  const s = limparDescricao(corrigirColagemParcelaValor(linha));
  if (!s || /^Total\b/i.test(s) || /^(Data|Cr[eé]dito\/D[eé]bito|Valor Original|Cota[cç][aã]o)/i.test(s)) return null;

  let m = s.match(/^(\d{2}\/\d{2})\s+(.+?)\s+([\d.]+,\d{2})\s*([CD])$/i);
  if (m) {
    const credito = m[4].toUpperCase() === 'C';
    return {
      data_compra: dataISO(m[1], competencia),
      data_original: m[1],
      descricao: limparDescricao(m[2]),
      valor: numeroBR(m[3]) * (credito ? -1 : 1),
      tipo: credito ? 'CREDITO' : 'DEBITO',
      contexto
    };
  }

  // Tarifas/anuidade podem vir sem data no PDF.
  m = s.match(/^(.+?)\s+([\d.]+,\d{2})\s*([CD])$/i);
  if (m && /(ANUIDADE|TARIFA|IOF|ENCARGO|JUROS)/i.test(m[1])) {
    const credito = m[3].toUpperCase() === 'C';
    return {
      data_compra: null,
      data_original: null,
      descricao: limparDescricao(m[1]),
      valor: numeroBR(m[2]) * (credito ? -1 : 1),
      tipo: credito ? 'CREDITO' : 'DEBITO',
      contexto
    };
  }
  return null;
}

function extrairParcelas(descricao) {
  const s = String(descricao||'');
  let m = s.match(/\b(\d{1,2})\s+DE\s+(\d{1,2})\b/i);
  if (!m) m = s.match(/\b(\d{1,2})\/\s*(\d{1,2})\b/i);
  return m ? { parcela_atual:Number(m[1]), parcelas_total:Number(m[2]) } : { parcela_atual:null, parcelas_total:null };
}

function contextoDoItem(descricao) {
  const s = String(descricao||'');
  if (/ANUIDADE|TARIFA|IOF|ENCARGO|JUROS/i.test(s)) return 'TARIFAS';
  if (/\b\d{1,2}\s+DE\s+\d{1,2}\b/i.test(s)) return 'COMPRAS PARCELADAS';
  return 'COMPRAS';
}

function extrairTransacoesFlexiveis(trecho, competencia, contextoPadrao='') {
  const normalizado = String(trecho||'')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(corrigirColagemParcelaValor)
    .join('\n');
  const itens = [];
  const vistos = new Set();

  // 1) Caminho mais fiel: tenta linha a linha primeiro.
  for (const raw of normalizado.split('\n')) {
    const item = parseLinhaTransacao(raw, competencia, contextoPadrao);
    if (!item) continue;
    const k = `${item.data_original||''}|${item.descricao}|${item.valor}`;
    if (!vistos.has(k)) { vistos.add(k); itens.push(item); }
  }

  // 2) Fallback para PDFs em que o pdf-parse quebra uma compra em várias linhas.
  // Cada movimento começa por DD/MM e termina no primeiro valor seguido de C/D.
  const re = /(\d{2}\/\d{2})\s+([\s\S]*?)\s+([\d.]+,\d{2})\s*([CD])(?=\s*(?:\d{2}\/\d{2}|Total\b|RAFAEL\b|ANUIDADE\b|COMPRAS\b|Valor\s+total\s+desta\s+fatura\b|$))/gi;
  let m;
  while ((m = re.exec(normalizado))) {
    const desc = limparDescricao(m[2]
      .replace(/\b(?:Data\s+Descri[cç][aã]o\s+Cidade\/Pa[ií]s\s+Valor\s+U\$\$\s+Cr[eé]dito\/D[eé]bito|Cr[eé]dito\/D[eé]bito\s+R\$)\b/gi,' '));
    if (!desc || /^Total\b/i.test(desc)) continue;
    const credito = m[4].toUpperCase() === 'C';
    const item = {
      data_compra: dataISO(m[1], competencia),
      data_original: m[1],
      descricao: desc,
      valor: numeroBR(m[3]) * (credito ? -1 : 1),
      tipo: credito ? 'CREDITO' : 'DEBITO',
      contexto: contextoPadrao || contextoDoItem(desc)
    };
    const k = `${item.data_original||''}|${item.descricao}|${item.valor}`;
    if (!vistos.has(k)) { vistos.add(k); itens.push(item); }
  }

  // 3) Tarifas/anuidade sem data. São poucas e precisam ser capturadas separadamente.
  for (const raw of normalizado.split('\n')) {
    if (!/(ANUIDADE|TARIFA|IOF|ENCARGO|JUROS)/i.test(raw)) continue;
    const item = parseLinhaTransacao(raw, competencia, contextoPadrao || 'TARIFAS');
    if (!item) continue;
    const k = `${item.data_original||''}|${item.descricao}|${item.valor}`;
    if (!vistos.has(k)) { vistos.add(k); itens.push(item); }
  }

  return itens;
}

function interpretarCaixa(texto, arquivoNome='') {
  const textoNorm = String(texto||'').replace(/\r/g,'\n');
  if (!/CART[ÕO]ES CAIXA|Cart[oõ]es Caixa/i.test(textoNorm)) {
    return { ok:false, codigo:'FORMATO_NAO_SUPORTADO', erro:'O arquivo não foi reconhecido como fatura Cartões CAIXA.' };
  }

  const v = textoNorm.match(/VENCIMENTO\s*\n+\s*(\d{2}\/\d{2}\/\d{4})/i);
  const t = textoNorm.match(/VALOR TOTAL DESTA FATURA\s*\n+\s*R\$\s*([\d.]+,\d{2})/i);
  if (!v || !t) return { ok:false, codigo:'CABECALHO_INCOMPLETO', erro:'Não foi possível identificar vencimento e valor total da fatura.' };

  const vencimentoBR = v[1];
  const [dd,mm,aaaa] = vencimentoBR.split('/');
  const competencia = `${mm}/${aaaa}`;
  const vencimento = `${aaaa}-${mm}-${dd}`;
  const valorTotal = numeroBR(t[1]);

  const primeiroFinal = (textoNorm.match(/(?:XXXX\.){2}(\d{4})/i) || [])[1] || null;
  const inicioDemo = textoNorm.search(/\bDemonstrativo\b/i);
  const corpo = inicioDemo >= 0 ? textoNorm.slice(inicioDemo) : textoNorm;
  const headingRe = /^(.+?)\s*\(Cart[aã]o\s+(\d{4})\)\s*$/gmi;
  const headings = [];
  let hm;
  while ((hm = headingRe.exec(corpo))) headings.push({ index:hm.index, end:headingRe.lastIndex, portador:limparDescricao(hm[1]), final:hm[2] });

  if (!headings.length && !primeiroFinal) return { ok:false, codigo:'CARTAO_NAO_IDENTIFICADO', erro:'Nenhum cartão foi identificado no demonstrativo.' };

  const porFinal = new Map();
  function grupo(final, portador='') {
    const chave = final || primeiroFinal || 'SN';
    if (!porFinal.has(chave)) porFinal.set(chave,{ final:chave, portador, itens:[] });
    const g = porFinal.get(chave);
    if (portador && !g.portador) g.portador = portador;
    return g;
  }

  // Créditos/ajustes do ciclo podem aparecer antes do primeiro cabeçalho do cartão.
  const pre = headings.length ? corpo.slice(0, headings[0].index) : corpo;
  for (const item of extrairTransacoesFlexiveis(pre, competencia, 'AJUSTES')) {
    if (/TOTAL DA FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(item.descricao)) continue;
    Object.assign(item, extrairParcelas(item.descricao));
    grupo(primeiroFinal).itens.push(item);
  }

  for (let i=0;i<headings.length;i++) {
    const h = headings[i];
    const trecho = corpo.slice(h.end, i+1<headings.length ? headings[i+1].index : corpo.length);
    const g = grupo(h.final,h.portador);
    for (const item of extrairTransacoesFlexiveis(trecho, competencia, '')) {
      if (/TOTAL DA FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(item.descricao)) continue;
      item.contexto = item.contexto || contextoDoItem(item.descricao);
      Object.assign(item, extrairParcelas(item.descricao));
      g.itens.push(item);
    }
  }

  const cartoes = [...porFinal.values()].map(g => {
    // Deduplica também entre os caminhos linha-a-linha e fallback multilinha.
    const unicos=[]; const seen=new Set();
    for (const it of g.itens) {
      const k = `${it.data_original||''}|${limparDescricao(it.descricao)}|${Number(it.valor||0).toFixed(2)}`;
      if (seen.has(k)) continue;
      seen.add(k); unicos.push(it);
    }
    const itens = unicos.map((it,idx)=>({
      ...it,
      hash_item: hash([g.final, competencia, it.data_compra, it.descricao, Number(it.valor.toFixed(2)), idx])
    }));
    const valorLiquido = Number(itens.reduce((s,it)=>s+Number(it.valor||0),0).toFixed(2));
    return {
      final:g.final,
      cartao:`Caixa final ${g.final}`,
      bandeira: /^4/.test((textoNorm.match(/^(\d{4})\./m)||[])[1]||'') ? 'VISA' : 'CAIXA',
      portador:g.portador || null,
      competencia,
      vencimento,
      valor_total:valorLiquido,
      qtd_itens:itens.length,
      itens
    };
  }).filter(c=>c.itens.length);

  const soma = Number(cartoes.reduce((s,c)=>s+c.valor_total,0).toFixed(2));
  const diferenca = Number((soma - valorTotal).toFixed(2));
  const fecha = Math.abs(diferenca) <= 0.02;
  const previewHash = hash({arquivoNome,competencia,vencimento,valorTotal,cartoes:cartoes.map(c=>({final:c.final,valor:c.valor_total,itens:c.itens.map(i=>i.hash_item)}))});

  return {
    ok:true,
    banco:'CAIXA',
    competencia,
    vencimento,
    valor_total_fatura:valorTotal,
    soma_itens:soma,
    diferenca,
    conferencia_ok:fecha,
    cartoes,
    qtd_itens:cartoes.reduce((s,c)=>s+c.qtd_itens,0),
    preview_hash:previewHash,
    arquivo_nome:arquivoNome
  };
}

function interpretarFatura(texto, arquivoNome='') {
  if (/CART[ÕO]ES CAIXA|Cart[oõ]es Caixa/i.test(String(texto||''))) return interpretarCaixa(texto, arquivoNome);
  return { ok:false, codigo:'FORMATO_NAO_SUPORTADO', erro:'Formato de fatura ainda não suportado pelo Agente Financeiro.' };
}

module.exports = { interpretarFatura, interpretarCaixa, numeroBR, dataISO, parseLinhaTransacao, extrairTransacoesFlexiveis, corrigirColagemParcelaValor };
