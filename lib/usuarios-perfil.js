'use strict';
const crypto=require('node:crypto');
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERFIS=['admin','gestor','financeiro','estoque','caixa','contabil'];
function dadosPerfil(body={}){
 const d={};for(const [k,max] of [['telefone',30],['cargo',100],['departamento',100],['nome_social',120]])if(body[k]!==undefined){if(typeof body[k]!=='string'||body[k].length>max)throw Error('Campo inválido: '+k);d[k]=body[k].trim();}
 if(body.email_notificacoes!==undefined){const e=String(body.email_notificacoes||'').trim().toLowerCase();if(e.length>254||(e&&!EMAIL.test(e)))throw Error('Informe um e-mail válido para avisos');d.email_notificacoes=e||null;}
 if(body.avisos_email!==undefined){if(typeof body.avisos_email!=='boolean')throw Error('Preferência de avisos inválida');d.avisos_email=body.avisos_email;}
 return d;
}
async function garantirPerfil(pool){
 await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone TEXT NOT NULL DEFAULT '',ADD COLUMN IF NOT EXISTS cargo TEXT NOT NULL DEFAULT '',ADD COLUMN IF NOT EXISTS departamento TEXT NOT NULL DEFAULT '',ADD COLUMN IF NOT EXISTS nome_social TEXT NOT NULL DEFAULT '',ADD COLUMN IF NOT EXISTS email_notificacoes TEXT,ADD COLUMN IF NOT EXISTS email_confirmado_em TIMESTAMPTZ,ADD COLUMN IF NOT EXISTS avisos_email BOOLEAN NOT NULL DEFAULT false,ADD COLUMN IF NOT EXISTS email_codigo_hash TEXT,ADD COLUMN IF NOT EXISTS email_codigo_expira TIMESTAMPTZ,ADD COLUMN IF NOT EXISTS email_codigo_tentativas INTEGER NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS email_codigo_enviado_em TIMESTAMPTZ`);
 await pool.query(`CREATE TABLE IF NOT EXISTS rh_email_avisos(id BIGSERIAL PRIMARY KEY,loja_id INTEGER NOT NULL,documento_id INTEGER NOT NULL,usuario_id INTEGER NOT NULL REFERENCES usuarios(id),email_destino TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pendente',tentativas INTEGER NOT NULL DEFAULT 0,criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),enviado_em TIMESTAMPTZ,erro TEXT,UNIQUE(documento_id,usuario_id))`);
 await pool.query(`CREATE INDEX IF NOT EXISTS idx_rh_email_fila ON rh_email_avisos(loja_id,status,atualizado_em)`);
}
async function salvarPerfil(pool,id,body){
 const d=dadosPerfil(body),keys=Object.keys(d);if(!keys.length)return;
 const values=keys.map(k=>d[k]);values.push(id);
 const email=keys.indexOf('email_notificacoes');
 const reset=email<0?'':`,email_confirmado_em=CASE WHEN email_notificacoes IS DISTINCT FROM $${email+1} THEN NULL ELSE email_confirmado_em END,email_codigo_hash=CASE WHEN email_notificacoes IS DISTINCT FROM $${email+1} THEN NULL ELSE email_codigo_hash END`;
 await pool.query(`UPDATE usuarios SET ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')}${reset},atualizado_em=NOW() WHERE id=$${values.length}`,values);
}
const hashCodigo=(id,email,code)=>crypto.createHash('sha256').update(id+'|'+email+'|'+code).digest('hex');
module.exports={EMAIL,PERFIS,dadosPerfil,garantirPerfil,salvarPerfil,hashCodigo};
