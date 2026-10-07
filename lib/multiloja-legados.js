'use strict';
const q=s=>'"'+String(s).replace(/"/g,'""')+'"';
const acoes={a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT'};
async function migrarChavesLegadas(client){
  for(const [tabela,coluna] of [['produtos_mestre','codigo_produto'],['vld_config','chave'],['vld_faturamento','mes_ref']]){
    const {rows:existe}=await client.query('SELECT to_regclass($1) AS tabela',['public.'+tabela]);if(!existe[0]?.tabela)continue;
    const parent='public.'+q(tabela),key=q(coluna),indice='uq_'+tabela+'_loja_'+coluna;
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(indice)} ON ${parent}(loja_id,${key})`);
    const {rows:refs}=await client.query(`SELECT c.conname,t.relname AS tabela,n.nspname AS esquema,c.confupdtype,c.confdeltype,c.condeferrable,c.condeferred,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS colunas,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS referencias
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE c.contype='f' AND c.confrelid=$1::regclass`,['public.'+tabela]);
    for(const fk of refs){
      if(fk.referencias.includes('loja_id')||!fk.referencias.includes(coluna))continue;
      if(fk.esquema!=='public'||fk.referencias.length!==1||['n','d'].includes(fk.confupdtype))throw Error('Vínculo legado exige revisão: '+fk.conname);
      const child='public.'+q(fk.tabela),col=q(fk.colunas[0]);
      const {rows:incoerentes}=await client.query(`SELECT COUNT(*)::int n FROM ${child} c WHERE c.${col} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${parent} p WHERE p.${key}=c.${col} AND p.loja_id=c.loja_id)`);
      if(incoerentes[0]?.n)throw Error('Referência legada fora da loja: '+fk.conname);
      await client.query(`ALTER TABLE ${child} DROP CONSTRAINT ${q(fk.conname)}`);
      const del=acoes[fk.confdeltype]+(['n','d'].includes(fk.confdeltype)?' ('+col+')':'');
      await client.query(`ALTER TABLE ${child} ADD CONSTRAINT ${q(fk.conname)} FOREIGN KEY(loja_id,${col}) REFERENCES ${parent}(loja_id,${key})
        ON UPDATE ${acoes[fk.confupdtype]} ON DELETE ${del} ${fk.condeferrable?'DEFERRABLE '+(fk.condeferred?'INITIALLY DEFERRED':'INITIALLY IMMEDIATE'):'NOT DEFERRABLE'}`);
    }
    const {rows:globais}=await client.query(`SELECT c.conname,c.contype FROM pg_constraint c WHERE c.conrelid=$1::regclass AND c.contype IN ('p','u')
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord)=ARRAY[$2]::text[]`,['public.'+tabela,coluna]);
    let pk=false;for(const c of globais){pk=pk||c.contype==='p';await client.query(`ALTER TABLE ${parent} DROP CONSTRAINT ${q(c.conname)}`);}
    if(pk)await client.query(`ALTER TABLE ${parent} ADD PRIMARY KEY(loja_id,${key})`);
  }
}
module.exports={migrarChavesLegadas};
