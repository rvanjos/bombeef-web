/**
 * routes/auth.js
 * Autenticação JWT, gestão de usuários e perfis.
 *
 * Rotas:
 *   POST /auth/login              → autentica, retorna token
 *   POST /auth/logout             → invalida sessão (cliente apaga token)
 *   POST /auth/heartbeat          → atualiza atividade da sessão
 *   GET  /auth/me                 → dados do usuário logado
 *   GET  /auth/usuarios           → lista usuários (admin)
 *   POST /auth/usuarios           → cria usuário (admin)
 *   PUT  /auth/usuarios/:id       → edita usuário (admin)
 *   DELETE /auth/usuarios/:id     → inativa usuário (admin)
 *   PUT  /auth/senha              → troca senha (próprio usuário)
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const autenticar = require('../middleware/auth');
const {
  garantirEstruturaMultiloja,
  listarLojasDoUsuario,
  resolverLojaDoUsuario,
  contextoLojaPublico,
  payloadComLoja,
} = require('../lib/multiloja');

module.exports = function (pool) {
  const r = express.Router();

  // Helper: executa query com retry automático para ECONNRESET/banco reiniciando
  async function queryComRetry(sql, params = [], tentativas = 3) {
    for (let i = 1; i <= tentativas; i++) {
      try {
        return await pool.query(sql, params);
      } catch(e) {
        if (i < tentativas && (e.code === 'ECONNRESET' || e.message?.includes('accepting'))) {
          await new Promise(r => setTimeout(r, 1500 * i));
          continue;
        }
        throw e;
      }
    }
  }

// ── PUT /usuarios/:id/reativar ──────────────────────────────────────────────
r.put('/usuarios/:id/reativar', autenticar('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    await pool.query(
      `UPDATE usuarios SET ativo = true, atualizado_em = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id          SERIAL PRIMARY KEY,
        nome        TEXT NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        senha_hash  TEXT NOT NULL,
        perfil      TEXT NOT NULL DEFAULT 'caixa'
                    CHECK (perfil IN ('admin','gestor','financeiro','estoque','caixa','contabil')),
        ativo       BOOLEAN DEFAULT true,
        ultimo_login TIMESTAMPTZ,
        criado_em   TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_sessoes (
        id               BIGSERIAL PRIMARY KEY,
        usuario_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        iniciado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ultima_atividade TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        encerrado_em     TIMESTAMPTZ,
        encerramento     TEXT,
        ip               TEXT,
        user_agent       TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_sessoes_usuario ON login_sessoes(usuario_id, iniciado_em DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_sessoes_atividade ON login_sessoes(ultima_atividade DESC)`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes JSONB NOT NULL DEFAULT '{}'::jsonb`);

    // Cria admin padrão se não existir
    const { rows } = await pool.query(`SELECT id FROM usuarios WHERE perfil='admin' LIMIT 1`);
    if (rows.length === 0) {
      if (!process.env.ADMIN_SENHA) {
        throw new Error('ADMIN_SENHA deve ser configurada para criar o primeiro administrador');
      }
      const hash = await bcrypt.hash(process.env.ADMIN_SENHA, 12);
      await pool.query(`
        INSERT INTO usuarios (nome, email, senha_hash, perfil)
        VALUES ($1, $2, $3, 'admin')
        ON CONFLICT (email) DO NOTHING
      `, [
        process.env.ADMIN_NOME  || 'Administrador',
        process.env.ADMIN_EMAIL || 'admin@bombeef.com.br',
        hash,
      ]);
      console.log('[auth] usuário administrador inicial criado');
    }

    await garantirEstruturaMultiloja(pool);
  }
  let initPromise = null;
  const garantirTabelas = () => {
    if (!initPromise) {
      initPromise = initTable().catch(e => {
        initPromise = null;
        console.error('[auth] initTable:', e.message);
        throw e;
      });
    }
    return initPromise;
  };
  garantirTabelas().catch(() => {});

  const abrirSessao = async (usuarioId, req, lojaId = null) => {
    await garantirTabelas();
    const { rows } = await pool.query(`
      INSERT INTO login_sessoes (usuario_id, loja_id, ip, user_agent)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [usuarioId, lojaId, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 500) || null]);
    return rows[0].id;
  };

  // Atualiza constraint de perfil para incluir 'contabil' (bancos existentes)
  pool.query(`
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
      CHECK (perfil IN ('admin','gestor','financeiro','estoque','caixa','contabil'));
  `).catch(() => {}); // silencia se tabela ainda não existe

  // ── POST /refresh — renova token sem precisar fazer login novamente ────────
  r.post('/refresh', async (req, res) => {
    const auth = req.headers.authorization || '';
    const oldToken = auth.replace('Bearer ', '');
    if (!oldToken) return res.status(401).json({ ok: false, erro: 'Token não fornecido' });
    try {
      await garantirTabelas();
      // Verifica mesmo expirado (ignoreExpiration) para permitir renovação
      const payload = jwt.verify(oldToken, process.env.JWT_SECRET, { ignoreExpiration: true });
      // Só renova se expirou há menos de 1 dia (segurança)
      const expiredAgo = Math.floor(Date.now()/1000) - payload.exp;
      if (expiredAgo > 86400 * 3) return res.status(401).json({ ok: false, erro: 'Token muito antigo' });
      // Verifica se usuário ainda existe e está ativo
      const { rows } = await pool.query('SELECT id,nome,email,perfil FROM usuarios WHERE id=$1 AND ativo=true', [payload.id]);
      if (!rows.length) return res.status(401).json({ ok: false, erro: 'Usuário inativo' });
      const loja = await resolverLojaDoUsuario(pool, rows[0].id, payload.lojaId || null);
      if (!loja) return res.status(403).json({ ok: false, erro: 'Usuário sem acesso a uma loja ativa' });
      const sessaoId = payload.sessaoId || await abrirSessao(rows[0].id, req, loja.loja_id);
      const newToken = jwt.sign(
        payloadComLoja(rows[0], sessaoId, loja),
        process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
      res.json({ ok: true, token: newToken, usuario: { ...rows[0], perfil: loja.perfil, loja: contextoLojaPublico(loja) } });
    } catch(e) {
      res.status(401).json({ ok: false, erro: 'Token inválido' });
    }
  });

  // ── POST /login ────────────────────────────────────────────────────────────
  r.post('/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'E-mail e senha são obrigatórios' });
    }

    try {
      await garantirTabelas();
      const { rows } = await queryComRetry(
        `SELECT * FROM usuarios WHERE email = $1 AND ativo = true`,
        [email.toLowerCase().trim()]
      );

      if (rows.length === 0) {
        return res.status(401).json({ ok: false, erro: 'E-mail ou senha incorretos' });
      }

      const usuario = rows[0];
      const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
      if (!senhaOk) {
        return res.status(401).json({ ok: false, erro: 'E-mail ou senha incorretos' });
      }

      const loja = await resolverLojaDoUsuario(pool, usuario.id);
      if (!loja) {
        return res.status(403).json({ ok: false, erro: 'Usuário sem acesso a uma loja ativa' });
      }

      // Atualiza último login
      await pool.query(`UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1`, [usuario.id]);
      const sessaoId = await abrirSessao(usuario.id, req, loja.loja_id);

      const token = jwt.sign(
        payloadComLoja(usuario, sessaoId, loja),
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
      const lojasDisponiveis = await listarLojasDoUsuario(pool, usuario.id);

      res.json({
        ok: true,
        token,
        usuario: {
          id:     usuario.id,
          nome:   usuario.nome,
          email:  usuario.email,
          perfil: loja.perfil,
          loja: contextoLojaPublico(loja),
          lojas: lojasDisponiveis.map(contextoLojaPublico),
        },
      });
    } catch (e) {
      console.error('[auth/login]', e.message);
      res.status(500).json({ ok: false, erro: 'Erro interno' });
    }
  });

  // ── GET /me ────────────────────────────────────────────────────────────────
  r.get('/me', autenticar(), async (req, res) => {
    try {
      await garantirTabelas();
      const { rows } = await pool.query(
        `SELECT id, nome, email, perfil, ultimo_login, criado_em FROM usuarios WHERE id = $1`,
        [req.user.id]
      );
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Usuário não encontrado' });
      const lojas = await listarLojasDoUsuario(pool, req.user.id);
      const lojaAtual = lojas.find(loja => Number(loja.loja_id) === Number(req.user.lojaId)) || lojas[0] || null;
      res.json({
        ok: true,
        data: {
          ...rows[0],
          perfil: lojaAtual?.perfil || rows[0].perfil,
          loja: contextoLojaPublico(lojaAtual),
          lojas: lojas.map(contextoLojaPublico),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /logout ───────────────────────────────────────────────────────────
  r.post('/logout', autenticar(), async (req, res) => {
    try {
      if (req.user.sessaoId) {
        await pool.query(`
          UPDATE login_sessoes
          SET ultima_atividade=NOW(), encerrado_em=NOW(), encerramento='logout'
          WHERE id=$1 AND usuario_id=$2 AND encerrado_em IS NULL
        `, [req.user.sessaoId, req.user.id]);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  r.post('/heartbeat', autenticar(), async (req, res) => {
    try {
      await garantirTabelas();
      let sessaoId = req.user.sessaoId;
      let newToken = null;
      if (!sessaoId) {
        const loja = await resolverLojaDoUsuario(pool, req.user.id, req.user.lojaId || null);
        if (!loja) return res.status(403).json({ ok:false, erro:'Usuário sem acesso a uma loja ativa' });
        sessaoId = await abrirSessao(req.user.id, req, loja.loja_id);
        newToken = jwt.sign(
          payloadComLoja(req.user, sessaoId, loja),
          process.env.JWT_SECRET,
          { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );
      } else {
        await pool.query(`
          UPDATE login_sessoes SET ultima_atividade=NOW()
          WHERE id=$1 AND usuario_id=$2 AND encerrado_em IS NULL
        `, [sessaoId, req.user.id]);
      }
      res.json({ ok: true, token: newToken || undefined });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── Lojas autorizadas e troca de unidade ativa ───────────────────────────
  r.get('/lojas', autenticar(), async (req, res) => {
    try {
      await garantirTabelas();
      const lojas = await listarLojasDoUsuario(pool, req.user.id);
      res.json({
        ok: true,
        loja_ativa_id: req.user.lojaId,
        data: lojas.map(loja => ({
          ...contextoLojaPublico(loja),
          perfil: loja.perfil,
          principal: loja.principal,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok:false, erro:'Não foi possível carregar as lojas' });
    }
  });

  r.post('/loja-ativa', autenticar(), async (req, res) => {
    try {
      await garantirTabelas();
      const lojaId = Number(req.body?.loja_id);
      if (!Number.isInteger(lojaId) || lojaId <= 0) {
        return res.status(400).json({ ok:false, erro:'Loja inválida' });
      }
      const { rows } = await pool.query(
        `SELECT id, nome, email, perfil FROM usuarios WHERE id=$1 AND ativo=true`,
        [req.user.id]
      );
      if (!rows.length) return res.status(401).json({ ok:false, erro:'Usuário inativo' });
      const loja = await resolverLojaDoUsuario(pool, req.user.id, lojaId);
      if (!loja) return res.status(403).json({ ok:false, erro:'Acesso à loja não autorizado' });

      if (req.user.sessaoId) {
        await pool.query(
          `UPDATE login_sessoes SET loja_id=$1, ultima_atividade=NOW()
           WHERE id=$2 AND usuario_id=$3 AND encerrado_em IS NULL`,
          [loja.loja_id, req.user.sessaoId, req.user.id]
        );
      }
      const token = jwt.sign(
        payloadComLoja(rows[0], req.user.sessaoId, loja),
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
      res.json({
        ok:true,
        token,
        usuario:{ ...rows[0], perfil:loja.perfil, loja:contextoLojaPublico(loja) },
      });
    } catch (e) {
      res.status(500).json({ ok:false, erro:'Não foi possível trocar de loja' });
    }
  });

  r.get('/multiloja/status', autenticar('admin'), async (req, res) => {
    try {
      await garantirTabelas();
      const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM empresas WHERE ativa=true) AS empresas_ativas,
          (SELECT COUNT(*)::int FROM lojas WHERE ativa=true) AS lojas_ativas,
          (SELECT COUNT(*)::int FROM usuarios WHERE ativo=true) AS usuarios_ativos,
          (SELECT COUNT(DISTINCT usuario_id)::int FROM usuario_lojas WHERE ativo=true) AS usuarios_vinculados,
          (SELECT COUNT(*)::int FROM login_sessoes WHERE loja_id IS NULL) AS sessoes_sem_loja
      `);
      const status = rows[0];
      res.json({
        ok:true,
        data:{
          ...status,
          fundacao_pronta: status.lojas_ativas > 0
            && status.usuarios_ativos === status.usuarios_vinculados
            && status.sessoes_sem_loja === 0,
        },
      });
    } catch (e) {
      res.status(500).json({ ok:false, erro:'Não foi possível validar a fundação multi-loja' });
    }
  });

  // ── Administração multi-loja ─────────────────────────────────────────────
  r.get('/multiloja/admin', autenticar('admin'), async (req, res) => {
    try {
      await garantirTabelas();
      const [empresas, lojas, usuarios] = await Promise.all([
        pool.query(`SELECT id,codigo,nome,cnpj,ativa,criado_em FROM empresas ORDER BY nome`),
        pool.query(`
          SELECT l.id,l.empresa_id,l.codigo,l.nome,l.cnpj,l.timezone,l.endereco,l.cidade,l.uf,
                 l.ativa,l.pronta_operacao,l.criado_em,e.nome AS empresa_nome,
                 COUNT(ul.id)::int AS usuarios_vinculados
          FROM lojas l
          JOIN empresas e ON e.id=l.empresa_id
          LEFT JOIN usuario_lojas ul ON ul.loja_id=l.id AND ul.ativo=true
          GROUP BY l.id,e.nome ORDER BY l.pronta_operacao DESC,l.nome
        `),
        pool.query(`SELECT id,nome,email,perfil,ativo FROM usuarios ORDER BY nome`),
      ]);
      const { rows: vinculos } = await pool.query(`
        SELECT usuario_id,loja_id,perfil,permissoes,ativo,principal
        FROM usuario_lojas ORDER BY loja_id,usuario_id
      `);
      const { rows: modulos } = await pool.query(`SELECT modulo,nome,ordem,isolado,atualizado_em FROM multiloja_modulos ORDER BY ordem`);
      res.json({ok:true,data:{
        empresas:empresas.rows,
        lojas:lojas.rows,
        usuarios:usuarios.rows,
        vinculos,
        modulos,
      }});
    } catch (e) {
      console.error('[auth/multiloja/admin]', e.message);
      res.status(500).json({ok:false,erro:'Não foi possível carregar empresas e lojas'});
    }
  });

  r.post('/multiloja/lojas', autenticar('admin'), async (req, res) => {
    const {empresa_id,nome,codigo,cnpj,timezone,endereco,cidade,uf,usuario_ids=[]}=req.body||{};
    if(!nome?.trim()) return res.status(400).json({ok:false,erro:'Nome da loja é obrigatório'});
    const codigoNormalizado=String(codigo||nome).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60);
    if(!codigoNormalizado) return res.status(400).json({ok:false,erro:'Código da loja é inválido'});
    const client=await pool.connect();
    try {
      await garantirTabelas();
      await client.query('BEGIN');
      const empresaId=Number(empresa_id)||req.user.empresaId;
      const {rows:empresa}=await client.query(`SELECT id FROM empresas WHERE id=$1 AND ativa=true`,[empresaId]);
      if(!empresa.length) throw Object.assign(new Error('Empresa inválida'),{status:400});
      const {rows}=await client.query(`
        INSERT INTO lojas(empresa_id,nome,codigo,cnpj,timezone,endereco,cidade,uf,pronta_operacao)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,false)
        RETURNING *
      `,[empresaId,nome.trim(),codigoNormalizado,String(cnpj||'').replace(/\D/g,'')||null,
          timezone||'America/Sao_Paulo',endereco?.trim()||null,cidade?.trim()||null,
          String(uf||'').trim().toUpperCase().slice(0,2)||null]);
      const ids=[...new Set((Array.isArray(usuario_ids)?usuario_ids:[]).map(Number).filter(Number.isInteger))];
      for(const usuarioId of ids){
        await client.query(`
          INSERT INTO usuario_lojas(usuario_id,loja_id,perfil,permissoes,principal)
          SELECT u.id,$1,u.perfil,COALESCE(u.permissoes,'{}'::jsonb),false FROM usuarios u WHERE u.id=$2
          ON CONFLICT(usuario_id,loja_id) DO UPDATE SET ativo=true,atualizado_em=NOW()
        `,[rows[0].id,usuarioId]);
      }
      await client.query('COMMIT');
      res.status(201).json({ok:true,data:rows[0],aviso:'Loja criada em preparação. Os módulos ainda não foram liberados.'});
    } catch(e){
      await client.query('ROLLBACK').catch(()=>{});
      if(e.code==='23505') return res.status(409).json({ok:false,erro:'Já existe uma loja com esse código'});
      console.error('[auth/multiloja/lojas POST]',e.message);
      res.status(e.status||500).json({ok:false,erro:e.status?e.message:'Não foi possível cadastrar a loja'});
    } finally {client.release();}
  });

  r.put('/multiloja/lojas/:id', autenticar('admin'), async (req,res)=>{
    const lojaId=Number(req.params.id);
    const {nome,cnpj,timezone,endereco,cidade,uf,ativa,usuario_ids}=req.body||{};
    if(!Number.isInteger(lojaId)) return res.status(400).json({ok:false,erro:'Loja inválida'});
    const client=await pool.connect();
    try{
      await garantirTabelas(); await client.query('BEGIN');
      const {rows}=await client.query(`
        UPDATE lojas SET nome=COALESCE($1,nome),cnpj=$2,timezone=COALESCE($3,timezone),
          endereco=$4,cidade=$5,uf=$6,ativa=COALESCE($7,ativa),atualizado_em=NOW()
        WHERE id=$8 RETURNING *
      `,[nome?.trim()||null,String(cnpj||'').replace(/\D/g,'')||null,timezone||null,
          endereco?.trim()||null,cidade?.trim()||null,String(uf||'').trim().toUpperCase().slice(0,2)||null,
          typeof ativa==='boolean'?ativa:null,lojaId]);
      if(!rows.length) throw Object.assign(new Error('Loja não encontrada'),{status:404});
      if(Array.isArray(usuario_ids)){
        const ids=[...new Set(usuario_ids.map(Number).filter(Number.isInteger))];
        if(Number(req.user.lojaId)===lojaId && !ids.includes(Number(req.user.id))){
          throw Object.assign(new Error('Você não pode remover seu próprio acesso da loja ativa'),{status:400});
        }
        await client.query(`UPDATE usuario_lojas SET ativo=false,atualizado_em=NOW() WHERE loja_id=$1`,[lojaId]);
        for(const usuarioId of ids){
          await client.query(`
            INSERT INTO usuario_lojas(usuario_id,loja_id,perfil,permissoes,principal)
            SELECT u.id,$1,u.perfil,COALESCE(u.permissoes,'{}'::jsonb),false FROM usuarios u WHERE u.id=$2
            ON CONFLICT(usuario_id,loja_id) DO UPDATE SET ativo=true,perfil=EXCLUDED.perfil,
              permissoes=EXCLUDED.permissoes,atualizado_em=NOW()
          `,[lojaId,usuarioId]);
        }
      }
      await client.query('COMMIT'); res.json({ok:true,data:rows[0]});
    }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('[auth/multiloja/lojas PUT]',e.message);
      res.status(e.status||500).json({ok:false,erro:e.status?e.message:'Não foi possível atualizar a loja'});
    }finally{client.release();}
  });

  // ── GET /usuarios ──────────────────────────────────────────────────────────
  r.get('/usuarios', autenticar('admin'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, nome, email, perfil, ativo, ultimo_login, criado_em, COALESCE(permissoes,'{}'::jsonb) AS permissoes
         FROM usuarios ORDER BY nome ASC`
      );
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /usuarios ─────────────────────────────────────────────────────────
  r.post('/usuarios', autenticar('admin'), async (req, res) => {
    const { nome, email, senha, perfil, permissoes } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, erro: 'nome, email e senha são obrigatórios' });
    }
    const client = await pool.connect();
    try {
      await garantirTabelas();
      const hash = await bcrypt.hash(senha, 12);
      const loja = await resolverLojaDoUsuario(pool, req.user.id, req.user.lojaId || null);
      if (!loja) return res.status(403).json({ ok:false, erro:'Administrador sem loja ativa' });
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO usuarios (nome, email, senha_hash, perfil, permissoes)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING id, nome, email, perfil, permissoes
      `, [nome.trim(), email.toLowerCase().trim(), hash, perfil || 'caixa', JSON.stringify(permissoes || {})]);
      await client.query(`
        INSERT INTO usuario_lojas (usuario_id, loja_id, perfil, permissoes, principal)
        VALUES ($1, $2, $3, $4::jsonb, true)
      `, [rows[0].id, loja.loja_id, perfil || 'caixa', JSON.stringify(permissoes || {})]);
      await client.query('COMMIT');
      res.json({ ok: true, data: rows[0] });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        return res.status(409).json({ ok: false, erro: 'E-mail já cadastrado' });
      }
      res.status(500).json({ ok: false, erro: e.message });
    } finally {
      client.release();
    }
  });

  // ── PUT /usuarios/:id ──────────────────────────────────────────────────────
  r.put('/usuarios/:id', autenticar('admin'), async (req, res) => {
    const { nome, email, perfil, ativo, permissoes } = req.body;
    try {
      await pool.query(`
        UPDATE usuarios SET
          nome  = COALESCE($1, nome),
          email = COALESCE($2, email),
          perfil = COALESCE($3, perfil),
          ativo  = COALESCE($4, ativo),
          permissoes = COALESCE($5::jsonb, permissoes),
          atualizado_em = NOW()
        WHERE id = $6
      `, [nome || null, email?.toLowerCase() || null, perfil || null,
          ativo !== undefined ? ativo : null,
          permissoes !== undefined ? JSON.stringify(permissoes) : null,
          parseInt(req.params.id)]);
      if (req.user.lojaId) {
        await pool.query(`
          UPDATE usuario_lojas SET
            perfil = COALESCE($1, perfil),
            permissoes = COALESCE($2::jsonb, permissoes),
            ativo = COALESCE($3, ativo),
            atualizado_em = NOW()
          WHERE usuario_id=$4 AND loja_id=$5
        `, [
          perfil || null,
          permissoes !== undefined ? JSON.stringify(permissoes) : null,
          ativo !== undefined ? ativo : null,
          parseInt(req.params.id),
          req.user.lojaId,
        ]);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── DELETE /usuarios/:id ───────────────────────────────────────────────────
r.delete('/usuarios/:id', autenticar('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (id === req.user.id) {
      return res.status(400).json({ ok: false, erro: 'Não é possível inativar o próprio usuário' });
    }

    await pool.query(
      `UPDATE usuarios SET ativo = false, atualizado_em = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── DELETE /usuarios/:id/permanente → excluir definitivamente ──────────────
r.delete('/usuarios/:id/permanente', autenticar('admin'), async (req, res) => {
  const client = await pool.connect();

  try {
    const id = parseInt(req.params.id);

    if (id === req.user.id) {
      return res.status(400).json({ ok: false, erro: 'Não é possível excluir o próprio usuário' });
    }

    await client.query('BEGIN');

    // desvincula referências conhecidas
    await client.query(
      `UPDATE funcionarios SET usuario_id = NULL WHERE usuario_id = $1`,
      [id]
    );

    await client.query(
      `DELETE FROM usuarios WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, erro: e.message });
  } finally {
    client.release();
  }
});

  // ── PUT /usuarios/:id/senha — admin troca senha de qualquer usuário ─────────
  r.put('/usuarios/:id/senha', autenticar('admin'), async (req, res) => {
    const { senha_nova } = req.body;
    if (!senha_nova || senha_nova.length < 6)
      return res.status(400).json({ ok: false, erro: 'Senha deve ter no mínimo 6 caracteres' });
    try {
      const hash = await bcrypt.hash(senha_nova, 12);
      await pool.query(`UPDATE usuarios SET senha_hash=$1, atualizado_em=NOW() WHERE id=$2`,
        [hash, parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /senha ─────────────────────────────────────────────────────────────
  r.put('/senha', autenticar(), async (req, res) => {
    const { senha_atual, senha_nova } = req.body;
    if (!senha_atual || !senha_nova) {
      return res.status(400).json({ ok: false, erro: 'Senha atual e nova são obrigatórias' });
    }
    if (senha_nova.length < 6) {
      return res.status(400).json({ ok: false, erro: 'Senha nova deve ter no mínimo 6 caracteres' });
    }
    try {
      const { rows } = await pool.query(`SELECT senha_hash FROM usuarios WHERE id = $1`, [req.user.id]);
      const ok = await bcrypt.compare(senha_atual, rows[0].senha_hash);
      if (!ok) return res.status(401).json({ ok: false, erro: 'Senha atual incorreta' });

      const hash = await bcrypt.hash(senha_nova, 12);
      await pool.query(
        `UPDATE usuarios SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2`,
        [hash, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /reset-admin — recuperação de senha de emergência ──────────────────
  // Token: bb@Reset2024! — acesso apenas via URL direta
  r.get('/reset-admin', async (req, res) => {
    const TOKEN = 'bb@Reset2024!';
    const { tk, pwd, email } = req.query;
    if (tk !== TOKEN)
      return res.status(403).send('<h2>❌ Token inválido</h2>');
    // Se não passar pwd, mostra formulário
    if (!pwd) {
      return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:400px">
        <h2>🔑 Reset de Senha — Bom Beef</h2>
        <form method="GET">
          <input type="hidden" name="tk" value="${TOKEN}">
          <p><label>E-mail do admin (opcional):<br>
          <input name="email" style="width:100%;padding:8px;margin-top:4px"></label></p>
          <p><label>Nova senha:<br>
          <input name="pwd" type="password" style="width:100%;padding:8px;margin-top:4px" required minlength="6"></label></p>
          <button type="submit" style="background:#8B0000;color:#fff;padding:10px 20px;border:none;border-radius:6px;font-size:14px;cursor:pointer">
            Alterar Senha
          </button>
        </form>
      </body></html>`);
    }
    if (pwd.length < 6)
      return res.send('<h2>❌ Senha deve ter no mínimo 6 caracteres</h2>');
    try {
      const hash = await bcrypt.hash(pwd, 12);
      const where = email ? `email=$2` : `perfil='admin'`;
      const params = email ? [hash, email] : [hash];
      const { rows } = await queryComRetry(
        `UPDATE usuarios SET senha_hash=$1, atualizado_em=NOW() WHERE ${where} RETURNING id, nome, email, perfil`,
        params
      );
      if (!rows.length) return res.send('<h2>❌ Usuário não encontrado</h2>');
      res.send(`<h2>✅ Senha atualizada!</h2><p>Usuário: <b>${rows[0].nome}</b> (${rows[0].email})</p>
        <p><a href="/auth/reset-admin?tk=${TOKEN}">Alterar outra senha</a></p>
        <p><a href="/">Voltar ao sistema</a></p>`);
    } catch(e) { res.status(500).send('Erro: '+e.message); }
  });

  return r;
};
