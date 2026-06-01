/**
 * lib/xlsx-parser.js — Parser XLSX/CSV compartilhado (F1-08)
 * Bom Beef Sistema de Gestão — AR Boutique de Carnes LTDA
 *
 * Centraliza funções reutilizáveis de leitura de planilhas.
 * Os módulos existentes NÃO são alterados — esta lib é usada
 * pelos módulos novos (Hub Operacional etc.) e pode ser adotada
 * gradualmente pelos módulos existentes.
 *
 * Funções exportadas:
 *   lerBuffer(buffer, opts)          — lê XLSX/XLS/CSV, retorna rows[][]
 *   normalizarCabecalho(header)       — normaliza string de cabeçalho
 *   encontrarColuna(header, termos)   — acha índice de coluna por termos
 *   detectarTipoArquivo(buffer, nome) — identifica o tipo do arquivo automaticamente
 *   extrairLinhasValidas(rows, opts)  — filtra linhas vazias e rodapés
 */

'use strict';

const XLSX = require('xlsx');

// ── Normalização ──────────────────────────────────────────────────────────────

/**
 * Normaliza string de cabeçalho para comparação:
 * remove acentos, espaços, underscores e converte para minúsculo.
 */
function normalizarCabecalho(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[\s_\-\.\/]+/g, '')                     // remove separadores
    .trim();
}

/**
 * Encontra o índice de uma coluna num array de cabeçalhos.
 * @param {string[]} headers - Array de strings de cabeçalho
 * @param {string[]} termos  - Termos a buscar (OR — primeiro match vence)
 * @returns {number} índice ou -1
 */
function encontrarColuna(headers, termos) {
  const norm = headers.map(normalizarCabecalho);
  for (const t of termos) {
    const nt = normalizarCabecalho(t);
    const idx = norm.findIndex(h => h.includes(nt) || nt.includes(h));
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── Leitura de arquivo ────────────────────────────────────────────────────────

/**
 * Lê um buffer XLSX/XLS/CSV e retorna array de arrays (rows[][]).
 * @param {Buffer} buffer
 * @param {object} opts
 *   @param {boolean} opts.cellDates - converter datas automaticamente (default: true)
 *   @param {string}  opts.sheetName - nome da aba (default: primeira)
 *   @param {string}  opts.sheetPref - prefixo de aba preferida (fallback para primeira)
 *   @param {boolean} opts.corrigirRef - corrigir !ref incorreto do XMenu (default: true)
 * @returns {string[][]}
 */
function lerBuffer(buffer, opts = {}) {
  const {
    cellDates  = true,
    sheetName  = null,
    sheetPref  = null,
    corrigirRef = true,
  } = opts;

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates });

  // Escolhe aba
  let nome = wb.SheetNames[0];
  if (sheetName && wb.SheetNames.includes(sheetName)) {
    nome = sheetName;
  } else if (sheetPref) {
    const found = wb.SheetNames.find(n =>
      n.toLowerCase().includes(sheetPref.toLowerCase())
    );
    if (found) nome = found;
  }

  const sheet = wb.Sheets[nome];
  if (!sheet) return [];

  // Corrige !ref incorreto (bug XMenu — declara A1:C1 mas tem 12 colunas)
  if (corrigirRef && sheet['!ref']) {
    try {
      let mR = 0, mC = 0;
      Object.keys(sheet).filter(k => !k.startsWith('!')).forEach(addr => {
        const c = XLSX.utils.decode_cell(addr);
        if (c.r > mR) mR = c.r;
        if (c.c > mC) mC = c.c;
      });
      sheet['!ref'] = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:mR,c:mC} });
    } catch(_) {}
  }

  return XLSX.utils.sheet_to_json(sheet, { header:1, defval:'', raw:false });
}

// ── Detecção automática de tipo ────────────────────────────────────────────────

/**
 * Detecta o tipo de arquivo com base no conteúdo e nome.
 * Retorna um dos tipos conhecidos ou 'desconhecido'.
 *
 * Tipos retornados:
 *   'estoque_302'   — Relatório 302 XMenu (estoque + produtos)
 *   'vendas_xmenu'  — Relatório de vendas XMenu
 *   'cadastro_pdv'  — Cadastro de produtos do PDV
 *   'extrato_ofx'   — Extrato bancário OFX
 *   'extrato_xlsx'  — Extrato bancário XLSX (Itaú/C6)
 *   'fatura_cc'     — Fatura cartão de crédito
 *   'nfe_xml'       — Nota fiscal XML (EXCEÇÃO — não processar no Hub)
 *   'desconhecido'  — Não identificado
 */
