/**
 * routes/ponto.js — Controle de Ponto Eletrônico
 * Integrado ao módulo RH — Bom Beef Valinhos
 */
const express = require('express');
const autenticar = require('../middleware/auth');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabelas ───────────────────────────────────────────────────────────
  async function initTables() {
    // Adiciona colunas de jornada à tabela de funcionários
    const alters = [
      `ALTER TABLE rh_funcionarios ADD COLUMN IF NOT EXISTS horario_entrada TIME DEFAULT '08:00'`,
      `ALTER TABLE rh_funcionarios ADD COLUMN IF NOT EXISTS horario_saida   TIME DEFAULT '18:00'`,
      `ALTER TABLE rh_funcionarios ADD COLUMN IF NOT EXISTS intervalo_min   INTEGER DEFAULT 60`,
      `ALTER TABLE rh_funcionarios ADD COLUMN IF NOT EXISTS jornada_horas   NUMERIC(4,2) DEFAULT 8`,
      `ALTER TABLE rh_funcionarios ADD COLUMN IF NOT EXISTS tolerancia_min  INTEGER DEFAULT 10`,
    ];
    for (const sql of alters) await pool.query(sql).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ponto_registros (
        id                SERIAL PRIMARY KEY,
        funcionario_id    INTEGER NOT NULL REFERENCES rh_funcionarios(id),
        data_ref          DATE NOT NULL DEFAULT CURRENT_DATE,
        entrada           TIMESTAMPTZ,
        saida_intervalo   TIMESTAMPTZ,
        retorno_intervalo TIMESTAMPTZ,
        saida             TIMESTAMPTZ,
        entrada_manual    BOOLEAN DEFAULT FALSE,
        saida_manual      BOOLEAN DEFAULT FALSE,
        justificativa     TEXT,
        observacao        TEXT,
        status            TEXT DEFAULT 'ok' CHECK(status IN('ok','pendente','ajustado','falta','justificado')),
        criado_por        TEXT,
        atualizado_em     TIMESTAMPTZ DEFAULT NOW()
      )`).catch(e=>console.error('[ponto] criar ponto_registros:', e.message));

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ponto_func_data_idx ON ponto_registros(funcionario_id, data_ref)`).catch(()=>{});

    // Tabela de auditoria — registra CADA batida com usuário logado, IP e timestamp
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ponto_auditoria (
        id              SERIAL PRIMARY KEY,
        ponto_id        INTEGER REFERENCES ponto_registros(id),
        funcionario_id  INTEGER NOT NULL,
        tipo            TEXT NOT NULL,
        horario_batida  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        usuario_login   TEXT,
        usuario_nome    TEXT,
        usuario_perfil  TEXT,
        ip_address      TEXT,
        user_agent      TEXT,
        manual          BOOLEAN DEFAULT FALSE,
        obs             TEXT
      )`).catch(()=>{});

    // Colunas de auditoria extras no registro (quem registrou entrada/saída especificamente)
    const audCols = [
      ['entrada_por', 'TEXT'],
      ['saida_por', 'TEXT'],
      ['entrada_em', 'TIMESTAMPTZ'],
      ['saida_em', 'TIMESTAMPTZ'],
    ];
    for (const [col, tipo] of audCols) {
      await pool.query(`ALTER TABLE ponto_registros ADD COLUMN IF NOT EXISTS ${col} ${tipo}`)
        .catch(e => console.warn('[ponto] alter col', col, e.message));
    }
    // Garante índice único necessário para ON CONFLICT
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ponto_func_data_idx ON ponto_registros(funcionario_id, data_ref)`)
      .catch(e => console.warn('[ponto] idx:', e.message));
  }
  initTables().then(() => {
    console.log('[ponto] tabelas OK');
  }).catch(e => {
    console.error('[ponto] initTables ERRO:', e.message);
  });

  // ── GET /funcionarios — lista funcionários para o grid de ponto ──────────────
  // Usa rh_funcionarios (tabela correta referenciada pelo ponto_registros)
  // Se rh_funcionarios vazia, faz fallback para 'funcionarios' (tabela do RH)
  r.get('/funcionarios', async (req, res) => {
    try {
      let { rows } = await pool.query(`
        SELECT id, nome, cargo, email, ativo,
               horario_entrada, horario_saida, jornada_horas, intervalo_min, tolerancia_min
        FROM rh_funcionarios WHERE ativo=true ORDER BY nome
      `);
      // Fallback: se rh_funcionarios vazia, usa tabela 'funcionarios'
      if (!rows.length) {
        const fb = await pool.query(`SELECT id, nome, cargo, email, ativo FROM funcionarios WHERE ativo=true ORDER BY nome`);
        rows = fb.rows;
      }
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function calcHoras(entrada, saida, saidaInt, retornoInt, intervaloMin) {
    if (!entrada || !saida) return null;
    const ms   = new Date(saida) - new Date(entrada);
    const totalMin = ms / 60000;
    // Desconta intervalo se registrado, senão usa o padrão
    const intReal = (saidaInt && retornoInt)
      ? (new Date(retornoInt) - new Date(saidaInt)) / 60000
      : (intervaloMin || 60);
    return Math.max(0, (totalMin - intReal) / 60);
  }

  function calcStatus(horasTrab, jornadaHoras, entrada, horarioEntrada, toleranciaMin) {
    if (!entrada) return 'falta';
    const previsto = new Date(`1970-01-01T${horarioEntrada}:00`);
    const real     = new Date(entrada);
    const atraso   = (real.getHours()*60+real.getMinutes()) - (previsto.getHours()*60+previsto.getMinutes());
    if (atraso > (toleranciaMin||10)) return 'atraso';
    if (horasTrab !== null && horasTrab > jornadaHoras + 0.1) return 'hora_extra';
    return 'ok';
  }

  // ── Bater ponto (funcionário) ──────────────────────────────────────────────
  r.post('/bater', async (req, res) => {
    const { funcionario_id, tipo } = req.body;
    const allowed = ['entrada','saida_intervalo','retorno_intervalo','saida'];
    if (!funcionario_id || !allowed.includes(tipo)) {
      return res.status(400).json({ ok:false, erro:'Parâmetros inválidos' });
    }

    const agora     = new Date();
    const dataRef   = agora.toISOString().slice(0,10);
    const usuario   = req.user?.nome    || 'Sistema';
    const login     = req.user?.email   || req.user?.nome || 'desconhecido';
    const perfil    = req.user?.perfil  || '—';
    const ip        = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '—';
    const userAgent = req.headers['user-agent'] || '—';

    try {
      // Colunas extras de auditoria por tipo
      const colPor = tipo === 'entrada' ? 'entrada_por' : tipo === 'saida' ? 'saida_por' : null;
      const colEm  = tipo === 'entrada' ? 'entrada_em'  : tipo === 'saida' ? 'saida_em'  : null;

      let extraSet = '';
      if (colPor) extraSet += `, ${colPor} = '${usuario.replace(/'/g,"''")}'`;
      if (colEm)  extraSet += `, ${colEm} = NOW()`;

      const { rows } = await pool.query(`
        INSERT INTO ponto_registros(funcionario_id, data_ref, ${tipo}, criado_por${colPor?', '+colPor:''}${colEm?', '+colEm:''})
        VALUES($1, $2, $3, $4${colPor?', $4':''}${colEm?', NOW()':''})
        ON CONFLICT(funcionario_id, data_ref) DO UPDATE
          SET ${tipo} = $3, atualizado_em = NOW()${extraSet}
        RETURNING *
      `, [funcionario_id, dataRef, agora, usuario]);

      // Grava log de auditoria
      await pool.query(`
        INSERT INTO ponto_auditoria(ponto_id, funcionario_id, tipo, horario_batida, usuario_login, usuario_nome, usuario_perfil, ip_address, user_agent)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [rows[0].id, funcionario_id, tipo, agora, login, usuario, perfil, ip, userAgent.slice(0,200)]).catch(()=>{});

      res.json({
        ok: true,
        data: rows[0],
        horario: agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
        auditoria: { usuario, login, horario: agora.toISOString(), ip }
      });
    } catch(e) {
      console.error('[ponto/bater] ERRO:', e.message, '| stack:', e.stack?.slice(0,200));
      res.status(500).json({ ok:false, erro: e.message });
    }
  });

  // ── Bootstrap: força criação das tabelas (admin) ────────────────────────
  r.post('/init', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ponto_registros (
          id                SERIAL PRIMARY KEY,
          funcionario_id    INTEGER NOT NULL REFERENCES rh_funcionarios(id),
          data_ref          DATE NOT NULL DEFAULT CURRENT_DATE,
          entrada           TIMESTAMPTZ,
          saida_intervalo   TIMESTAMPTZ,
          retorno_intervalo TIMESTAMPTZ,
          saida             TIMESTAMPTZ,
          entrada_manual    BOOLEAN DEFAULT FALSE,
          saida_manual      BOOLEAN DEFAULT FALSE,
          entrada_por       TEXT,
          saida_por         TEXT,
          entrada_em        TIMESTAMPTZ,
          saida_em          TIMESTAMPTZ,
          justificativa     TEXT,
          observacao        TEXT,
          status            TEXT DEFAULT 'ok',
          criado_por        TEXT,
          atualizado_em     TIMESTAMPTZ DEFAULT NOW()
        )`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ponto_func_data_idx ON ponto_registros(funcionario_id, data_ref)`).catch(()=>{});
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ponto_auditoria (
          id              SERIAL PRIMARY KEY,
          ponto_id        INTEGER REFERENCES ponto_registros(id),
          funcionario_id  INTEGER NOT NULL,
          tipo            TEXT NOT NULL,
          horario_batida  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          usuario_login   TEXT,
          usuario_nome    TEXT,
          usuario_perfil  TEXT,
          ip_address      TEXT,
          user_agent      TEXT,
          manual          BOOLEAN DEFAULT FALSE,
          obs             TEXT
        )`);
      res.json({ ok:true, msg:'Tabelas criadas com sucesso' });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Bater ponto retroativo (esquecimento) ─────────────────────────────────
  r.post('/bater-retroativo', async (req, res) => {
    const { funcionario_id, tipo, horario_informado, data_ref, justificativa } = req.body;
    const allowed = ['entrada','saida_intervalo','retorno_intervalo','saida'];
    if (!funcionario_id || !allowed.includes(tipo) || !horario_informado) {
      return res.status(400).json({ ok:false, erro:'Parâmetros inválidos' });
    }
    const agora     = new Date(); // momento real do registro
    const dataRef   = data_ref || agora.toISOString().slice(0,10);
    const usuario   = req.user?.nome   || 'Sistema';
    const login     = req.user?.email  || req.user?.nome || 'desconhecido';
    const perfil    = req.user?.perfil || '—';
    const ip        = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '—';
    const userAgent = req.headers['user-agent'] || '—';

    // Monta timestamp com o horário informado pelo usuário mas na data correta
    const tsInformado = new Date(`${dataRef}T${horario_informado}:00`);

    try {
      const colPor = tipo==='entrada'?'entrada_por':tipo==='saida'?'saida_por':null;
      const colEm  = tipo==='entrada'?'entrada_em' :tipo==='saida'?'saida_em' :null;
      let extraSet = '';
      if (colPor) extraSet += `, ${colPor} = '${usuario.replace(/'/g,"''")}'`;
      if (colEm)  extraSet += `, ${colEm} = NOW()`;

      const { rows } = await pool.query(`
        INSERT INTO ponto_registros(funcionario_id, data_ref, ${tipo}, criado_por, entrada_manual, saida_manual, justificativa${colPor?', '+colPor:''}${colEm?', '+colEm:''})
        VALUES($1,$2,$3,$4,true,true,$5${colPor?', $4':''}${colEm?', NOW()':''})
        ON CONFLICT(funcionario_id, data_ref) DO UPDATE
          SET ${tipo}=$3, atualizado_em=NOW(), entrada_manual=true, saida_manual=true,
              justificativa=COALESCE($5, ponto_registros.justificativa)${extraSet}
        RETURNING *
      `, [funcionario_id, dataRef, tsInformado, usuario, justificativa||null]);

      // Log de auditoria — diferencia retroativo com flag manual=true e obs detalhada
      await pool.query(`
        INSERT INTO ponto_auditoria(ponto_id, funcionario_id, tipo, horario_batida, usuario_login, usuario_nome, usuario_perfil, ip_address, user_agent, manual, obs)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)
      `, [rows[0].id, funcionario_id, tipo, agora, login, usuario, perfil,
          ip, userAgent.slice(0,200),
          `REGISTRO RETROATIVO: horário informado ${horario_informado} em ${dataRef}. Motivo: ${justificativa||'não informado'}. Registrado por ${login} às ${agora.toLocaleString('pt-BR')}`
      ]).catch(()=>{});

      res.json({
        ok: true,
        data: rows[0],
        horario_informado,
        horario_registro: agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
        auditoria: { usuario, login, horario_registro: agora.toISOString(), horario_informado, ip }
      });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Status do dia (para o funcionário ver se já bateu) ────────────────────
  r.get('/hoje/:funcionario_id', async (req, res) => {
    const dataRef = new Date().toISOString().slice(0,10);
    try {
      const { rows } = await pool.query(
        `SELECT p.*, f.horario_entrada, f.horario_saida, f.jornada_horas, f.tolerancia_min, f.intervalo_min
         FROM ponto_registros p
         JOIN rh_funcionarios f ON f.id=p.funcionario_id
         WHERE p.funcionario_id=$1 AND p.data_ref=$2`,
        [req.params.funcionario_id, dataRef]
      );
      res.json({ ok:true, data: rows[0] || null, data_ref: dataRef });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Log de auditoria (admin/gestor) ──────────────────────────────────────
  r.get('/auditoria', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false, erro:'Sem permissão' });
    const { funcionario_id, data_ini, data_fim, limite=100 } = req.query;
    try {
      const { rows } = await pool.query(`
        SELECT a.*, f.nome AS func_nome
        FROM ponto_auditoria a
        JOIN rh_funcionarios f ON f.id=a.funcionario_id
        WHERE ($1::int IS NULL OR a.funcionario_id=$1)
          AND ($2::date IS NULL OR a.horario_batida::date >= $2::date)
          AND ($3::date IS NULL OR a.horario_batida::date <= $3::date)
        ORDER BY a.horario_batida DESC
        LIMIT $4
      `, [funcionario_id||null, data_ini||null, data_fim||null, parseInt(limite)]);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Listar registros (admin/gestor) ───────────────────────────────────────
  r.get('/registros', async (req, res) => {
    const { funcionario_id, mes, ano } = req.query;
    try {
      let where = `WHERE 1=1`;
      const params = [];
      if (funcionario_id) { params.push(funcionario_id); where += ` AND p.funcionario_id=$${params.length}`; }
      if (mes && ano) {
        params.push(mes); params.push(ano);
        where += ` AND EXTRACT(MONTH FROM p.data_ref)=$${params.length-1} AND EXTRACT(YEAR FROM p.data_ref)=$${params.length}`;
      } else if (ano) {
        params.push(ano); where += ` AND EXTRACT(YEAR FROM p.data_ref)=$${params.length}`;
      }
      const { rows } = await pool.query(`
        SELECT p.*,
          f.nome AS func_nome, f.cargo, f.horario_entrada, f.horario_saida,
          f.jornada_horas, f.tolerancia_min, f.intervalo_min
        FROM ponto_registros p
        JOIN rh_funcionarios f ON f.id=p.funcionario_id
        ${where} ORDER BY p.data_ref DESC, f.nome ASC
      `, params);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Ajuste manual (admin) ─────────────────────────────────────────────────
  r.put('/registros/:id', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false, erro:'Sem permissão' });
    const { entrada, saida_intervalo, retorno_intervalo, saida, justificativa, status } = req.body;
    try {
      const { rows } = await pool.query(`
        UPDATE ponto_registros SET
          entrada=$1, saida_intervalo=$2, retorno_intervalo=$3, saida=$4,
          justificativa=$5, status=$6, entrada_manual=true, saida_manual=true,
          atualizado_em=NOW()
        WHERE id=$7 RETURNING *
      `, [entrada||null, saida_intervalo||null, retorno_intervalo||null, saida||null,
          justificativa||null, status||'ajustado', req.params.id]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Criar registro manual (falta justificada, folga etc.) ─────────────────
  r.post('/registros', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false, erro:'Sem permissão' });
    const { funcionario_id, data_ref, entrada, saida, justificativa, status } = req.body;
    try {
      const { rows } = await pool.query(`
        INSERT INTO ponto_registros(funcionario_id, data_ref, entrada, saida, justificativa, status, entrada_manual, saida_manual, criado_por)
        VALUES($1,$2,$3,$4,$5,$6,true,true,$7)
        ON CONFLICT(funcionario_id, data_ref) DO UPDATE
          SET entrada=$3, saida=$4, justificativa=$5, status=$6, entrada_manual=true, saida_manual=true, atualizado_em=NOW()
        RETURNING *
      `, [funcionario_id, data_ref, entrada||null, saida||null, justificativa||null, status||'ajustado', req.user?.nome]);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Resumo mensal por funcionário (para relatório) ────────────────────────
  r.get('/resumo-mensal', async (req, res) => {
    const { mes, ano } = req.query;
    if (!mes || !ano) return res.status(400).json({ ok:false, erro:'mes e ano obrigatórios' });
    try {
      const { rows } = await pool.query(`
        SELECT
          f.id, f.nome, f.cargo, f.horario_entrada, f.horario_saida,
          f.jornada_horas, f.tolerancia_min, f.intervalo_min,
          COUNT(p.id) AS dias_registrados,
          COUNT(CASE WHEN p.entrada IS NOT NULL AND p.saida IS NOT NULL THEN 1 END) AS dias_completos,
          COUNT(CASE WHEN p.status='falta' OR (p.data_ref::date <= CURRENT_DATE AND p.entrada IS NULL) THEN 1 END) AS faltas,
          ARRAY_AGG(
            JSON_BUILD_OBJECT(
              'id', p.id, 'data', p.data_ref, 'entrada', p.entrada,
              'saida_intervalo', p.saida_intervalo, 'retorno_intervalo', p.retorno_intervalo,
              'saida', p.saida, 'status', p.status, 'justificativa', p.justificativa,
              'entrada_manual', p.entrada_manual, 'saida_manual', p.saida_manual
            ) ORDER BY p.data_ref
          ) FILTER (WHERE p.id IS NOT NULL) AS registros
        FROM rh_funcionarios f
        LEFT JOIN ponto_registros p ON p.funcionario_id=f.id
          AND EXTRACT(MONTH FROM p.data_ref)=$1
          AND EXTRACT(YEAR FROM p.data_ref)=$2
        WHERE f.ativo=true
        GROUP BY f.id, f.nome, f.cargo, f.horario_entrada, f.horario_saida,
                 f.jornada_horas, f.tolerancia_min, f.intervalo_min
        ORDER BY f.nome
      `, [parseInt(mes), parseInt(ano)]);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── Jornada do funcionário (configurar) ───────────────────────────────────
  r.put('/jornada/:id', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false, erro:'Sem permissão' });
    const { horario_entrada, horario_saida, intervalo_min, jornada_horas, tolerancia_min } = req.body;
    try {
      await pool.query(`
        UPDATE rh_funcionarios SET
          horario_entrada=$1, horario_saida=$2, intervalo_min=$3,
          jornada_horas=$4, tolerancia_min=$5
        WHERE id=$6
      `, [horario_entrada||'08:00', horario_saida||'18:00', parseInt(intervalo_min)||60,
          parseFloat(jornada_horas)||8, parseInt(tolerancia_min)||10, req.params.id]);
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  return r;
};
