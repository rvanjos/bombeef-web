'use strict';

const express = require('express');
const { Pool } = require('pg');
const autenticar = require('../middleware/auth');
const { protegerPoolPorLoja, executarComoSistema } = require('../lib/tenant-context');

const r = express.Router();
r.use(express.json({ limit:'1mb' }));
r.use(autenticar(['admin','financeiro','contabil']));

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized:false } : false;
const pool = protegerPoolPorLoja(new Pool({ connectionString:process.env.DATABASE_URL, ssl }));

let initPromise=null;
function init(){
  if(initPromise) return initPromise;
  initPromise=executarComoSistema(async()=>{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dre_planejamento_anual (
        id BIGSERIAL PRIMARY KEY,
        loja_id INTEGER NOT NULL,
        ano INTEGER NOT NULL,
        dados_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        observacoes TEXT,
        usuario_id INTEGER,
        usuario_nome TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(loja_id, ano)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_plan_loja_ano ON dre_planejamento_anual(loja_id,ano)`);
    await pool.query(`ALTER TABLE dre_planejamento_anual ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE dre_planejamento_anual FORCE ROW LEVEL SECURITY`);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='dre_planejamento_anual' AND policyname='dre_plan_loja'
      ) THEN
        CREATE POLICY dre_plan_loja ON dre_planejamento_anual
        USING (current_setting('app.bb_system', true)='1' OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::INTEGER)
        WITH CHECK (current_setting('app.bb_system', true)='1' OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::INTEGER);
      END IF;
    END $$`);
  });
  return initPromise;
}

function anoValido(v){
  const n=Number(v);
  return Number.isInteger(n)&&n>=2020&&n<=2100?n:null;
}
function sanitizarDados(v){
  if(!v||typeof v!=='object'||Array.isArray(v)) return {};
  const out={};
  for(const [categoria, meses] of Object.entries(v)){
    const cat=String(categoria||'').trim().slice(0,180);
    if(!cat||!meses||typeof meses!=='object'||Array.isArray(meses)) continue;
    out[cat]={};
    for(let m=1;m<=12;m++){
      const mm=String(m).padStart(2,'0');
      const n=Number(meses[mm]??meses[m]??0);
      out[cat][mm]=Number.isFinite(n)?Math.round(n*100)/100:0;
    }
  }
  return out;
}

r.get('/:ano', async(req,res)=>{
  try{
    await init();
    const ano=anoValido(req.params.ano);
    if(!ano) return res.status(400).json({ok:false,erro:'Ano inválido'});
    const lojaId=Number(req.user.lojaId);
    const {rows}=await pool.query(
      `SELECT ano,dados_json,observacoes,usuario_id,usuario_nome,criado_em,atualizado_em
         FROM dre_planejamento_anual WHERE loja_id=$1 AND ano=$2`,
      [lojaId,ano]
    );
    res.json({ok:true,data:rows[0]||{ano,dados_json:{},observacoes:null}});
  }catch(e){res.status(500).json({ok:false,erro:e.message});}
});

r.put('/:ano', async(req,res)=>{
  if(req.user?.perfil==='contabil') return res.status(403).json({ok:false,erro:'Perfil contábil tem acesso somente leitura'});
  try{
    await init();
    const ano=anoValido(req.params.ano);
    if(!ano) return res.status(400).json({ok:false,erro:'Ano inválido'});
    const lojaId=Number(req.user.lojaId);
    const dados=sanitizarDados(req.body?.dados);
    const observacoes=String(req.body?.observacoes||'').slice(0,4000)||null;
    const {rows}=await pool.query(`
      INSERT INTO dre_planejamento_anual
        (loja_id,ano,dados_json,observacoes,usuario_id,usuario_nome,criado_em,atualizado_em)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,NOW(),NOW())
      ON CONFLICT(loja_id,ano) DO UPDATE SET
        dados_json=EXCLUDED.dados_json,
        observacoes=EXCLUDED.observacoes,
        usuario_id=EXCLUDED.usuario_id,
        usuario_nome=EXCLUDED.usuario_nome,
        atualizado_em=NOW()
      RETURNING ano,dados_json,observacoes,usuario_id,usuario_nome,atualizado_em
    `,[lojaId,ano,JSON.stringify(dados),observacoes,req.user.id||null,req.user.nome||req.user.usuario||null]);
    res.json({ok:true,data:rows[0]});
  }catch(e){res.status(500).json({ok:false,erro:e.message});}
});

module.exports=r;
