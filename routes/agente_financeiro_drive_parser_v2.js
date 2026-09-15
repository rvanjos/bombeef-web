'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const autenticar = require('../middleware/auth');
const { protegerPoolPorLoja } = require('../lib/tenant-context');
const { interpretarFatura } = require('../lib/cartao-fatura-parser');
const { extrairTextosPdf } = require('../lib/pdf-layout-extractor');
const { interpretarComIa } = require('../lib/cartao-fatura-ai');

const r = express.Router();
r.use(autenticar(['admin','financeiro','contabil']));

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized:false } : false;
const pool = protegerPoolPorLoja(new Pool({ connectionString:process.env.DATABASE_URL, ssl }));
const colunasCache = new Map();
let tokenCache = { token:null, exp:0 };

function folderId() {
  const raw = String(process.env.GOOGLE_DRIVE_FATURAS_FOLDER_ID || '').trim().replace(/^['"]|['"]$/g,'');
  const m = raw.match(/\/folders\/([A-Za-z0-9_-]+)/) || raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : raw;
}
function b64url(input) { return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function sha(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

async function tokenGoogle() {
  const email=String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL||'').trim();
  const key=String(process.env.GOOGLE_DRIVE_PRIVATE_KEY||'').replace(/\\n/g,'\n');
  if(!email||!key||!folderId()) throw Object.assign(new Error('Google Drive não configurado'),{status:503});
  const now=Math.floor(Date.now()/1000);
  if(tokenCache.token && tokenCache.exp>now+60) return tokenCache.token;
  const h=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const p=b64url(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
  const signer=crypto.createSign('RSA-SHA256'); signer.update(`${h}.${p}`); signer.end();
  const assertion=`${h}.${p}.${b64url(signer.sign(key))}`;
  const resp=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const data=await resp.json();
  if(!resp.ok||!data.access_token) throw new Error(data.error_description||data.error||'Falha ao autenticar no Google Drive');
  tokenCache={token:data.access_token,exp:now+Number(data.expires_in||3600)};
  return tokenCache.token;
}

async function driveJson(url) {
  const resp=await fetch(url,{headers:{authorization:`Bearer ${await tokenGoogle()}`}});
  if(!resp.ok) throw Object.assign(new Error(`Google Drive ${resp.status}: ${(await resp.text()).slice(0,180)}`),{status:resp.status});
  return resp.json();
}
async function baixar(fileId) {
  const fields=encodeURIComponent('id,name,mimeType,parents');
  const meta=await driveJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`);
  if(!(meta.parents||[]).includes(folderId())) throw Object.assign(new Error('Arquivo fora da pasta financeira configurada'),{status:403});
  const resp=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,{headers:{authorization:`Bearer ${await tokenGoogle()}`}});
  if(!resp.ok) throw Object.assign(new Error(`Falha ao baixar PDF do Drive (${resp.status})`),{status:502});
  return {meta,buf:Buffer.from(await resp.arrayBuffer())};
}

function qualidade(preview) {
  if(!preview?.ok) return [999999,0];
  return [Math.abs(Number(preview.diferenca||0)), -Number(preview.qtd_itens||0)];
}
function melhorPreview(candidatos) {
  return candidatos.filter(Boolean).sort((a,b)=>{
    const qa=qualidade(a), qb=qualidade(b);
    return qa[0]-qb[0] || qa[1]-qb[1];
  })[0] || null;
}

async function interpretarArquivo(fileId) {
  const {meta,buf}=await baixar(fileId);
  if(!/pdf/i.test(String(meta.mimeType||'')) && !/\.pdf$/i.test(String(meta.name||''))) throw Object.assign(new Error('Esta etapa aceita faturas em PDF.'),{status:415});
  const senha=String(process.env.CARTAO_PDF_PASSWORD||'');
  let textos;
  try { textos=await extrairTextosPdf(buf,senha); }
  catch(e) {
    const protegida=/password|encrypted|senha/i.test(`${e?.name||''} ${e?.message||''}`);
    const err=new Error(protegida && !senha ? 'PDF protegido por senha. Configure CARTAO_PDF_PASSWORD no Railway.' : e.message);
    err.status=422; err.codigo=protegida?'PDF_PROTEGIDO':'PDF_INVALIDO'; throw err;
  }

  const candidatos=[];
  if(textos.sequencial) candidatos.push({...interpretarFatura(textos.sequencial,meta.name),_origem:'sequencial'});
  if(textos.estruturado) candidatos.push({...interpretarFatura(textos.estruturado,meta.name),_origem:'layout'});
  if(textos.bruto) candidatos.push({...interpretarFatura(textos.bruto,meta.name),_origem:'bruto'});
  let preview=melhorPreview(candidatos);
  let iaTentada=false, iaErro=null;

  console.info('[Agente Financeiro][Parser candidatos]',JSON.stringify(candidatos.map(c=>({metodo:c._origem,ok:c.ok,itens:c.qtd_itens||0,diferenca:c.diferenca??null,confere:Boolean(c.conferencia_ok)}))));

  if(!preview?.conferencia_ok && process.env.ANTHROPIC_API_KEY) {
    iaTentada=true;
    try {
      const fonteIa = [textos.sequencial, textos.bruto, textos.estruturado]
        .filter(Boolean)
        .filter((v,i,a)=>a.indexOf(v)===i)
        .sort((a,b)=>b.length-a.length)
        .join('\n\n--- LEITURA ALTERNATIVA DO MESMO PDF ---\n\n')
        .slice(0,50000);
      const ia=await interpretarComIa(fonteIa,meta.name);
      if(ia) candidatos.push({...ia,_origem:'ia'});
      preview=melhorPreview(candidatos);
    } catch(e) {
      iaErro=e.message;
      console.warn('[Agente Financeiro][IA] fallback não concluído:',e.message);
    }
  }

  if(!preview) throw Object.assign(new Error('Não foi possível interpretar a fatura.'),{status:422});
  preview.metodo_extracao=preview._origem; delete preview._origem;
  preview.ia_tentada=iaTentada;
  if(iaErro) preview.ia_erro=iaErro;
  return {meta,preview};
}

async function colunasTabela(nome) {
  if(colunasCache.has(nome)) return colunasCache.get(nome);
  const {rows}=await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[nome]);
  const set=new Set(rows.map(r=>r.column_name)); colunasCache.set(nome,set); return set;
}
async function inserirDinamico(client,tabela,dados) {
  const cols=await colunasTabela(tabela);
  const pares=Object.entries(dados).filter(([k,v])=>cols.has(k)&&v!==undefined);
  const nomes=pares.map(([k])=>`"${k}"`).join(',');
  const vals=pares.map(([,v])=>v);
  const marks=pares.map((_,i)=>`$${i+1}`).join(',');
  const {rows}=await client.query(`INSERT INTO ${tabela} (${nomes}) VALUES (${marks}) RETURNING id`,vals);
  return rows[0]?.id;
}

r.post('/interpretar',express.json({limit:'100kb'}),async(req,res)=>{
  const fileId=String(req.body?.fileId||'').trim();
  if(!fileId) return res.status(400).json({ok:false,erro:'fileId obrigatório'});
  try {
    const {meta,preview}=await interpretarArquivo(fileId);
    if(!preview.ok) return res.status(422).json(preview);
    console.info('[Agente Financeiro][Parser v2]',JSON.stringify({arquivo:meta.name,metodo:preview.metodo_extracao,itens:preview.qtd_itens,diferenca:preview.diferenca,confere:preview.conferencia_ok,iaTentada:preview.ia_tentada,iaErro:preview.ia_erro||null}));
    res.json({ok:true,arquivo:{id:meta.id,name:meta.name},preview});
  } catch(e){res.status(e.status||502).json({ok:false,erro:e.message,codigo:e.codigo||null});}
});

r.post('/importar',express.json({limit:'100kb'}),async(req,res)=>{
  if(req.user?.perfil==='contabil') return res.status(403).json({ok:false,erro:'Perfil contábil tem acesso somente leitura'});
  const fileId=String(req.body?.fileId||'').trim(), confirmacaoHash=String(req.body?.previewHash||'').trim();
  if(!fileId||!confirmacaoHash) return res.status(400).json({ok:false,erro:'fileId e previewHash são obrigatórios'});
  let client;
  try {
    const {meta,preview}=await interpretarArquivo(fileId);
    if(!preview.ok) return res.status(422).json(preview);
    if(!preview.conferencia_ok) return res.status(409).json({ok:false,codigo:'DIVERGENCIA_TOTAL',erro:`A soma dos lançamentos difere da fatura em R$ ${Math.abs(preview.diferenca).toFixed(2)}. Importação bloqueada.`,preview});
    if(preview.preview_hash!==confirmacaoHash) return res.status(409).json({ok:false,codigo:'PREVIEW_ALTERADO',erro:'O conteúdo da fatura mudou desde a prévia. Analise novamente.'});
    client=await pool.connect(); await client.query('BEGIN');
    const criadas=[], conflitos=[];
    const colsFatura=await colunasTabela('cartao_faturas');
    for(const cartao of preview.cartoes){
      const hf=sha(`${fileId}|${preview.preview_hash}|${cartao.final}`);
      let existente=null;
      if(colsFatura.has('hash_fatura')) existente=(await client.query(`SELECT id,cartao,competencia,valor_total FROM cartao_faturas WHERE hash_fatura=$1 LIMIT 1`,[hf])).rows[0]||null;
      if(!existente) existente=(await client.query(`SELECT id,cartao,competencia,valor_total FROM cartao_faturas WHERE cartao=$1 AND competencia=$2 LIMIT 1`,[cartao.cartao,preview.competencia])).rows[0]||null;
      if(existente){conflitos.push({cartao:cartao.cartao,id:existente.id,valor_total:Number(existente.valor_total||0)});continue;}
      const faturaId=await inserirDinamico(client,'cartao_faturas',{loja_id:req.user.lojaId,cartao:cartao.cartao,bandeira:cartao.bandeira,competencia:preview.competencia,vencimento:preview.vencimento,valor_total:cartao.valor_total,qtd_itens:cartao.qtd_itens,arquivo_nome:meta.name,hash_fatura:hf,fatura_id_ref:`DRIVE:${fileId}:${cartao.final}`,status:'IMPORTADA',situacao:'AGENTE_DRIVE',usuario_id:req.user.id,log_json:JSON.stringify([{em:new Date().toISOString(),acao:'IMPORTADA_PELO_AGENTE_FINANCEIRO',arquivo:meta.name,fileId,metodo_extracao:preview.metodo_extracao}])});
      let itensCriados=0;
      for(const it of cartao.itens){
        if(Math.abs(Number(it.valor||0))<0.005) continue;
        await inserirDinamico(client,'cartao_fatura_itens',{loja_id:req.user.lojaId,fatura_id:faturaId,data_compra:it.data_compra,descricao:it.descricao,valor:it.valor,categoria_dre:null,portador:cartao.portador,hash_item:it.hash_item,removido:false}); itensCriados++;
      }
      criadas.push({id:faturaId,cartao:cartao.cartao,valor_total:cartao.valor_total,itens:itensCriados});
    }
    if(conflitos.length){await client.query('ROLLBACK');client.release();client=null;return res.status(409).json({ok:false,codigo:'FATURA_EXISTENTE',erro:'Já existe fatura para um ou mais cartões nesta competência. Nada foi duplicado.',conflitos,preview});}
    await client.query('COMMIT'); client.release(); client=null;
    res.json({ok:true,importadas:criadas,competencia:preview.competencia,valor_total:preview.valor_total_fatura,qtd_itens:preview.qtd_itens});
  } catch(e){if(client){try{await client.query('ROLLBACK')}catch(_){}try{client.release()}catch(_){}}res.status(e.status||500).json({ok:false,erro:e.message,codigo:e.codigo||null});}
});

module.exports=r;
