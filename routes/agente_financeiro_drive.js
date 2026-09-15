const express = require('express');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const autenticar = require('../middleware/auth');
const { protegerPoolPorLoja } = require('../lib/tenant-context');
const { interpretarFatura } = require('../lib/cartao-fatura-parser');

const r = express.Router();
r.use(autenticar(['admin','financeiro','contabil']));

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized:false } : false;
const pool = protegerPoolPorLoja(new Pool({ connectionString:process.env.DATABASE_URL, ssl }));
let tokenCache = { token: null, exp: 0 };
const colunasCache = new Map();

function normalizarFolderId(valor) {
  const raw = String(valor || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return '';
  const m = raw.match(/\/folders\/([A-Za-z0-9_-]+)/) || raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : raw;
}

function cfg() {
  const email = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const key = (process.env.GOOGLE_DRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const folderId = normalizarFolderId(process.env.GOOGLE_DRIVE_FATURAS_FOLDER_ID || '');
  return { email, key, folderId, ok: !!(email && key && folderId) };
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function getToken() {
  const c = cfg();
  if (!c.ok) throw new Error('Google Drive não configurado no Railway');
  const now = Math.floor(Date.now()/1000);
  if (tokenCache.token && tokenCache.exp > now + 60) return tokenCache.token;
  const header = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: c.email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`); signer.end();
  const sig = signer.sign(c.key);
  const assertion = `${header}.${payload}.${b64url(sig)}`;
  const body = new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha ao autenticar no Google Drive');
  tokenCache = { token:data.access_token, exp:now + Number(data.expires_in || 3600) };
  return tokenCache.token;
}

async function driveFetch(url, opts={}) {
  const token = await getToken();
  const resp = await fetch(url, { ...opts, headers:{ ...(opts.headers||{}), authorization:`Bearer ${token}` } });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
    const err = new Error(`Google Drive ${resp.status}: ${txt.slice(0,220)}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

function arquivosUrl(folderId, pageSize=50) {
  const p = new URLSearchParams({
    q: `'${folderId.replace(/'/g,"\\'")}' in parents and trashed = false`,
    pageSize: String(Math.min(Math.max(Number(pageSize)||50,1),100)),
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,webViewLink,parents)',
    spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
  });
  return `https://www.googleapis.com/drive/v3/files?${p.toString()}`;
}

function visiveisUrl(pageSize=100, pageToken='') {
  const p = new URLSearchParams({
    q: 'trashed = false', pageSize: String(Math.min(Math.max(Number(pageSize)||100,1),100)),
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,webViewLink,parents)',
    spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
  });
  if (pageToken) p.set('pageToken', pageToken);
  return `https://www.googleapis.com/drive/v3/files?${p.toString()}`;
}

async function metadata(fileId) {
  const fields = encodeURIComponent('id,name,mimeType,size,modifiedTime,parents,md5Checksum,webViewLink');
  const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`);
  return resp.json();
}

async function listarVisiveis(maxPaginas=5) {
  const todos=[]; let token='';
  for (let pagina=0; pagina<maxPaginas; pagina++) {
    const resp = await driveFetch(visiveisUrl(100, token));
    const data = await resp.json(); todos.push(...(data.files||[]));
    token = data.nextPageToken || ''; if (!token) break;
  }
  return todos;
}

async function tentarMetadataPasta(folderId) {
  try { const meta = await metadata(folderId); return { acessivel:true, id:meta.id, nome:meta.name, mimeType:meta.mimeType }; }
  catch(e) { return { acessivel:false, erro:e.message, status:e.status || null }; }
}

function compativel(f) { return /pdf|spreadsheet|excel|csv|text/i.test(`${f.mimeType||''} ${f.name||''}`); }
function pareceFatura(f) { return /fatura/i.test(String(f?.name||'')) && compativel(f); }
function sha(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

async function baixarArquivo(fileId) {
  const c = cfg();
  const meta = await metadata(fileId);
  if (!(meta.parents||[]).includes(c.folderId)) {
    const e = new Error('Arquivo fora da pasta financeira configurada'); e.status=403; throw e;
  }
  const dl = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  return { meta, buf:Buffer.from(await dl.arrayBuffer()) };
}

async function extrairPdfComPdfJs(buf, password) {
  const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  const loading = PDFJS.getDocument({ data:new Uint8Array(buf), password:String(password||'') });
  const doc = await (loading.promise || loading);
  const partes=[];
  for (let i=1;i<=doc.numPages;i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    partes.push((tc.items||[]).map(x=>x.str||'').join(' '));
  }
  try { await doc.destroy(); } catch(_) {}
  return partes.join('\n');
}

async function extrairTextoPdf(buf) {
  try {
    const parsed = await pdfParse(buf);
    return String(parsed.text||'').slice(0,120000);
  } catch(e) {
    const senha = String(process.env.CARTAO_PDF_PASSWORD || '');
    const protegida = /password|encrypted|senha/i.test(`${e?.name||''} ${e?.message||''}`);
    if (!senha) {
      const err = new Error(protegida ? 'PDF protegido por senha. Configure CARTAO_PDF_PASSWORD no Railway.' : e.message);
      err.codigo = protegida ? 'PDF_PROTEGIDO' : 'PDF_INVALIDO'; throw err;
    }
    try { return (await extrairPdfComPdfJs(buf, senha)).slice(0,120000); }
    catch(e2) {
      const err = new Error(/password|senha/i.test(`${e2?.name||''} ${e2?.message||''}`)
        ? 'A senha configurada não abriu este PDF.' : `Não foi possível abrir o PDF protegido: ${e2.message}`);
      err.codigo='PDF_PROTEGIDO'; throw err;
    }
  }
}

async function colunasTabela(nome) {
  if (colunasCache.has(nome)) return colunasCache.get(nome);
  const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[nome]);
  const set = new Set(rows.map(r=>r.column_name)); colunasCache.set(nome,set); return set;
}

async function inserirDinamico(client, tabela, dados) {
  const cols = await colunasTabela(tabela);
  const pares = Object.entries(dados).filter(([k,v])=>cols.has(k) && v !== undefined);
  if (!pares.length) throw new Error(`Nenhuma coluna compatível para ${tabela}`);
  const nomes = pares.map(([k])=>`"${k}"`).join(',');
  const vals = pares.map(([,v])=>v);
  const marks = pares.map((_,i)=>`$${i+1}`).join(',');
  const { rows } = await client.query(`INSERT INTO ${tabela} (${nomes}) VALUES (${marks}) RETURNING id`, vals);
  return rows[0]?.id;
}

async function interpretarArquivo(fileId) {
  const { meta, buf } = await baixarArquivo(fileId);
  const mime = String(meta.mimeType||'').toLowerCase();
  if (!(mime.includes('pdf') || String(meta.name||'').toLowerCase().endsWith('.pdf'))) {
    const e = new Error('A interpretação automática desta etapa aceita faturas em PDF.'); e.status=415; throw e;
  }
  const texto = await extrairTextoPdf(buf);
  const preview = interpretarFatura(texto, meta.name);
  return { meta, texto, preview };
}

r.get('/status', async (req,res) => {
  const c = cfg();
  if (!c.ok) return res.json({ ok:true, configurado:false, faltando:[
    !c.email?'GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL':null,
    !c.key?'GOOGLE_DRIVE_PRIVATE_KEY':null,
    !c.folderId?'GOOGLE_DRIVE_FATURAS_FOLDER_ID':null
  ].filter(Boolean) });
  try {
    await getToken(); const pasta = await tentarMetadataPasta(c.folderId);
    res.json({ ok:true, configurado:true, conectado:true, contaServico:c.email, pastaConfiguradaId:c.folderId, pasta });
  } catch(e) {
    res.json({ ok:true, configurado:true, conectado:false, contaServico:c.email, pastaConfiguradaId:c.folderId, erro:e.message });
  }
});

r.get('/arquivos', async (req,res) => {
  const c = cfg();
  if (!c.ok) return res.status(503).json({ ok:false, erro:'Google Drive ainda não configurado no Railway' });
  try {
    await getToken(); let encontrados=[], metodo='consulta_por_pasta', erroConsultaDireta=null;
    try {
      const resp = await driveFetch(arquivosUrl(c.folderId, req.query.limit));
      const data = await resp.json(); encontrados = data.files || [];
    } catch(e) { erroConsultaDireta = e.message; }
    let visiveis=[];
    if (!encontrados.length) {
      metodo='varredura_visiveis'; visiveis = await listarVisiveis(5);
      encontrados = visiveis.filter(f => Array.isArray(f.parents) && f.parents.includes(c.folderId));
    }
    const files = encontrados.filter(compativel); const pasta = await tentarMetadataPasta(c.folderId);
    const candidatosFatura = visiveis.filter(pareceFatura).slice(0,12).map(f => ({ id:f.id,nome:f.name,mimeType:f.mimeType,parents:f.parents||[] }));
    const amostra = (visiveis.length ? visiveis : encontrados).slice(0,8).map(f => ({ id:f.id,nome:f.name,mimeType:f.mimeType,parents:f.parents||[] }));
    const diagnostico = { contaServico:c.email,pastaConfiguradaId:c.folderId,pasta,metodo,erroConsultaDireta,itensEncontrados:encontrados.length,arquivosCompativeis:files.length,itensVisiveisConta:visiveis.length||null,candidatosFaturaVisiveis:candidatosFatura,amostraVisivel:amostra };
    console.info('[Agente Financeiro][Drive]', JSON.stringify({ contaServico:diagnostico.contaServico,pastaConfiguradaId:diagnostico.pastaConfiguradaId,pastaAcessivel:diagnostico.pasta?.acessivel,metodo,itensEncontrados:diagnostico.itensEncontrados,arquivosCompativeis:diagnostico.arquivosCompativeis,itensVisiveisConta:diagnostico.itensVisiveisConta,candidatosFaturaVisiveis:candidatosFatura.map(f=>({nome:f.nome,parents:f.parents})) }));
    res.json({ ok:true, data:files, diagnostico });
  } catch(e) {
    console.error('[Agente Financeiro][Drive] falha na listagem:', e.message);
    res.status(502).json({ ok:false, erro:e.message, diagnostico:{ contaServico:c.email, pastaConfiguradaId:c.folderId } });
  }
});

r.post('/extrair', express.json({limit:'100kb'}), async (req,res) => {
  const fileId = String(req.body?.fileId||'').trim(); if (!fileId) return res.status(400).json({ ok:false, erro:'fileId obrigatório' });
  try {
    const {meta,buf}=await baixarArquivo(fileId); const mime=String(meta.mimeType||'').toLowerCase(), nome=String(meta.name||'');
    let tipo='desconhecido', texto='', linhas=[];
    if (mime.includes('pdf') || nome.toLowerCase().endsWith('.pdf')) { tipo='pdf'; texto=await extrairTextoPdf(buf); }
    else if (/sheet|excel|spreadsheet/.test(mime) || /\.(xlsx?|xls)$/i.test(nome)) {
      tipo='planilha'; const wb=XLSX.read(buf,{type:'buffer'});
      for (const wsName of wb.SheetNames.slice(0,5)) linhas.push({aba:wsName,linhas:XLSX.utils.sheet_to_json(wb.Sheets[wsName],{header:1,defval:''}).slice(0,1500)});
    } else { tipo='texto'; texto=buf.toString('utf8').slice(0,120000); }
    res.json({ ok:true, arquivo:meta, tipo, texto, planilhas:linhas });
  } catch(e) { res.status(e.status||502).json({ ok:false, erro:e.message, codigo:e.codigo||null }); }
});

// Interpreta novamente no servidor; nenhum dado financeiro é gravado nesta etapa.
r.post('/interpretar', express.json({limit:'100kb'}), async (req,res) => {
  const fileId=String(req.body?.fileId||'').trim(); if(!fileId) return res.status(400).json({ok:false,erro:'fileId obrigatório'});
  try {
    const {meta,preview}=await interpretarArquivo(fileId);
    if (!preview.ok) return res.status(422).json(preview);
    res.json({ok:true,arquivo:{id:meta.id,name:meta.name},preview});
  } catch(e) { res.status(e.status||502).json({ok:false,erro:e.message,codigo:e.codigo||null}); }
});

// Importação idempotente: só grava quando o total líquido fecha e não existe fatura do mesmo cartão/competência.
r.post('/importar', express.json({limit:'100kb'}), async (req,res) => {
  if (req.user?.perfil === 'contabil') return res.status(403).json({ok:false,erro:'Perfil contábil tem acesso somente leitura'});
  const fileId=String(req.body?.fileId||'').trim();
  const confirmacaoHash=String(req.body?.previewHash||'').trim();
  if(!fileId||!confirmacaoHash) return res.status(400).json({ok:false,erro:'fileId e previewHash são obrigatórios'});
  let client;
  try {
    const {meta,preview}=await interpretarArquivo(fileId);
    if (!preview.ok) return res.status(422).json(preview);
    if (!preview.conferencia_ok) return res.status(409).json({ok:false,codigo:'DIVERGENCIA_TOTAL',erro:`A soma dos lançamentos difere da fatura em R$ ${Math.abs(preview.diferenca).toFixed(2)}. Importação bloqueada.`,preview});
    if (preview.preview_hash !== confirmacaoHash) return res.status(409).json({ok:false,codigo:'PREVIEW_ALTERADO',erro:'O conteúdo da fatura mudou desde a prévia. Analise novamente antes de importar.'});

    client=await pool.connect(); await client.query('BEGIN');
    const criadas=[], conflitos=[];
    const colsFatura=await colunasTabela('cartao_faturas');
    const temHash=colsFatura.has('hash_fatura');
    for (const cartao of preview.cartoes) {
      const hf=sha(`${fileId}|${preview.preview_hash}|${cartao.final}`);
      let existente;
      if (temHash) {
        const q=await client.query(`SELECT id,cartao,competencia,valor_total FROM cartao_faturas WHERE hash_fatura=$1 LIMIT 1`,[hf]); existente=q.rows[0];
      }
      if (!existente) {
        const q=await client.query(`SELECT id,cartao,competencia,valor_total FROM cartao_faturas WHERE cartao=$1 AND competencia=$2 LIMIT 1`,[cartao.cartao,preview.competencia]); existente=q.rows[0];
      }
      if (existente) { conflitos.push({cartao:cartao.cartao,id:existente.id,valor_total:Number(existente.valor_total||0)}); continue; }

      const faturaId=await inserirDinamico(client,'cartao_faturas',{
        loja_id:req.user.lojaId, cartao:cartao.cartao, bandeira:cartao.bandeira,
        competencia:preview.competencia, vencimento:preview.vencimento,
        valor_total:cartao.valor_total, qtd_itens:cartao.qtd_itens,
        arquivo_nome:meta.name, hash_fatura:hf, fatura_id_ref:`DRIVE:${fileId}:${cartao.final}`,
        status:'IMPORTADA', situacao:'AGENTE_DRIVE', usuario_id:req.user.id,
        log_json:JSON.stringify([{em:new Date().toISOString(),acao:'IMPORTADA_PELO_AGENTE_FINANCEIRO',arquivo:meta.name,fileId}])
      });
      let itensCriados=0;
      for (const it of cartao.itens) {
        await inserirDinamico(client,'cartao_fatura_itens',{
          loja_id:req.user.lojaId, fatura_id:faturaId, data_compra:it.data_compra,
          descricao:it.descricao, valor:it.valor, categoria_dre:null,
          portador:cartao.portador, hash_item:it.hash_item, removido:false
        });
        itensCriados++;
      }
      criadas.push({id:faturaId,cartao:cartao.cartao,valor_total:cartao.valor_total,itens:itensCriados});
    }
    if (conflitos.length) {
      await client.query('ROLLBACK'); client.release(); client=null;
      return res.status(409).json({ok:false,codigo:'FATURA_EXISTENTE',erro:'Já existe fatura para um ou mais cartões nesta competência. Nada foi duplicado.',conflitos,preview});
    }
    await client.query('COMMIT'); client.release(); client=null;
    res.json({ok:true,importadas:criadas,competencia:preview.competencia,valor_total:preview.valor_total_fatura,qtd_itens:preview.qtd_itens});
  } catch(e) {
    if(client){try{await client.query('ROLLBACK')}catch(_){} try{client.release()}catch(_){}}
    console.error('[Agente Financeiro][Importação]',e.message);
    res.status(e.status||500).json({ok:false,erro:e.message,codigo:e.codigo||null});
  }
});

module.exports = r;
