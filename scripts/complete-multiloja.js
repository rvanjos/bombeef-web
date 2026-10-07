'use strict';
require('dotenv').config();
const {Pool}=require('pg');
const {garantirEstruturaMultiloja}=require('../lib/multiloja');
const {auditarSegurancaMultiloja}=require('../lib/multiloja-security');
const {migrarChavesLegadas}=require('../lib/multiloja-legados');
const {executarComoSistema}=require('../lib/tenant-context');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,max:2,connectionTimeoutMillis:10000});
async function contarHistorico(tabelas){
  const c=await pool.connect();
  try{
    await c.query("SELECT set_config('app.bb_system','1',false)");
    if(!tabelas){const {rows}=await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('multiloja_migracoes','multiloja_modulos','multiloja_auditoria_status','empresas','lojas','usuario_lojas') ORDER BY tablename");tabelas=rows.map(r=>r.tablename);}
    const contagens={};
    for(const tabela of tabelas){const q='"'+tabela.replace(/"/g,'""')+'"';const {rows}=await c.query('SELECT COUNT(*)::text AS n FROM public.'+q);contagens[tabela]=rows[0].n;}
    return contagens;
  }finally{await c.query("SELECT set_config('app.bb_system','',false)");c.release();}
}
(async()=>{
  try{
    console.log('[multiloja/manutencao] iniciando validação controlada; sem exclusão de registros');
    const antes=await contarHistorico();
    console.log('[multiloja/manutencao] histórico inventariado',Object.keys(antes).length+' tabelas');
    await executarComoSistema(()=>garantirEstruturaMultiloja(pool,{operacional:true}));
    console.log('[multiloja/manutencao] migração estrutural concluída');
    const auditoria=await auditarSegurancaMultiloja(pool,{aplicarPoliticas:true});
    console.log('[multiloja/manutencao] auditoria',JSON.stringify({tabelas:auditoria.tabelas.length,criticos:auditoria.criticos,avisos:auditoria.avisos}));
    if(!auditoria.ok)throw Error('Auditoria multi-loja pendente. Deploy interrompido antes de substituir produção.');
    const legado=await pool.connect();
    try{await legado.query('BEGIN');await legado.query("SET LOCAL lock_timeout='10s'");await legado.query("SET LOCAL statement_timeout='120s'");await legado.query("SELECT set_config('app.bb_system','1',true)");await migrarChavesLegadas(legado);await legado.query('COMMIT');}
    catch(e){await legado.query('ROLLBACK');throw e;}finally{legado.release();}
    const {rows:modulos}=await pool.query('SELECT modulo,isolado FROM multiloja_modulos ORDER BY ordem');
    console.log('[multiloja/manutencao] módulos',JSON.stringify(modulos));
    if(!modulos.length||modulos.some(m=>!m.isolado))throw Error('Módulos ainda pendentes de implantação');
    // Liberação única das unidades já cadastradas e habilitadas, sem conceder novos acessos.
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bb.multiloja.manutencao'))");
      const {rows:aplicada}=await client.query("SELECT 1 FROM multiloja_migracoes WHERE versao='2026-10-ativacao-configuradas-v1'");
      if(!aplicada.length){
        const {rows:ativadas}=await client.query(`UPDATE lojas l SET pronta_operacao=true,atualizado_em=NOW()
          WHERE l.ativa=true AND l.pronta_operacao=false
            AND EXISTS(SELECT 1 FROM empresas e WHERE e.id=l.empresa_id AND e.ativa=true)
            AND EXISTS(SELECT 1 FROM usuario_lojas ul JOIN usuarios u ON u.id=ul.usuario_id AND u.ativo=true WHERE ul.loja_id=l.id AND ul.ativo=true)
          RETURNING l.id,l.codigo`);
        console.log('[multiloja/manutencao] unidades configuradas ativadas',JSON.stringify(ativadas));
        await client.query("INSERT INTO multiloja_migracoes(versao) VALUES('2026-10-ativacao-configuradas-v1')");
      }
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    // Nenhuma loja é criada e nenhum acesso é concedido.
    const {rows:lojas}=await pool.query(`SELECT l.id,l.codigo,l.ativa,l.pronta_operacao,
      COUNT(ul.id) FILTER(WHERE ul.ativo=true AND u.ativo=true)::int AS usuarios_ativos
      FROM lojas l LEFT JOIN usuario_lojas ul ON ul.loja_id=l.id LEFT JOIN usuarios u ON u.id=ul.usuario_id
      GROUP BY l.id ORDER BY l.id`);
    console.log('[multiloja/manutencao] lojas',JSON.stringify(lojas));
    const depois=await contarHistorico(Object.keys(antes));
    for(const tabela of Object.keys(antes))if(BigInt(depois[tabela])<BigInt(antes[tabela]))throw Error('Contagem histórica diminuiu em '+tabela);
    console.log('[multiloja/manutencao] preservação de registros',JSON.stringify({tabelas:Object.keys(antes).length,nenhuma_reducao:true}));
    console.log('[multiloja/manutencao] SUCCESS — estrutura e isolamento prontos para ativação administrativa');
  }catch(e){console.error('[multiloja/manutencao] FAILED',e.message);process.exitCode=1;}
  finally{await pool.end();}
})();
