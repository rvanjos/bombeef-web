'use strict';

async function contarPendenciasProprias(pool,usuario){
  const id=Number(usuario?.id),loja=Number(usuario?.lojaId);
  if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(loja)||loja<=0)throw Error('Identidade ou loja inválida');
  const {rows}=await pool.query(`
    WITH destinatario AS (
      SELECT f.id FROM funcionarios f
      LEFT JOIN usuarios u ON u.id=$1
      WHERE f.loja_id=$2 AND f.ativo=true AND COALESCE(f.freelancer,false)=false
        AND (f.usuario_id=$1 OR (f.usuario_id IS NULL AND u.email IS NOT NULL AND LOWER(f.email)=LOWER(u.email)))
      ORDER BY CASE WHEN f.usuario_id=$1 THEN 0 ELSE 1 END,f.id
      LIMIT 1
    )
    SELECT COUNT(*)::int AS total
    FROM rh_documentos_funcionario d
    JOIN destinatario f ON (f.id=d.funcionario_id OR d.abrangencia='geral')
    WHERE d.loja_id=$2 AND d.status='ativo'
      AND d.exige_confirmacao=true
      AND CASE WHEN d.abrangencia='geral' THEN d.recebimentos->(f.id::text)->>'confirmado_em' IS NULL
               ELSE d.confirmado_em IS NULL END
  `,[id,loja]);
  return Number(rows[0]?.total||0);
}

async function garantirDocumentosGerais(pool){
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.rh_documentos_funcionario') IS NULL THEN RETURN; END IF;
      PERFORM set_config('lock_timeout','10s',true);
      ALTER TABLE rh_documentos_funcionario
        ADD COLUMN IF NOT EXISTS abrangencia TEXT NOT NULL DEFAULT 'individual',
        ADD COLUMN IF NOT EXISTS recebimentos JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE rh_documentos_funcionario ALTER COLUMN funcionario_id DROP NOT NULL;
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='rh_documentos_funcionario'::regclass
                    AND conname='rh_documentos_destino_check') THEN
        ALTER TABLE rh_documentos_funcionario ADD CONSTRAINT rh_documentos_destino_check
          CHECK ((abrangencia='individual' AND funcionario_id IS NOT NULL)
              OR (abrangencia='geral' AND funcionario_id IS NULL AND tipo='outro'));
      END IF;
    END $$;
  `);
}

module.exports={contarPendenciasProprias,garantirDocumentosGerais};
