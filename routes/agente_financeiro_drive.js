const express = require('express');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const autenticar = require('../middleware/auth');

const r = express.Router();
r.use(autenticar(['admin','financeiro','contabil']));

let tokenCache = { token: null, exp: 0 };

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
  signer.update(`${header}.${payload}`);
  signer.end();
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
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  return `https://www.googleapis.com/drive/v3/files?${p.toString()}`;
}

function visiveisUrl(pageSize=100, pageToken='') {
  const p = new URLSearchParams({
    q: 'trashed = false',
    pageSize: String(Math.min(Math.max(Number(pageSize)||100,1),100)),
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,webViewLink,parents)',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
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
  const todos=[];
  let token='';
  for (let pagina=0; pagina<maxPaginas; pagina++) {
    const resp = await driveFetch(visiveisUrl(100, token));
    const data = await resp.json();
    todos.push(...(data.files||[]));
    token = data.nextPageToken || '';
    if (!token) break;
  }
  return todos;
}

async function tentarMetadataPasta(folderId) {
  try {
    const meta = await metadata(folderId);
    return { acessivel:true, id:meta.id, nome:meta.name, mimeType:meta.mimeType };
  } catch(e) {
    return { acessivel:false, erro:e.message, status:e.status || null };
  }
}

function compativel(f) {
  return /pdf|spreadsheet|excel|csv|text/i.test(`${f.mimeType||''} ${f.name||''}`);
}

r.get('/status', async (req,res) => {
  const c = cfg();
  if (!c.ok) return res.json({ ok:true, configurado:false, faltando:[
    !c.email?'GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL':null,
    !c.key?'GOOGLE_DRIVE_PRIVATE_KEY':null,
    !c.folderId?'GOOGLE_DRIVE_FATURAS_FOLDER_ID':null
  ].filter(Boolean) });
  try {
    await getToken();
    const pasta = await tentarMetadataPasta(c.folderId);
    res.json({
      ok:true,
      configurado:true,
      conectado:true,
      contaServico:c.email,
      pastaConfiguradaId:c.folderId,
      pasta
    });
  } catch(e) {
    res.json({
      ok:true,
      configurado:true,
      conectado:false,
      contaServico:c.email,
      pastaConfiguradaId:c.folderId,
      erro:e.message
    });
  }
});

r.get('/arquivos', async (req,res) => {
  const c = cfg();
  if (!c.ok) return res.status(503).json({ ok:false, erro:'Google Drive ainda não configurado no Railway' });
  try {
    await getToken();
    let encontrados=[];
    let metodo='consulta_por_pasta';
    let erroConsultaDireta=null;

    try {
      const resp = await driveFetch(arquivosUrl(c.folderId, req.query.limit));
      const data = await resp.json();
      encontrados = data.files || [];
    } catch(e) {
      erroConsultaDireta = e.message;
    }

    let visiveis=[];
    if (!encontrados.length) {
      metodo='varredura_visiveis';
      visiveis = await listarVisiveis(5);
      encontrados = visiveis.filter(f => Array.isArray(f.parents) && f.parents.includes(c.folderId));
    }

    const files = encontrados.filter(compativel);
    const pasta = await tentarMetadataPasta(c.folderId);
    const amostra = (visiveis.length ? visiveis : encontrados).slice(0,8).map(f => ({
      id:f.id,
      nome:f.name,
      mimeType:f.mimeType,
      parents:f.parents||[]
    }));

    res.json({
      ok:true,
      data:files,
      diagnostico:{
        contaServico:c.email,
        pastaConfiguradaId:c.folderId,
        pasta,
        metodo,
        erroConsultaDireta,
        itensEncontrados:encontrados.length,
        arquivosCompativeis:files.length,
        itensVisiveisConta:visiveis.length || null,
        amostraVisivel:amostra
      }
    });
  } catch(e) {
    res.status(502).json({
      ok:false,
      erro:e.message,
      diagnostico:{ contaServico:c.email, pastaConfiguradaId:c.folderId }
    });
  }
});

r.post('/extrair', express.json({limit:'100kb'}), async (req,res) => {
  const c = cfg();
  const fileId = String(req.body?.fileId||'').trim();
  if (!c.ok) return res.status(503).json({ ok:false, erro:'Google Drive ainda não configurado no Railway' });
  if (!fileId) return res.status(400).json({ ok:false, erro:'fileId obrigatório' });
  try {
    const meta = await metadata(fileId);
    if (!(meta.parents||[]).includes(c.folderId)) return res.status(403).json({ ok:false, erro:'Arquivo fora da pasta financeira configurada' });
    const dl = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const mime = String(meta.mimeType||'').toLowerCase();
    const nome = String(meta.name||'');
    let tipo='desconhecido', texto='', linhas=[];
    if (mime.includes('pdf') || nome.toLowerCase().endsWith('.pdf')) {
      tipo='pdf';
      const parsed = await pdfParse(buf);
      texto = String(parsed.text||'').slice(0,120000);
    } else if (/sheet|excel|spreadsheet/.test(mime) || /\.(xlsx?|xls)$/i.test(nome)) {
      tipo='planilha';
      const wb = XLSX.read(buf,{type:'buffer'});
      for (const wsName of wb.SheetNames.slice(0,5)) {
        const ws = wb.Sheets[wsName];
        const rows = XLSX.utils.sheet_to_json(ws,{header:1,defval:''}).slice(0,1500);
        linhas.push({aba:wsName,linhas:rows});
      }
    } else {
      tipo='texto';
      texto = buf.toString('utf8').slice(0,120000);
    }
    res.json({ ok:true, arquivo:meta, tipo, texto, planilhas:linhas });
  } catch(e) { res.status(502).json({ ok:false, erro:e.message }); }
});

module.exports = r;
