'use strict';
const ident=s=>'"'+String(s).replace(/"/g,'""')+'"';
const acoes={a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT'};

// Executado na transação da manutenção. Não remove linhas nem altera IDs/CNPJs.
async function migrarFornecedores(client){
  const {rows:existe}=await client.query("SELECT to_regclass('public.fornecedores') AS tabela");
  if(!existe[0]?.tabela)return;
  await client.query('LOCK TABLE public.fornecedores IN SHARE ROW EXCLUSIVE MODE');
  await client.query('ALTER TABLE public.fornecedores ADD COLUMN IF NOT EXISTS id BIGSERIAL');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_id ON public.fornecedores(id)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_loja_cnpj ON public.fornecedores(loja_id,cnpj_fornecedor)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_loja_id ON public.fornecedores(loja_id,id)');
  const {rows:fks}=await client.query(`SELECT c.conname,n.nspname AS esquema,t.relname AS tabela,
    c.confupdtype,c.confdeltype,c.confmatchtype,c.condeferrable,c.condeferred,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS colunas,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS referencias
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND c.confrelid='public.fornecedores'::regclass ORDER BY n.nspname,t.relname,c.conname`);
  for(const fk of fks){
    if(fk.referencias.includes('loja_id'))continue;
    if(fk.esquema!=='public'||fk.referencias.length!==1||!['id','cnpj_fornecedor'].includes(fk.referencias[0]))
      throw Error('Referência de fornecedor exige revisão: '+fk.esquema+'.'+fk.tabela+'.'+fk.conname);
    const tabela=ident(fk.esquema)+'.'+ident(fk.tabela),coluna=ident(fk.colunas[0]),ref=ident(fk.referencias[0]);
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES public.lojas(id)`);
    await client.query(`UPDATE ${tabela} t SET loja_id=f.loja_id FROM public.fornecedores f WHERE t.${coluna}=f.${ref} AND t.loja_id IS NULL`);
    const {rows:invalidos}=await client.query(`SELECT COUNT(*)::int AS n FROM ${tabela} t
      WHERE t.${coluna} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.fornecedores f WHERE f.${ref}=t.${coluna} AND f.loja_id=t.loja_id)`);
    if(Number(invalidos[0]?.n))throw Error('Vínculo de fornecedor fora da loja: '+fk.tabela+' ('+invalidos[0].n+')');
    // SET NULL/DEFAULT só afeta a coluna do fornecedor, jamais apaga o contexto de loja.
    const deletar=['n','d'].includes(fk.confdeltype)?acoes[fk.confdeltype]+' ('+coluna+')':acoes[fk.confdeltype];
    if(['n','d'].includes(fk.confupdtype))throw Error('Atualização especial de referência exige revisão: '+fk.conname);
    await client.query(`ALTER TABLE ${tabela} DROP CONSTRAINT ${ident(fk.conname)}`);
    await client.query(`ALTER TABLE ${tabela} ADD CONSTRAINT ${ident(fk.conname)} FOREIGN KEY(loja_id,${coluna})
      REFERENCES public.fornecedores(loja_id,${ref}) MATCH SIMPLE
      ON UPDATE ${acoes[fk.confupdtype]} ON DELETE ${deletar}
      ${fk.condeferrable?'DEFERRABLE '+(fk.condeferred?'INITIALLY DEFERRED':'INITIALLY IMMEDIATE'):'NOT DEFERRABLE'}`);
  }
  // Agora todas as referências antigas estão ligadas à chave composta da mesma loja.
  const {rows:globais}=await client.query(`SELECT c.conname,c.contype FROM pg_constraint c
    WHERE c.conrelid='public.fornecedores'::regclass AND c.contype IN ('p','u')
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord)=ARRAY['cnpj_fornecedor']::text[]`);
  for(const c of globais)await client.query('ALTER TABLE public.fornecedores DROP CONSTRAINT '+ident(c.conname));
  const {rows:indices}=await client.query(`SELECT indexname AS nome FROM pg_indexes
    WHERE schemaname='public' AND tablename='fornecedores' AND indexname='uq_fornecedores_cnpj_normalizado'`);
  if(indices.length){
    await client.query('DROP INDEX public.uq_fornecedores_cnpj_normalizado');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_loja_cnpj_normalizado
      ON public.fornecedores(loja_id,(regexp_replace(cnpj_fornecedor,'[^0-9]','','g')))
      WHERE cnpj_fornecedor IS NOT NULL AND regexp_replace(cnpj_fornecedor,'[^0-9]','','g')<>''`);
  }
  const {rows:pk}=await client.query("SELECT 1 FROM pg_constraint WHERE conrelid='public.fornecedores'::regclass AND contype='p'");
  if(!pk.length)await client.query('ALTER TABLE public.fornecedores ADD PRIMARY KEY USING INDEX uq_fornecedores_id');
}
module.exports={migrarFornecedores};
