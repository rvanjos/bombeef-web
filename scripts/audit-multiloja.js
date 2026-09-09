'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const { auditarSegurancaMultiloja } = require('../lib/multiloja-security');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

(async () => {
  try {
    const r = await auditarSegurancaMultiloja(pool, { aplicarPoliticas: true });
    console.log(`[multiloja/auditor] tabelas verificadas: ${r.tabelas.length}`);
    console.log(`[multiloja/auditor] críticas: ${r.criticos.length}; avisos: ${r.avisos.length}`);
    if (r.criticos.length) {
      for (const item of r.criticos) console.warn(`[multiloja/auditor] CRÍTICO ${item.tabela}: ${item.problemas.join(', ')}`);
    }
    if (r.avisos.length) {
      for (const item of r.avisos.slice(0, 30)) console.warn(`[multiloja/auditor] aviso ${item.tabela}: ${item.problemas.join(', ')}`);
      if (r.avisos.length > 30) console.warn(`[multiloja/auditor] +${r.avisos.length - 30} aviso(s)`);
    }
    console.log(`[multiloja/auditor] segurança operacional: ${r.ok ? 'OK' : 'PENDENTE'}`);
  } catch (e) {
    // Auditoria nunca derruba produção. Em caso de falha, a loja nova continua
    // bloqueada pelo status estrutural já existente e o problema fica no log.
    console.error('[multiloja/auditor] falha não bloqueante:', e.message);
  } finally {
    await pool.end().catch(() => {});
  }
})();
