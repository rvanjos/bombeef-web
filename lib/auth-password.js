'use strict';
const { executarComoSistema } = require('./tenant-context');

// Senhas são globais: a revogação precisa alcançar as sessões de todas as lojas.
async function alterarSenha(pool, usuarioId, hash, { hashAnterior = null, lojaId = null } = {}) {
  if (!Number.isSafeInteger(Number(usuarioId)) || Number(usuarioId) <= 0) return false;
  return executarComoSistema(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`UPDATE usuarios SET senha_hash=$1, atualizado_em=NOW()
        WHERE id=$2 AND ($3::text IS NULL OR senha_hash=$3)
          AND ($4::integer IS NULL OR EXISTS (SELECT 1 FROM usuario_lojas ul
            WHERE ul.usuario_id=usuarios.id AND ul.loja_id=$4 AND ul.ativo=true))
        RETURNING id`, [hash, usuarioId, hashAnterior, lojaId]);
      if (!rows.length) { await client.query('ROLLBACK'); return false; }
      await client.query(`UPDATE login_sessoes SET encerrado_em=NOW(), encerramento='senha_alterada'
        WHERE usuario_id=$1 AND encerrado_em IS NULL`, [usuarioId]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  });
}
// Serializa abertura de sessão e troca de senha no mesmo registro do usuário.
async function abrirSessaoAutenticada(pool, usuarioId, hashVerificado, lojaId, req, sessaoOrigemId = null) {
  return executarComoSistema(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id FROM usuarios WHERE id=$1 AND ($2::text IS NULL OR senha_hash=$2) AND ativo=true FOR UPDATE', [usuarioId, hashVerificado]);
      if (!rows.length) { await client.query('ROLLBACK'); return null; }
      if (sessaoOrigemId !== null) {
        const origem = await client.query('SELECT id FROM login_sessoes WHERE id=$1 AND usuario_id=$2 AND encerrado_em IS NULL', [sessaoOrigemId, usuarioId]);
        if (!origem.rows.length) { await client.query('ROLLBACK'); return null; }
      }
      const sessao = await client.query(`INSERT INTO login_sessoes (usuario_id, loja_id, ip, user_agent)
        VALUES ($1,$2,$3,$4) RETURNING id`, [usuarioId, lojaId, req.ip || null, String(req.headers['user-agent'] || '').slice(0,500) || null]);
      await client.query('COMMIT');
      return sessao.rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  });
}
module.exports = { alterarSenha, abrirSessaoAutenticada };
