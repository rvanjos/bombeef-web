'use strict';

const express = require('express');
const { Pool } = require('pg');
const autenticar = require('../middleware/auth');
const { protegerPoolPorLoja, executarComoSistema } = require('../lib/tenant-context');

const r = express.Router();
r.use(express.json({ limit:'200kb' }));
r.use(autenticar(['admin','financeiro','contabil']));

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized:false } : false;
const pool = protegerPoolPorLoja(new Pool({ connectionString:process.env.DATABASE_URL, ssl }));

let initPromise = null;
function init(){
  if(initPromise) return initPromise;
  initPromise = executarComoSistema(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dre_conferencia_decisoes (
        id BIGSERIAL PRIMARY KEY,
        loja_id INTEGER NOT NULL,
        chave VARCHAR(220) NOT NULL,
        tipo VARCHAR(60) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'VALIDADO',
        decisao VARCHAR(60) NOT NULL,
        escopo VARCHAR(30) NOT NULL DEFAULT 'MES',
        mes_ref VARCHAR(7),
        fornecedor_norm TEXT,
        categorias_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        justificativa TEXT,
        metadados JSONB NOT NULL DEFAULT '{}'::jsonb,
        usuario_id INTEGER,
        usuario_nome TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(loja_id, chave)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_conf_dec_loja_mes ON dre_conferencia_decisoes(loja_id, mes_ref)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dre_conf_dec_fornecedor ON dre_conferencia_decisoes(loja_id, fornecedor_norm)`);
    await pool.query(`ALTER TABLE dre_conferencia_decisoes ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE dre_conferencia_decisoes FORCE ROW LEVEL SECURITY`);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dre_conferencia_decisoes' AND policyname='dre_conf_decisoes_loja') THEN
        CREATE POLICY dre_conf_decisoes_loja ON dre_conferencia_decisoes
          USING (current_setting('app.bb_system', true)='1' OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::INTEGER)
          WITH CHECK (current_setting('app.bb_system', true)='1' OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::INTEGER);
      END IF;
    END $$`);
  });
  return initPromise;
}

function texto(v, max){
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0,max) : s;
}
function arr(v){ return Array.isArray(v) ? v.map(x=>texto(x,180)).filter(Boolean) : []; }

r.get('/decisoes', async (req,res) => {
  try{
    await init();
    const lojaId = Number(req.user.lojaId);
    const mes = texto(req.query.mes_ref,7);
    const params = [lojaId];
    let where = 'loja_id=$1';
    if(mes){ params.push(mes); where += ` AND (mes_ref=$${params.length} OR escopo='FORNECEDOR')`; }
    const { rows } = await pool.query(`
      SELECT id,chave,tipo,status,decisao,escopo,mes_ref,fornecedor_norm,categorias_json,
             justificativa,metadados,usuario_id,usuario_nome,criado_em,atualizado_em
        FROM dre_conferencia_decisoes
       WHERE ${where}
       ORDER BY atualizado_em DESC
    `, params);
    res.json({ok:true,data:rows});
  }catch(e){ res.status(500).json({ok:false,erro:e.message}); }
});

r.post('/decisoes', async (req,res) => {
  if(req.user?.perfil === 'contabil') return res.status(403).json({ok:false,erro:'Perfil contábil tem acesso somente leitura'});
  try{
    await init();
    const lojaId = Number(req.user.lojaId);
    const chave = texto(req.body?.chave,220);
    const tipo = texto(req.body?.tipo,60) || 'CATEGORIA_INCONSISTENTE';
    const status = texto(req.body?.status,20).toUpperCase();
    const decisao = texto(req.body?.decisao,60).toUpperCase();
    const escopo = texto(req.body?.escopo,30).toUpperCase() || 'MES';
    const mesRef = texto(req.body?.mes_ref,7) || null;
    const fornecedorNorm = texto(req.body?.fornecedor_norm,400) || null;
    const categorias = arr(req.body?.categorias);
    const justificativa = texto(req.body?.justificativa,2000) || null;
    const metadados = req.body?.metadados && typeof req.body.metadados === 'object' ? req.body.metadados : {};
    if(!chave) return res.status(400).json({ok:false,erro:'chave obrigatória'});
    if(!['VALIDADO','CORRIGIDO'].includes(status)) return res.status(400).json({ok:false,erro:'status inválido'});
    if(!['MES','FORNECEDOR'].includes(escopo)) return res.status(400).json({ok:false,erro:'escopo inválido'});
    const { rows } = await pool.query(`
      INSERT INTO dre_conferencia_decisoes
        (loja_id,chave,tipo,status,decisao,escopo,mes_ref,fornecedor_norm,categorias_json,justificativa,metadados,usuario_id,usuario_nome,criado_em,atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,NOW(),NOW())
      ON CONFLICT (loja_id,chave) DO UPDATE SET
        tipo=EXCLUDED.tipo,status=EXCLUDED.status,decisao=EXCLUDED.decisao,escopo=EXCLUDED.escopo,
        mes_ref=EXCLUDED.mes_ref,fornecedor_norm=EXCLUDED.fornecedor_norm,categorias_json=EXCLUDED.categorias_json,
        justificativa=EXCLUDED.justificativa,metadados=EXCLUDED.metadados,usuario_id=EXCLUDED.usuario_id,
        usuario_nome=EXCLUDED.usuario_nome,atualizado_em=NOW()
      RETURNING *
    `,[lojaId,chave,tipo,status,decisao,escopo,mesRef,fornecedorNorm,JSON.stringify(categorias),justificativa,JSON.stringify(metadados),req.user.id||null,req.user.nome||req.user.usuario||null]);
    res.json({ok:true,data:rows[0]});
  }catch(e){ res.status(500).json({ok:false,erro:e.message}); }
});

r.delete('/decisoes/:chave', async (req,res) => {
  if(req.user?.perfil === 'contabil') return res.status(403).json({ok:false,erro:'Perfil contábil tem acesso somente leitura'});
  try{
    await init();
    const lojaId = Number(req.user.lojaId);
    const chave = decodeURIComponent(String(req.params.chave||''));
    await pool.query(`DELETE FROM dre_conferencia_decisoes WHERE loja_id=$1 AND chave=$2`,[lojaId,chave]);
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,erro:e.message}); }
});

module.exports = r;
