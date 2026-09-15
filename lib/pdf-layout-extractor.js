'use strict';

const pdfParse = require('pdf-parse');

function montarLinhas(items, toleranciaY = 2.2) {
  const tokens = (items || []).map((it, idx) => ({
    texto: String(it.str || '').trim(),
    x: Number(it.transform?.[4] || 0),
    y: Number(it.transform?.[5] || 0),
    idx
  })).filter(t => t.texto);

  tokens.sort((a,b) => Math.abs(b.y-a.y) > toleranciaY ? b.y-a.y : a.x-b.x || a.idx-b.idx);
  const linhas = [];
  for (const t of tokens) {
    let linha = linhas.find(l => Math.abs(l.y - t.y) <= toleranciaY);
    if (!linha) { linha = { y:t.y, itens:[] }; linhas.push(linha); }
    linha.itens.push(t);
  }
  linhas.sort((a,b)=>b.y-a.y);
  return linhas.map(l => l.itens.sort((a,b)=>a.x-b.x).map(x=>x.texto).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
}

async function extrairEstruturadoPdfJs(buf, password='') {
  const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  const loading = PDFJS.getDocument({ data:new Uint8Array(buf), password:String(password || '') });
  const doc = await (loading.promise || loading);
  const paginas=[];
  try {
    for (let i=1;i<=doc.numPages;i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent({ normalizeWhitespace:true });
      paginas.push(montarLinhas(tc.items).join('\n'));
    }
  } finally {
    try { await doc.destroy(); } catch(_) {}
  }
  return paginas.join('\n').slice(0,120000);
}

async function extrairTextosPdf(buf, password='') {
  let bruto='', estruturado='', erroBruto=null, erroEstruturado=null;
  try {
    const parsed = await pdfParse(buf);
    bruto = String(parsed.text || '').slice(0,120000);
  } catch(e) { erroBruto = e; }

  try {
    estruturado = await extrairEstruturadoPdfJs(buf, password);
  } catch(e) { erroEstruturado = e; }

  if (!bruto && !estruturado) {
    const base = erroEstruturado || erroBruto || new Error('Não foi possível ler o PDF');
    throw base;
  }
  return { bruto, estruturado, erroBruto, erroEstruturado };
}

module.exports = { montarLinhas, extrairEstruturadoPdfJs, extrairTextosPdf };