function detectarTipoArquivo(buffer, nomeArquivo = '') {
  const nome = (nomeArquivo || '').toLowerCase();
  const ext  = nome.split('.').pop();

  // NF-e XML — EXCEÇÃO: identificar mas NÃO processar no Hub
  if (ext === 'xml') {
    try {
      const txt = buffer.toString('utf8', 0, 500);
      if (txt.includes('<NFe') || txt.includes('<nfeProc') || txt.includes('nfe.fazenda')) {
        return 'nfe_xml'; // Hub deve rejeitar e direcionar para boletos.html
      }
    } catch(_) {}
    return 'xml_desconhecido';
  }

  // OFX
  if (ext === 'ofx' || ext === 'ofc') return 'extrato_ofx';
  try {
    const txt = buffer.toString('utf8', 0, 200).toUpperCase();
    if (txt.includes('FINANCIAL-DATA') || txt.includes('OFXHEADER') || txt.includes('<OFX>')) {
      return 'extrato_ofx';
    }
  } catch(_) {}

  // CSV / XLSX — analisar cabeçalho
  if (['xlsx','xls','csv'].includes(ext)) {
    try {
      const rows = lerBuffer(buffer, { cellDates: false, corrigirRef: true });
      // Procura cabeçalho nas primeiras 10 linhas
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const linha = rows[i].map(c => normalizarCabecalho(String(c || '')));
        const linhaStr = linha.join('|');

        // Fatura CC Itaú CSV — tem CNPJ + Portador + C/D
        if (linha.includes('cnpj') && (linhaStr.includes('portador') || linhaStr.includes('cd') || linhaStr.includes('creditodebito'))) {
          return 'fatura_cc';
        }

        // Extrato XLSX Itaú — tem FINAL XXXX nas células
        if (linhaStr.includes('final') && (linhaStr.includes('conta') || linhaStr.includes('agencia'))) {
          return 'extrato_xlsx';
        }

        // Relatório 302 XMenu — tem codigo + produto/descricao + estoque
        const temCodigo  = linhaStr.includes('codigo') || linhaStr.includes('codigoproduto');
        const temEstoque = linhaStr.includes('estoque') || linhaStr.includes('saldo');
        const temDescri  = linhaStr.includes('produto') || linhaStr.includes('descricao') || linhaStr.includes('nome');
        if (temCodigo && temEstoque && temDescri) return 'estoque_302';

        // Cadastro de produtos — tem codigo + custo/venda mas sem estoque
        if (temCodigo && temDescri && (linhaStr.includes('custo') || linhaStr.includes('venda') || linhaStr.includes('preco'))) {
          return 'cadastro_pdv';
        }

        // Vendas XMenu — tem NumeroCaixa ou TotalProdutos ou Loja
        if (linhaStr.includes('numerocaixa') || linhaStr.includes('totalprodutos') || linhaStr.includes('loja')) {
          return 'vendas_xmenu';
        }
        // Vendas por produto — tem data + produto + quantidade + valor
        if ((linhaStr.includes('data') || linhaStr.includes('periodo')) &&
            (linhaStr.includes('quantidade') || linhaStr.includes('qtd')) &&
            (linhaStr.includes('valor') || linhaStr.includes('total'))) {
          return 'vendas_xmenu';
        }

        // Extrato CSV/XLSX genérico — tem data + historico/descricao + valor
        if ((linhaStr.includes('data') || linhaStr.includes('lancamento')) &&
            (linhaStr.includes('historico') || linhaStr.includes('descricao') || linhaStr.includes('lancamento')) &&
            linhaStr.includes('valor')) {
          return 'extrato_xlsx';
        }
      }
    } catch(_) {}
  }

  return 'desconhecido';
}

// ── Utilitários ───────────────────────────────────────────────────────────────

/**
 * Filtra linhas vazias, rodapés e linhas de total de uma planilha.
 * @param {string[][]} rows
 * @param {object} opts
 *   @param {number} opts.headerIdx - índice da linha de cabeçalho (default: 0)
 *   @param {number} opts.minCols   - mínimo de colunas não-vazias (default: 2)
 */
function extrairLinhasValidas(rows, opts = {}) {
  const { headerIdx = 0, minCols = 2 } = opts;
  return rows.slice(headerIdx + 1).filter(row => {
    const naoVazias = row.filter(c => c !== null && c !== undefined && String(c).trim() !== '');
    return naoVazias.length >= minCols;
  });
}

/**
 * Converte valor monetário BR para float.
 * Suporta: "1.234,56" → 1234.56 · "R$ 1.234,56" → 1234.56
 */
function parseBRL(str) {
  if (str === null || str === undefined) return 0;
  const s = String(str).replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/**
 * Converte data em vários formatos para string ISO YYYY-MM-DD.
 * Suporta: Date object, DD/MM/YYYY, YYYY-MM-DD, número serial Excel.
 */
function parseData(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  // DD/MM/YYYY
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // YYYY-MM-DD
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  // ISO com T
  if (s.includes('T')) return s.slice(0, 10);
  // Serial Excel
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) {
    try {
      const d = XLSX.SSF.parse_date_code(n);
      if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } catch(_) {}
  }
  return null;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  lerBuffer,
  normalizarCabecalho,
  encontrarColuna,
  detectarTipoArquivo,
  extrairLinhasValidas,
  parseBRL,
  parseData,
};
