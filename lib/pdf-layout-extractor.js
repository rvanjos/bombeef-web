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

function montarSequencial(items) {
  const linhas = [];
  let atual = [];
  let anterior = null;

  const fechar = () => {
    const linha = atual.join(' ').replace(/\s+/g,' ').trim();
    if (linha) linhas.push(linha);
    atual = [];
  };

  for (const it of (items || [])) {
    const texto = String(it.str || '').trim();
    const x = Number(it.transform?.[4] || 0);
    const y = Number(it.transform?.[5] || 0);

    if (texto) {
      // Alguns PDFs não marcam hasEOL de forma consistente. Quando a sequência
      // volta para a esquerda e também muda de altura, tratamos como nova linha.
      if (anterior && !anterior.hasEOL && Math.abs(y - anterior.y) > 2.5 && x + 8 < anterior.x) fechar();
      atual.push(texto);
    }

    if (it.hasEOL) fechar();
    anterior = { x, y, hasEOL:Boolean(it.hasEOL) };
  }
  fechar();
  return linhas;
}

async function extrairPdfJsVariantes(buf, password='') {
  const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  const loading = PDFJS.getDocument({ data:new Uint8Array(buf), password:String(password || '') });
  const doc = await (loading.promise || loading);
  const estruturadas=[];
  const sequenciais=[];
  try {
    for (let i=1;i<=doc.numPages;i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent({ normalizeWhitespace:true });
      estruturadas.push(montarLinhas(tc.items).join('\n'));
      sequenciais.push(montarSequencial(tc.items).join('\n'));
    }
  } finally {
    try { await doc.destroy(); } catch(_) {}
  }
  return {
    estruturado: estruturadas.join('\n').slice(0,120000),
    sequencial: sequenciais.join('\n').slice(0,120000)
  };
}

async function extrairEstruturadoPdfJs(buf, password='') {
  return (await extrairPdfJsVariantes(buf,password)).estruturado;
}

async function extrairSequencialPdfJs(buf, password='') {
  return (await extrairPdfJsVariantes(buf,password)).sequencial;
}

async function extrairTextosPdf(buf, password='') {
  let bruto='', estruturado='', sequencial='', erroBruto=null, erroEstruturado=null;
  try {
    const parsed = await pdfParse(buf);
    bruto = String(parsed.text || '').slice(0,120000);
  } catch(e) { erroBruto = e; }

  try {
    const variantes = await extrairPdfJsVariantes(buf, password);
    estruturado = variantes.estruturado;
    sequencial = variantes.sequencial;
  } catch(e) { erroEstruturado = e; }

  if (!bruto && !estruturado && !sequencial) {
    const base = erroEstruturado || erroBruto || new Error('Não foi possível ler o PDF');
    throw base;
  }
  return { bruto, estruturado, sequencial, erroBruto, erroEstruturado };
}

module.exports = {
  montarLinhas,
  montarSequencial,
  extrairPdfJsVariantes,
  extrairEstruturadoPdfJs,
  extrairSequencialPdfJs,
  extrairTextosPdf
};
