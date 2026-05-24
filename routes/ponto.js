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
        id              SERIAL PRIMARY KEY,
        funcionario_id  INTEGER NOT NULL REFERENCES rh_funcionarios(id),
        data_ref        DATE NOT NULL DEFAULT CURRENT_DATE,
        entrada         TIMESTAMPTZ,
        saida_intervalo TIMESTAMPTZ,
        retorno_intervalo TIMESTAMPTZ,
        saida           TIMESTAMPTZ,
        entrada_manual  BOOLEAN DEFAULT FALSE,
        saida_manual    BOOLEAN DEFAULT FALSE,
        justificativa   TEXT,
        observacao      TEXT,
        status          TEXT DEFAULT 'ok' CHECK(status IN('ok','pendente','ajustado','falta','justificado')),
        criado_por      TEXT,
        atualizado_em   TIMESTAMPTZ DEFAULT NOW()
      )`).catch(()=>{});

    // Índice único por funcionário/dia
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ponto_func_data_idx ON ponto_registros(funcionario_id, data_ref)`).catch(()=>{});
  }
  initTables();

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
    // tipo: entrada | saida_intervalo | retorno_intervalo | saida
    const allowed = ['entrada','saida_intervalo','retorno_intervalo','saida'];
    if (!funcionario_id || !allowed.includes(tipo)) {
      return res.status(400).json({ ok:false, erro:'Parâmetros inválidos' });
    }

    const agora = new Date();
    const dataRef = agora.toISOString().slice(0,10);
    const usuario = req.user?.nome || 'Sistema';

    try {
      // Upsert: cria ou atualiza o registro do dia
      const { rows } = await pool.query(`
        INSERT INTO ponto_registros(funcionario_id, data_ref, ${tipo}, criado_por)
        VALUES($1, $2, $3, $4)
        ON CONFLICT(funcionario_id, data_ref) DO UPDATE
          SET ${tipo} = $3, atualizado_em = NOW()
        RETURNING *
      `, [funcionario_id, dataRef, agora, usuario]);

      res.json({ ok:true, data:rows[0], horario: agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) });
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
