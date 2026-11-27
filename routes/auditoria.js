'use strict';

const express = require('express');
const autenticar = require('../middleware/auth');
const {exigirAdminGlobal}=require('../lib/admin-global');
const audit = require('../lib/auditoria');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar('admin'),exigirAdminGlobal(pool));
  audit.init(pool).catch(e => console.error('[auditoria/init]', e.message));

  r.get('/resumo', async (req, res) => {
    try {
      const dias = Math.min(Math.max(parseInt(req.query.dias) || 30, 1), 365);
      const [totais, modulos, falhas, usuarios] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int total,
          COUNT(*) FILTER (WHERE sucesso=false)::int falhas,
          COUNT(*) FILTER (WHERE acao='EXCLUIR')::int exclusoes,
          COUNT(DISTINCT usuario_id)::int usuarios
          FROM auditoria_eventos WHERE criado_em >= NOW() - ($1 || ' days')::interval AND loja_id=$2`, [dias,req.user.lojaId]),
        pool.query(`SELECT modulo, COUNT(*)::int total FROM auditoria_eventos
          WHERE criado_em >= NOW() - ($1 || ' days')::interval AND loja_id=$2 GROUP BY modulo ORDER BY total DESC LIMIT 10`, [dias,req.user.lojaId]),
        pool.query(`SELECT id, criado_em, modulo, acao, usuario_nome, erro FROM auditoria_eventos
          WHERE sucesso=false AND criado_em >= NOW() - ($1 || ' days')::interval AND loja_id=$2 ORDER BY criado_em DESC LIMIT 10`, [dias,req.user.lojaId]),
        pool.query(`SELECT COALESCE(usuario_nome,'Sistema') usuario, COUNT(*)::int total FROM auditoria_eventos
          WHERE criado_em >= NOW() - ($1 || ' days')::interval AND loja_id=$2 GROUP BY usuario_nome ORDER BY total DESC LIMIT 10`, [dias,req.user.lojaId]),
      ]);
      res.json({ ok:true, data:{ totais:totais.rows[0], modulos:modulos.rows, falhas:falhas.rows, usuarios:usuarios.rows } });
    } catch(e) { res.status(500).json({ok:false, erro:e.message}); }
  });

  r.get('/eventos', async (req, res) => {
    try {
      const limite = Math.max(1,Math.min(parseInt(req.query.limite) || 50, 500));
      const pagina = Math.max(parseInt(req.query.pagina) || 1, 1);
      const params = [req.user.lojaId];
      const conds = ['loja_id=$1'];
      const add = (v, sql) => { params.push(v); conds.push(sql.replace('?', '$' + params.length)); };
      if (req.query.modulo) add(req.query.modulo, 'modulo = ?');
      if (req.query.acao) add(req.query.acao, 'acao = ?');
      if (req.query.usuario) add('%' + req.query.usuario + '%', `COALESCE(usuario_nome,'') ILIKE ?`);
      if (req.query.data_ini) add(req.query.data_ini, "criado_em >= (?::date::timestamp AT TIME ZONE 'America/Sao_Paulo')");
      if (req.query.data_fim) add(req.query.data_fim, `criado_em < ((?::date + interval '1 day') AT TIME ZONE 'America/Sao_Paulo')`);
      if (req.query.sucesso === 'true' || req.query.sucesso === 'false') add(req.query.sucesso === 'true', 'sucesso = ?');
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const count = await pool.query(`SELECT COUNT(*)::int total FROM auditoria_eventos ${where}`, params);
      params.push(limite, (pagina - 1) * limite);
      const { rows } = await pool.query(`SELECT * FROM auditoria_eventos ${where}
        ORDER BY criado_em DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
      res.json({ok:true, data:rows, total:count.rows[0].total, pagina, paginas:Math.ceil(count.rows[0].total/limite)});
    } catch(e) { res.status(500).json({ok:false, erro:e.message}); }
  });

  r.get('/filtros', async (req, res) => {
    try {
      const [m,a,u] = await Promise.all([
        pool.query('SELECT DISTINCT modulo valor FROM auditoria_eventos WHERE loja_id=$1 ORDER BY modulo',[req.user.lojaId]),
        pool.query('SELECT DISTINCT acao valor FROM auditoria_eventos WHERE loja_id=$1 ORDER BY acao',[req.user.lojaId]),
        pool.query(`SELECT DISTINCT usuario_nome valor FROM auditoria_eventos WHERE usuario_nome IS NOT NULL AND loja_id=$1 ORDER BY usuario_nome`,[req.user.lojaId]),
      ]);
      res.json({ok:true, data:{modulos:m.rows, acoes:a.rows, usuarios:u.rows}});
    } catch(e) { res.status(500).json({ok:false, erro:e.message}); }
  });

  r.get('/acessos',async(req,res)=>{
    try{
      const params=[req.user.lojaId],cond=['s.loja_id=$1'];
      const add=(v,q)=>{params.push(v);cond.push(q.replace('?', '$'+params.length));};
      if(req.query.usuario)add('%'+String(req.query.usuario).slice(0,120)+'%', 'u.nome ILIKE ?');
      if(req.query.data_ini)add(req.query.data_ini,"s.iniciado_em >= (?::date::timestamp AT TIME ZONE 'America/Sao_Paulo')");
      if(req.query.data_fim)add(req.query.data_fim,"s.iniciado_em < ((?::date+interval '1 day') AT TIME ZONE 'America/Sao_Paulo')");
      const pagina=Math.max(1,parseInt(req.query.pagina)||1),where=cond.join(' AND ');
      const {rows:[cont]}=await pool.query(`SELECT COUNT(*)::integer AS total FROM login_sessoes s JOIN usuarios u ON u.id=s.usuario_id WHERE ${where}`,params);
      params.push(50,(pagina-1)*50);
      const {rows}=await pool.query(`SELECT s.id,s.usuario_id,u.nome AS usuario_nome,s.iniciado_em,s.ultima_atividade,s.encerrado_em,s.encerramento,s.ip FROM login_sessoes s JOIN usuarios u ON u.id=s.usuario_id WHERE ${where} ORDER BY s.iniciado_em DESC,s.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
      res.json({ok:true,data:rows,total:cont.total,pagina,paginas:Math.ceil(cont.total/50)});
    }catch(_){res.status(500).json({ok:false,erro:'Não foi possível consultar os acessos'});}
  });

  r.get('/dre/conflitos-resolvidos', async (req, res) => {
    try {
      await audit.init(pool);
      const mes = String(req.query.mes || '').trim();
      if (!mes) return res.status(400).json({ok:false, erro:'Mês obrigatório'});
      const {rows} = await pool.query(`SELECT mes_ref, chave_fornecedor, categoria_atual, decisao,
        usuario_nome, justificativa, resolvido_em
        FROM auditoria_dre_conflitos_resolvidos WHERE mes_ref=$1`, [mes]);
      res.json({ok:true, data:rows});
    } catch(e) { res.status(500).json({ok:false, erro:e.message}); }
  });

  r.post('/dre/conflitos-resolvidos', async (req, res) => {
    const {mes_ref, chave_fornecedor, categoria_atual, justificativa} = req.body || {};
    if (!mes_ref || !chave_fornecedor || !categoria_atual)
      return res.status(400).json({ok:false, erro:'Mês, fornecedor e categoria são obrigatórios'});
    try {
      await audit.init(pool);
      const {rows} = await pool.query(`INSERT INTO auditoria_dre_conflitos_resolvidos
        (mes_ref, chave_fornecedor, categoria_atual, decisao, usuario_id, usuario_nome, justificativa)
        VALUES ($1,$2,$3,'MANTER',$4,$5,$6)
        ON CONFLICT (loja_id, mes_ref, chave_fornecedor, categoria_atual) DO UPDATE SET
          decisao='MANTER', usuario_id=EXCLUDED.usuario_id, usuario_nome=EXCLUDED.usuario_nome,
          justificativa=EXCLUDED.justificativa, resolvido_em=NOW()
        RETURNING *`, [mes_ref, chave_fornecedor, categoria_atual, req.user.id, req.user.nome, justificativa || null]);
      await audit.registrar(pool, {usuario_id:req.user.id, usuario_nome:req.user.nome, usuario_perfil:req.user.perfil,
        modulo:'dre', acao:'MANTER_CONFLITO', entidade:'conflito_classificacao',
        entidade_id:`${mes_ref}:${chave_fornecedor}`, dados_depois:rows[0], justificativa,
        ip_address:req.ip, user_agent:req.headers['user-agent'], sucesso:true, status_http:200});
      res.json({ok:true, data:rows[0]});
    } catch(e) { res.status(500).json({ok:false, erro:e.message}); }
  });

  r.post('/dre/acao', async (req, res) => {
    const { id, acao, categoria, justificativa } = req.body || {};
    if (!id || !['CATEGORIZAR','IGNORAR','EXCLUIR'].includes(acao))
      return res.status(400).json({ok:false, erro:'Ação ou lançamento inválido'});
    if (acao === 'CATEGORIZAR' && !String(categoria || '').trim())
      return res.status(400).json({ok:false, erro:'Categoria obrigatória'});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // O identificador pode ter sido salvo como número ou texto em versões antigas;
      // a localização é feita no Node para manter compatibilidade com ambos.
      const {rows} = await client.query(`
        SELECT ds.id, ds.mes_ref, ds.dados_json, COALESCE(df.status,'ABERTO') AS fechamento_status
        FROM dre_sessoes ds
        LEFT JOIN dre_fechamentos df ON df.loja_id=ds.loja_id AND df.mes_ref=ds.mes_ref
        WHERE ds.dados_json IS NOT NULL
        FOR UPDATE OF ds
      `);
      let alterados=0, antes=null, depois=null;
      for (const sessao of rows) {
        const dados = typeof sessao.dados_json === 'string' ? JSON.parse(sessao.dados_json) : sessao.dados_json;
        const txs = Array.isArray(dados) ? dados : (dados.transactions || []);
        const idx = txs.findIndex(t => String(t.id) === String(id));
        if (idx < 0) continue;
        if (String(sessao.fechamento_status).toUpperCase()==='FECHADO') {
          await client.query('ROLLBACK');
          return res.status(423).json({ok:false,erro:'O lançamento pertence ao DRE fechado de '+sessao.mes_ref+'. Reabra o mês antes de alterar.',codigo:'DRE_MES_FECHADO'});
        }
        antes = {...txs[idx]};
        if (acao === 'EXCLUIR') txs.splice(idx,1);
        else if (acao === 'IGNORAR') txs[idx].ignorar = true;
        else txs[idx].categoria = categoria;
        depois = acao === 'EXCLUIR' ? null : {...txs[idx]};
        if (!Array.isArray(dados)) dados.transactions = txs;
        await client.query('UPDATE dre_sessoes SET dados_json=$1, atualizado_em=NOW() WHERE id=$2', [JSON.stringify(dados), sessao.id]);
        alterados++;
      }
      if (!alterados) { await client.query('ROLLBACK'); return res.status(404).json({ok:false, erro:'Lançamento não encontrado no DRE'}); }
      await client.query('COMMIT');
      await audit.registrar(pool, {usuario_id:req.user.id, usuario_nome:req.user.nome, usuario_perfil:req.user.perfil,
        modulo:'dre', acao, entidade:'lancamento_dre', entidade_id:id, dados_antes:antes, dados_depois:depois,
        justificativa, ip_address:req.ip, user_agent:req.headers['user-agent'], sucesso:true, status_http:200});
      res.json({ok:true, alterados});
    } catch(e) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({ok:false, erro:e.message}); }
    finally { client.release(); }
  });

  return r;
};
