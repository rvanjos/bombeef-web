/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
/**
 * routes/retiradas.js — M5: Retiradas de Funcionários
 *
 * Rotas:
 *   GET  /api/retiradas                       → lista retiradas
 *   POST /api/retiradas                       → lança retirada (verifica limite)
 *   PUT  /api/retiradas/:id                   → edita retirada
 *   DELETE /api/retiradas/:id                 → remove retirada
 *   GET  /api/retiradas/relatorio             → relatório mensal
 *   GET  /api/retiradas/limite/:funcionario_id → saldo do limite
 */

const express    = require('express');
const autenticar = require('../middleware/auth');
const events     = require('../lib/events');

module.exports = function (pool, app) {
  const r = express.Router();
  r.use(autenticar());
  // BB-SSE-AUTOPUBLISH — avisa os outros modulos quando algo muda aqui.
  // Roda em todas as rotas, mas so publica em mutacao bem-sucedida.
  const _pub = (c, d) => { try { app?.locals?.ssePublish?.(c, d); } catch(_) {} };
  r.use((req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (body) => {
      if (body?.ok !== false && ['POST','PUT','DELETE','PATCH'].includes(req.method)) {
        _pub('retiradas', { type: 'retiradas_atualizado' });
      }
      return orig(body);
    };
    next();
  });


  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS retiradas (
        id                SERIAL PRIMARY KEY,
        funcionario_id    INTEGER NOT NULL,
        produto_id        INTEGER,
        descricao         TEXT NOT NULL,
        qtd               NUMERIC(10,3) DEFAULT 1,
        preco_unitario    NUMERIC(10,4) DEFAULT 0,
        desconto_pct      NUMERIC(5,2) DEFAULT 0,
        valor_total       NUMERIC(10,2) DEFAULT 0,
        mes               TEXT NOT NULL,
        dt_retirada       DATE DEFAULT CURRENT_DATE,
        observacao        TEXT,
        autorizado_por    INTEGER,
        usuario_id        INTEGER,
        criado_em         TIMESTAMPTZ DEFAULT NOW(),
        loja_id           INTEGER NOT NULL DEFAULT bb_loja_padrao() REFERENCES lojas(id)
      )
    `);
    // Garante colunas
    const needed = [
      ['mes','TEXT'],['valor_total','NUMERIC(10,2) DEFAULT 0'],
      ['desconto_pct','NUMERIC(5,2) DEFAULT 0'],
      ['qtd','NUMERIC(10,3) DEFAULT 1'],
      ['preco_unitario','NUMERIC(10,4) DEFAULT 0'],
      ['status','TEXT DEFAULT \'pendente\''],
      ['dt_pagamento','DATE'],
      ['pago_por','INTEGER'],
      ['baixa_pdv','BOOLEAN DEFAULT false'],
      ['dt_baixa_pdv','DATE'],
      ['baixa_pdv_por','INTEGER'],
    ];
    for(const[c,d]of needed) await pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS ${c} ${d}`).catch(()=>{});
    await pool.query(`UPDATE retiradas SET mes=TO_CHAR(dt_retirada,'MM/YYYY') WHERE mes IS NULL AND dt_retirada IS NOT NULL`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ret_funcionario ON retiradas(funcionario_id)`).catch(()=>{});
    // Corrige retiradas com desconto_pct=100 (valor_total=0) recalculando pelo custo do produto
    await pool.query(`
      UPDATE retiradas r SET
        desconto_pct = 0,
        valor_total  = ROUND((r.preco_unitario * r.qtd)::numeric, 2)
      WHERE r.desconto_pct = 100
        AND r.preco_unitario > 0
        AND r.valor_total < r.preco_unitario * r.qtd * 0.5
    `).catch(e => console.warn('[retiradas] fix desconto:', e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ret_mes ON retiradas(mes)`).catch(()=>{});
  }
  initTable().catch(e => console.error('[retiradas] initTable:', e.message));

  // ── Helper: calcula total do mês por funcionário ───────────────────────────
  async function totalMes(funcId, mes) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(valor_total), 0) AS total FROM retiradas WHERE funcionario_id = $1 AND mes = $2`,
      [funcId, mes]
    );
    return parseFloat(rows[0].total);
  }

  // Gestor representa o funcionário comum: ele só enxerga e lança para o
  // cadastro de funcionário vinculado ao próprio usuário. Administração é
  // exclusiva do perfil admin.
  async function carregarEscopo(req, res, next) {
    if (req.user?.perfil === 'admin') { req.podeRetirada = () => true; return next(); }
    try {
      const { rows } = await pool.query(
        `SELECT u.permissoes, f.id, f.nome, f.limite_retirada
           FROM usuarios u
           LEFT JOIN funcionarios f ON f.usuario_id=u.id AND f.ativo=true
          WHERE u.id=$1
          ORDER BY f.id LIMIT 1`,
        [req.user?.id]
      );
      if (!rows.length) return res.status(403).json({ ok:false, erro:'Usuário não encontrado' });
      const permissoes = rows[0].permissoes || {};
      req.podeRetirada = chave => permissoes[chave] === true;
      req.funcionarioProprio = rows[0].id ? rows[0] : null;
      if (!req.podeRetirada('retiradas_visualizar_equipe')) {
        if (!req.funcionarioProprio) return res.status(403).json({ ok:false, erro:'Seu usuário não está vinculado a um funcionário ativo' });
        req.funcionarioEscopo = req.funcionarioProprio;
      }
      next();
    } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
  }
  const permitir = chave => (req, res, next) => req.podeRetirada?.(chave)
    ? next()
    : res.status(403).json({ ok:false, erro:'Você não possui permissão para esta ação' });

  r.use(carregarEscopo);

  // ── GET /limites — todos em uma chamada; funcionário recebe apenas o seu ─
  r.get('/limites', async (req, res) => {
    try {
      const mesRef = req.query.mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();
      const params = [mesRef], filtro = req.funcionarioEscopo
        ? (params.push(req.funcionarioEscopo.id), `AND f.id = $2`)
        : '';
      const { rows } = await pool.query(`
        SELECT f.id, f.nome,
               COALESCE(f.limite_retirada,0)::numeric AS limite,
               COALESCE(SUM(ret.valor_total),0)::numeric AS usado
          FROM funcionarios f
          LEFT JOIN retiradas ret ON ret.funcionario_id=f.id AND ret.mes=$1
         WHERE f.ativo=true ${filtro}
         GROUP BY f.id, f.nome, f.limite_retirada
         ORDER BY f.nome
      `, params);
      res.json({ ok:true, funcionarioProprioId:req.funcionarioProprio?.id || null, permissoes: {
        visualizarEquipe:req.podeRetirada('retiradas_visualizar_equipe'),
        lancarEquipe:req.podeRetirada('retiradas_lancar_equipe'),
        pagamentos:req.podeRetirada('retiradas_pagamentos'),
        pdv:req.podeRetirada('retiradas_pdv'),
        editar:req.podeRetirada('retiradas_editar')
      }, data:rows.map(x => ({
        ...x,
        limite:Number(x.limite), usado:Number(x.usado),
        saldo:Math.max(0, Number(x.limite)-Number(x.usado))
      })) });
    } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── GET /limite/:funcionario_id ────────────────────────────────────────────
  r.get('/limite/:funcionario_id', async (req, res) => {
    try {
      const funcionarioId = req.funcionarioEscopo?.id || parseInt(req.params.funcionario_id);
      if (req.funcionarioEscopo && parseInt(req.params.funcionario_id) !== funcionarioId)
        return res.status(403).json({ ok:false, erro:'Você só pode consultar o próprio limite' });
      const { mes } = req.query;
      const mesRef = mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();

      const { rows: func } = await pool.query(
        `SELECT id, nome, limite_retirada FROM funcionarios WHERE id = $1`, [funcionarioId]
      );
      if (!func.length) return res.status(404).json({ ok: false, erro: 'Funcionário não encontrado' });

      const limite   = parseFloat(func[0].limite_retirada || 0);
      const usado    = await totalMes(func[0].id, mesRef);
      const saldo    = Math.max(0, limite - usado);
      const pct      = limite > 0 ? ((usado / limite) * 100).toFixed(1) : '0.0';

      res.json({ ok: true, data: {
        funcionario: func[0].nome, limite, usado, saldo,
        percentualUsado: parseFloat(pct), mes: mesRef,
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /relatorio ─────────────────────────────────────────────────────────
  r.get('/relatorio', async (req, res) => {
    try {
      const { mes } = req.query;
      const funcionario_id = req.funcionarioEscopo?.id || req.query.funcionario_id;
      const mesRef = mes || (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      })();

      const conds = [`ret.mes = $1`], params = [mesRef];
      if (funcionario_id) { params.push(parseInt(funcionario_id)); conds.push(`ret.funcionario_id = $${params.length}`); }

      const where = 'WHERE ' + conds.join(' AND ');

      // Resumo por funcionário
      const { rows: resumo } = await pool.query(`
        SELECT
          f.id, f.nome, f.limite_retirada,
          COUNT(ret.id) AS qtd_itens,
          COALESCE(SUM(ret.valor_total), 0) AS total_retirado,
          f.limite_retirada - COALESCE(SUM(ret.valor_total), 0) AS saldo
        FROM funcionarios f
        LEFT JOIN retiradas ret ON ret.funcionario_id = f.id AND ret.mes = $1
        WHERE f.ativo = true ${funcionario_id ? 'AND f.id = $2' : ''}
        GROUP BY f.id, f.nome, f.limite_retirada
        ORDER BY total_retirado DESC
      `, funcionario_id ? [mesRef, parseInt(funcionario_id)] : [mesRef]);

      // Detalhes (se filtrado por funcionário)
      let detalhes = [];
      if (funcionario_id) {
        const { rows } = await pool.query(`
          SELECT ret.*, p.descricao AS prod_descricao
          FROM retiradas ret
          LEFT JOIN produtos p ON p.id = ret.produto_id
          ${where}
          ORDER BY ret.dt_retirada DESC
        `, params);
        detalhes = rows;
      }

      res.json({ ok: true, data: { mes: mesRef, resumo, detalhes, totalGeral: resumo.reduce((s, r) => s + parseFloat(r.total_retirado), 0) } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      const { mes } = req.query;
      const funcionario_id = req.funcionarioEscopo?.id || req.query.funcionario_id;
      const conds = [], params = [];
      if (mes) { params.push(mes); conds.push(`ret.mes = $${params.length}`); }
      if (funcionario_id) { params.push(parseInt(funcionario_id)); conds.push(`ret.funcionario_id = $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(`
        SELECT ret.*, f.nome AS funcionario_nome, p.descricao AS prod_descricao,
          u_pdv.nome AS baixa_pdv_por_nome
        FROM retiradas ret
        LEFT JOIN funcionarios f ON f.id = ret.funcionario_id
        LEFT JOIN produtos p ON p.id = ret.produto_id
        LEFT JOIN usuarios u_pdv ON u_pdv.id = ret.baixa_pdv_por
        ${where}
        ORDER BY ret.dt_retirada DESC, ret.id DESC
      `, params);
      res.json({ ok: true, data: rows, total: rows.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /pendentes/count — resumo para o dashboard administrativo ─────────
  r.get('/pendentes/count', permitir('retiradas_visualizar_equipe'), async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT COUNT(*) AS total, COALESCE(SUM(valor_total),0) AS valor
        FROM retiradas
        WHERE COALESCE(status,'pendente') <> 'pago'
      `);
      res.json({ ok:true, total:parseInt(rows[0].total||0), valor:parseFloat(rows[0].valor||0) });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const ret = req.body;
    if (!req.podeRetirada('retiradas_lancar_equipe') && !req.funcionarioProprio && req.user?.perfil !== 'admin')
      return res.status(403).json({ ok:false, erro:'Seu usuário não está vinculado a um funcionário ativo' });
    if (req.funcionarioEscopo || (!req.podeRetirada('retiradas_lancar_equipe') && req.funcionarioProprio))
      ret.funcionarioId = (req.funcionarioEscopo || req.funcionarioProprio).id;
    if (!ret.funcionarioId || !ret.descricao) {
      return res.status(400).json({ ok: false, erro: 'funcionarioId e descricao obrigatórios' });
    }
    if (req.user?.perfil !== 'admin' && !ret.produtoId) {
      return res.status(400).json({ ok:false, erro:'Selecione um produto cadastrado para registrar a retirada' });
    }
    try {
      // Verifica funcionário e limite
      const { rows: func } = await pool.query(
        `SELECT id, nome, limite_retirada FROM funcionarios WHERE id = $1 AND ativo = true`,
        [ret.funcionarioId]
      );
      if (!func.length) return res.status(404).json({ ok: false, erro: 'Funcionário não encontrado' });

      const dtRetirada = ret.dtRetirada || new Date().toISOString().slice(0, 10);
      const mes        = ret.mes || (dtRetirada.slice(5, 7) + '/' + dtRetirada.slice(0, 4));

      // Calcula valor
      let precUnit = parseFloat(ret.precoUnitario || 0);
      if (ret.produtoId) {
        const prod = await pool.query(`SELECT preco_custo FROM produtos WHERE id = $1`, [ret.produtoId]);
        if (!prod.rows.length) return res.status(404).json({ ok:false, erro:'Produto não encontrado' });
        // O custo oficial do produto prevalece sobre valores enviados pela tela.
        precUnit = parseFloat(prod.rows[0].preco_custo || 0);
      }
      const qtd        = parseFloat(ret.qtd || 1);
      const descPct    = parseFloat(ret.descontoPct ?? 0); // 0 = paga integral, 100 = gratuito
      const valorTotal = parseFloat((precUnit * qtd * (1 - descPct / 100)).toFixed(2));

      // Verifica limite
      const limite = parseFloat(func[0].limite_retirada || 0);
      if (limite > 0) {
        const usado = await totalMes(ret.funcionarioId, mes);
        if (usado + valorTotal > limite) {
          return res.status(422).json({
            ok: false,
            erro: `Limite excedido. Usado: R$ ${usado.toFixed(2)} / Limite: R$ ${limite.toFixed(2)}`,
            saldo: Math.max(0, limite - usado),
          });
        }
      }

      const { rows } = await pool.query(`
        INSERT INTO retiradas
          (funcionario_id, produto_id, descricao, qtd, preco_unitario, desconto_pct,
           valor_total, mes, dt_retirada, observacao, autorizado_por, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [
        ret.funcionarioId, ret.produtoId || null, ret.descricao,
        qtd, precUnit, descPct, valorTotal, mes, dtRetirada,
        ret.observacao || null, ret.autorizadoPor || req.user.id, req.user.id,
      ]);
      res.json({ ok: true, data: rows[0] });

      // F2-05 DESATIVADO: baixa de estoque não acontece mais ao criar retirada.
      // A fonte de verdade é o PDV. Use o botão "Baixa no PDV" para marcar
      // manualmente quando o item for lançado no caixa.

    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', permitir('retiradas_editar'), async (req, res) => {
    const ret = req.body;
    try {
      await pool.query(`
        UPDATE retiradas SET
          descricao       = COALESCE($1, descricao),
          qtd             = COALESCE($2, qtd),
          preco_unitario  = COALESCE($3, preco_unitario),
          desconto_pct    = COALESCE($4, desconto_pct),
          valor_total     = COALESCE($5, valor_total),
          observacao      = COALESCE($6, observacao)
        WHERE id = $7
      `, [
        ret.descricao || null,
        ret.qtd       !== undefined ? parseFloat(ret.qtd) : null,
        ret.precoUnitario !== undefined ? parseFloat(ret.precoUnitario) : null,
        ret.descontoPct   !== undefined ? parseFloat(ret.descontoPct) : null,
        ret.valorTotal    !== undefined ? parseFloat(ret.valorTotal) : null,
        ret.observacao || null,
        parseInt(req.params.id),
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PATCH /:id/baixa-pdv — marca que a baixa foi feita no PDV ───────────────
  r.patch('/:id/baixa-pdv', permitir('retiradas_pdv'), async (req, res) => {
    const { desfazer } = req.body;
    try {
      await pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS baixa_pdv BOOLEAN DEFAULT false`).catch(()=>{});
      await pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS dt_baixa_pdv DATE`).catch(()=>{});
      await pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS baixa_pdv_por INTEGER`).catch(()=>{});
      if (desfazer) {
        await pool.query(
          `UPDATE retiradas SET baixa_pdv=false, dt_baixa_pdv=NULL, baixa_pdv_por=NULL WHERE id=$1`,
          [parseInt(req.params.id)]
        );
      } else {
        await pool.query(
          `UPDATE retiradas SET baixa_pdv=true, dt_baixa_pdv=CURRENT_DATE, baixa_pdv_por=$2 WHERE id=$1`,
          [parseInt(req.params.id), req.user?.id || null]
        );
      }
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── PATCH /:id/baixa — funcionário registra pagamento antecipado ────────────
  r.patch('/:id/baixa', permitir('retiradas_pagamentos'), async (req, res) => {
    const id = parseInt(req.params.id);
    const { dtPagamento, valorPago } = req.body;
    const obs = req.body.obs ?? null;
    const marcarPago = req.body.marcarPago !== false && req.body.marcarPago !== 'false';
    try {
      const { rows } = await pool.query(
        `SELECT usuario_id, funcionario_id FROM retiradas WHERE id=$1`, [id]
      );
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Retirada não encontrada' });

      // Garantir colunas existem (idempotente)
      await Promise.all([
        pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pendente'`).catch(()=>{}),
        pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS dt_pagamento DATE`).catch(()=>{}),
        pool.query(`ALTER TABLE retiradas ADD COLUMN IF NOT EXISTS pago_por INTEGER`).catch(()=>{}),
      ]);
      // Garantir que obs nunca é undefined (causa 'could not determine data type of parameter $4')
      const novoStatus = marcarPago ? 'pago' : 'pendente';

      const obsVal = (obs != null && obs !== '') ? String(obs) : null;
      await pool.query(`
        UPDATE retiradas SET
          status       = $1,
          dt_pagamento = CASE WHEN $1='pago' THEN COALESCE($2::date, CURRENT_DATE) ELSE dt_pagamento END,
          pago_por     = CASE WHEN $1='pago' THEN $3 ELSE pago_por END,
          observacao   = CASE WHEN $4::text IS NOT NULL THEN COALESCE(observacao||' | ','') || $4::text ELSE observacao END
        WHERE id = $5
      `, [novoStatus, dtPagamento||null, req.user?.id, obsVal, id]);

      res.json({ ok:true, msg: novoStatus === 'pago' ? 'Retirada marcada como paga' : 'Retirada mantida pendente' });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── PATCH /:id/reabrir — admin/gestor reabre retirada paga ─────────────────
  r.patch('/:id/reabrir', permitir('retiradas_pagamentos'), async (req, res) => {
    try {
      await pool.query(
        `UPDATE retiradas SET status='pendente', dt_pagamento=NULL, pago_por=NULL WHERE id=$1`,
        [parseInt(req.params.id)]
      );
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  r.delete('/:id', permitir('retiradas_editar'), async (req, res) => {
    try {
      await pool.query(`DELETE FROM retiradas WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
