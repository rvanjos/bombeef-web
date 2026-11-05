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
    JOIN destinatario f ON f.id=d.funcionario_id
    WHERE d.loja_id=$2 AND d.status='ativo'
      AND d.exige_confirmacao=true AND d.confirmado_em IS NULL
  `,[id,loja]);
  return Number(rows[0]?.total||0);
}

module.exports={contarPendenciasProprias};
