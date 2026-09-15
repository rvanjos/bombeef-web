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

function parseLinhaTransacao(linha, competencia, contexto='') {
  const s = limparDescricao(linha);
  if (!s || /^Total\b/i.test(s) || /^(Data|Cr[eé]dito\/D[eé]bito|Valor Original|Cota[cç][aã]o)/i.test(s)) return null;

  let m = s.match(/^(\d{2}\/\d{2})\s+(.+?)\s+([\d.]+,\d{2})([CD])$/i);
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
  m = s.match(/^(.+?)\s+([\d.]+,\d{2})([CD])$/i);
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
  const m = String(descricao||'').match(/\b(\d{1,2})\s+DE\s+(\d{1,2})\b/i);
  return m ? { parcela_atual:Number(m[1]), parcelas_total:Number(m[2]) } : { parcela_atual:null, parcelas_total:null };
}

function interpretarCaixa(texto, arquivoNome='') {
  const textoNorm = String(texto||'').replace(/\r/g,'');
  const linhas = textoNorm.split('\n').map(l=>l.trim()).filter(Boolean);
  if (!/CART[ÕO]ES CAIXA|Cart[oõ]es Caixa/i.test(textoNorm)) {
    return { ok:false, codigo:'FORMATO_NAO_SUPORTADO', erro:'O arquivo não foi reconhecido como fatura Cartões CAIXA.' };
  }

  const v = textoNorm.match(/VENCIMENTO\s*\n\s*(\d{2}\/\d{2}\/\d{4})/i);
  const t = textoNorm.match(/VALOR TOTAL DESTA FATURA\s*\n\s*R\$\s*([\d.]+,\d{2})/i);
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

  // Créditos do ciclo podem aparecer antes do primeiro cabeçalho do cartão.
  const pre = headings.length ? corpo.slice(0, headings[0].index) : corpo;
  for (const linha of pre.split('\n')) {
    const item = parseLinhaTransacao(linha, competencia, 'AJUSTES');
    if (!item) continue;
    if (/TOTAL DA FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(item.descricao)) continue;
    grupo(primeiroFinal).itens.push(item);
  }

  for (let i=0;i<headings.length;i++) {
    const h = headings[i];
    const trecho = corpo.slice(h.end, i+1<headings.length ? headings[i+1].index : corpo.length);
    let contexto = '';
    const g = grupo(h.final,h.portador);
    for (const linhaRaw of trecho.split('\n')) {
      const linha = limparDescricao(linhaRaw);
      if (/^(ANUIDADE|COMPRAS|COMPRAS PARCELADAS)\b/i.test(linha) && !/[\d.]+,\d{2}[CD]$/i.test(linha)) {
        contexto = linha.toUpperCase();
        continue;
      }
      const item = parseLinhaTransacao(linha, competencia, contexto);
      if (!item) continue;
      if (/TOTAL DA FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(item.descricao)) continue;
      Object.assign(item, extrairParcelas(item.descricao));
      g.itens.push(item);
    }
  }

  const cartoes = [...porFinal.values()].map(g => {
    const itens = g.itens.map((it,idx)=>({
      ...it,
      hash_item: hash([g.final, competencia, it.data_compra, it.descricao, Number(it.valor.toFixed(2)), idx])
    }));
    const valorLiquido = Number(itens.reduce((s,it)=>s+Number(it.valor||0),0).toFixed(2));
    return {
      final:g.final,
      cartao:`Caixa final ${g.final}`,
      bandeira: String(g.final).startsWith('') && /^4/.test((textoNorm.match(/^(\d{4})\./m)||[])[1]||'') ? 'VISA' : 'CAIXA',
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

module.exports = { interpretarFatura, interpretarCaixa, numeroBR, dataISO };
