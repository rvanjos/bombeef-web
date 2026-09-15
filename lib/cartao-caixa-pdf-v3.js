'use strict';

const crypto = require('crypto');

function numBR(v) {
  const n = Number(String(v || '').replace(/R\$\s*/gi, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function hash(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

function limpar(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function dataISO(ddmm, competencia) {
  const m = String(ddmm || '').match(/^(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const [mesComp, anoComp] = String(competencia || '').split('/').map(Number);
  if (!mesComp || !anoComp) return null;
  const dia = Number(m[1]), mes = Number(m[2]);
  const ano = mes > mesComp ? anoComp - 1 : anoComp;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function parcelas(desc) {
  const s = String(desc || '');
  let m = s.match(/\b(\d{1,2})\s+DE\s+(\d{1,2})\b/i);
  if (!m) m = s.match(/\b(\d{1,2})\/\s*(\d{1,2})\b/i);
  return m ? { parcela_atual: Number(m[1]), parcelas_total: Number(m[2]) } : { parcela_atual: null, parcelas_total: null };
}

function agruparLinhas(items, toleranciaY = 2.4) {
  const tokens = (items || []).map((it, idx) => ({
    texto: limpar(it.str),
    x: Number(it.transform?.[4] || 0),
    y: Number(it.transform?.[5] || 0),
    idx
  })).filter(t => t.texto);

  tokens.sort((a, b) => b.y - a.y || a.x - b.x || a.idx - b.idx);
  const linhas = [];
  for (const t of tokens) {
    let l = linhas.find(x => Math.abs(x.y - t.y) <= toleranciaY);
    if (!l) { l = { y: t.y, tokens: [] }; linhas.push(l); }
    l.tokens.push(t);
  }
  linhas.sort((a, b) => b.y - a.y);
  return linhas.map(l => {
    l.tokens.sort((a, b) => a.x - b.x || a.idx - b.idx);
    return { y: l.y, tokens: l.tokens, texto: limpar(l.tokens.map(t => t.texto).join(' ')) };
  });
}

function textoPagina(items) {
  return agruparLinhas(items, 3).map(l => l.texto).join('\n');
}

function acharCabecalho(paginas) {
  const txt = paginas.map(p => textoPagina(p)).join('\n');
  if (!/CART[ÕO]ES\s+CAIXA|cart[oõ]es\s+CAIXA/i.test(txt)) {
    return { ok: false, codigo: 'FORMATO_NAO_SUPORTADO', erro: 'PDF não reconhecido como fatura Cartões CAIXA.' };
  }

  const venc = txt.match(/VENCIMENTO[\s\S]{0,80}?(\d{2}\/\d{2}\/\d{4})/i);
  const total = txt.match(/VALOR\s+TOTAL\s+DESTA\s+FATURA[\s\S]{0,80}?R\$\s*([\d.]+,\d{2})/i);
  if (!venc || !total) return { ok: false, codigo: 'CABECALHO_INCOMPLETO', erro: 'Não foi possível identificar vencimento e total.' };

  const [dd, mm, aaaa] = venc[1].split('/');
  const mascara = txt.match(/(?:\d{4}\.)?X{4}\.X{4}\.(\d{4})|\b(\d{4})\.X{4}\.X{4}\.(\d{4})\b/i);
  let final = null;
  if (mascara) final = mascara[1] || mascara[3] || null;
  if (!final) {
    const card = txt.match(/\(Cart[aã]o\s+(\d{4})\)/i);
    final = card?.[1] || null;
  }

  return {
    ok: true,
    competencia: `${mm}/${aaaa}`,
    vencimento: `${aaaa}-${mm}-${dd}`,
    valor_total_fatura: numBR(total[1]),
    primeiro_final: final,
    texto: txt
  };
}

function valorFinalDaLinha(linha) {
  for (let i = linha.tokens.length - 1; i >= 0; i--) {
    const m = linha.tokens[i].texto.match(/^([\d.]+,\d{2})\s*([CD])$/i);
    if (m) return { valor: numBR(m[1]), natureza: m[2].toUpperCase(), indice: i };
  }
  return null;
}

function secaoPorTexto(t) {
  if (/COMPRAS\s+PARCELADAS/i.test(t)) return 'COMPRAS PARCELADAS';
  if (/^COMPRAS\b/i.test(t)) return 'COMPRAS';
  if (/^ANUIDADE\b/i.test(t)) return 'ANUIDADE';
  return null;
}

function interpretarLinhasFinanceiras(linhas, cab) {
  const grupos = new Map();
  let atual = cab.primeiro_final || 'SN';
  let portador = null;
  let secao = 'AJUSTES';

  function grupo(final) {
    const f = final || cab.primeiro_final || 'SN';
    if (!grupos.has(f)) grupos.set(f, { final: f, portador: null, itens: [] });
    return grupos.get(f);
  }

  for (const linha of linhas) {
    const t = linha.texto;
    if (!t) continue;

    const h = t.match(/(.+?)\s*\(Cart[aã]o\s+(\d{4})\)/i);
    if (h) {
      atual = h[2];
      if (!/^(COMPRAS|COMPRAS PARCELADAS)/i.test(h[1])) {
        portador = limpar(h[1]);
        grupo(atual).portador = portador;
      }
      const novaSecao = secaoPorTexto(t);
      if (novaSecao) secao = novaSecao;
      continue;
    }

    const fim = valorFinalDaLinha(linha);
    const s = secaoPorTexto(t);
    // Cabeçalhos de seção não possuem valor. Se houver um valor D/C na própria
    // linha (ex.: "ANUIDADE DIFERENCIADA ... 6,90D"), trata-se de lançamento.
    if (s && !fim) { secao = s; continue; }
    if (s && fim) secao = s;
    if (/^Total\b/i.test(t) || /^Data\b/i.test(t) || /Cr[eé]dito\/D[eé]bito/i.test(t) || /Valor\s+Original/i.test(t)) continue;

    if (!fim) continue;

    const primeiro = linha.tokens[0]?.texto || '';
    const data = /^\d{2}\/\d{2}$/.test(primeiro) ? primeiro : null;
    const ini = data ? 1 : 0;
    const desc = limpar(linha.tokens.slice(ini, fim.indice).map(x => x.texto).join(' '));
    if (!desc) continue;
    if (/TOTAL DA FATURA ANTERIOR|OBRIGADO PELO PAGAMENTO/i.test(desc)) continue;
    if (!data && !/(ANUIDADE|TARIFA|IOF|ENCARGO|JUROS)/i.test(desc)) continue;

    const sinal = fim.natureza === 'C' ? -1 : 1;
    const valor = Number((fim.valor * sinal).toFixed(2));
    const item = {
      data_compra: dataISO(data, cab.competencia),
      data_original: data,
      descricao: desc,
      valor,
      tipo: fim.natureza === 'C' ? 'CREDITO' : 'DEBITO',
      contexto: secao || 'AJUSTES',
      ...parcelas(desc)
    };
    grupo(atual).itens.push(item);
  }

  const cartoes = [...grupos.values()].filter(g => g.itens.length).map(g => {
    const vistos = new Set();
    const itens = [];
    for (const it of g.itens) {
      const k = `${it.data_original || ''}|${limpar(it.descricao)}|${Number(it.valor).toFixed(2)}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      itens.push({ ...it, hash_item: hash([g.final, cab.competencia, it.data_compra, it.descricao, Number(it.valor.toFixed(2)), itens.length]) });
    }
    const valor = Number(itens.reduce((s, i) => s + Number(i.valor || 0), 0).toFixed(2));
    return {
      final: g.final,
      cartao: `Caixa final ${g.final}`,
      bandeira: 'VISA',
      portador: g.portador || portador || null,
      competencia: cab.competencia,
      vencimento: cab.vencimento,
      valor_total: valor,
      qtd_itens: itens.length,
      itens
    };
  });

  return cartoes;
}

async function interpretarCaixaPdfV3(buf, password = '', arquivoNome = '') {
  const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  const loading = PDFJS.getDocument({ data: new Uint8Array(buf), password: String(password || '') });
  const doc = await (loading.promise || loading);
  const paginas = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent({ normalizeWhitespace: true });
      paginas.push(tc.items || []);
    }
  } finally {
    try { await doc.destroy(); } catch (_) {}
  }

  const cab = acharCabecalho(paginas);
  if (!cab.ok) return cab;

  let linhasFinanceiras = [];
  for (let p = 1; p < paginas.length; p++) {
    const todas = agruparLinhas(paginas[p], 2.6);
    const temDuasColunas = todas.some(l => /Demonstrativo/i.test(l.texto) && l.tokens.some(t => t.x >= 280));
    const linhas = temDuasColunas
      ? agruparLinhas(paginas[p].filter(it => Number(it.transform?.[4] || 0) >= 280), 2.6)
      : todas;
    linhasFinanceiras.push(...linhas);
  }

  if (!linhasFinanceiras.length) {
    return { ok: false, codigo: 'SEM_DEMONSTRATIVO', erro: 'Nenhum demonstrativo financeiro foi encontrado no PDF.' };
  }

  const cartoes = interpretarLinhasFinanceiras(linhasFinanceiras, cab);
  const soma = Number(cartoes.reduce((s, c) => s + c.valor_total, 0).toFixed(2));
  const diferenca = Number((soma - cab.valor_total_fatura).toFixed(2));
  const qtd = cartoes.reduce((s, c) => s + c.qtd_itens, 0);
  const previewHash = hash({ arquivoNome, competencia: cab.competencia, vencimento: cab.vencimento, total: cab.valor_total_fatura, cartoes: cartoes.map(c => ({ final: c.final, valor: c.valor_total, itens: c.itens.map(i => i.hash_item) })) });

  return {
    ok: true,
    banco: 'CAIXA',
    competencia: cab.competencia,
    vencimento: cab.vencimento,
    valor_total_fatura: cab.valor_total_fatura,
    soma_itens: soma,
    diferenca,
    conferencia_ok: Math.abs(diferenca) <= 0.02,
    cartoes,
    qtd_itens: qtd,
    preview_hash: previewHash,
    arquivo_nome: arquivoNome,
    parser: 'caixa-coordenadas-v3'
  };
}

module.exports = { interpretarCaixaPdfV3, agruparLinhas, acharCabecalho, interpretarLinhasFinanceiras, numBR, dataISO };
