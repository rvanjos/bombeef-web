/**
 * routes/kits_campanha.js — Gestão Interna de Kits/Campanhas
 *
 * Tabelas:
 *   kit_campanhas         — campanhas com config de slots
 *   kit_campanha_slots    — slots de cada campanha
 *   kit_pedidos           — pedidos internos
 *   kit_pedido_itens      — itens escolhidos por slot
 *   kit_reservas          — saldo comprometido por produto
 *   kit_pdv_conciliacao   — lançamentos do PDV para conciliação
 *   kit_estoque_interno   — saldo de estoque por produto para este módulo
 */

const express = require('express');
const autenticar = require('../middleware/auth');
const events  = require('../lib/events');

module.exports = function (pool, app) {
  const publish = (canal, dados) => { try { app?.locals?.ssePublish?.(canal, dados); } catch(_) {} };
  const r = express.Router();
  r.use(autenticar());

  // ── INIT TABELAS ────────────────────────────────────────────────────────────
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_campanhas (
        id              SERIAL PRIMARY KEY,
        nome            TEXT NOT NULL,
        descricao       TEXT,
        preco_referencia NUMERIC(10,2) DEFAULT 0,
        limite_campanha INTEGER DEFAULT 0,   -- 0 = sem limite
        data_inicio     DATE,
        data_fim        DATE,
        status          TEXT NOT NULL DEFAULT 'ativa'
                        CHECK (status IN ('ativa','pausada','encerrada')),
        criado_por      INTEGER,
        criado_em       TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_campanha_slots (
        id              SERIAL PRIMARY KEY,
        campanha_id     INTEGER NOT NULL REFERENCES kit_campanhas(id) ON DELETE CASCADE,
        nome            TEXT NOT NULL,
        tipo            TEXT NOT NULL DEFAULT 'choice'
                        CHECK (tipo IN ('fixed','choice')),
        obrigatorio     BOOLEAN DEFAULT true,
        quantidade      NUMERIC(8,3) DEFAULT 1,
        aceita_peso_real BOOLEAN DEFAULT false,
        ordem           INTEGER DEFAULT 0,
        -- produtos_permitidos: array de produto_ids em JSON
        produtos_permitidos JSONB DEFAULT '[]'
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_pedidos (
        id              SERIAL PRIMARY KEY,
        numero          TEXT UNIQUE NOT NULL,  -- KIT-2026-0001
        campanha_id     INTEGER REFERENCES kit_campanhas(id),
        campanha_nome   TEXT,
        canal           TEXT DEFAULT 'balcao'
                        CHECK (canal IN ('balcao','whatsapp','delivery','telefone','outro')),
        cliente_nome    TEXT,
        cliente_tel     TEXT,
        status          TEXT NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho','reservado','separado','entregue','cancelado','conciliado')),
        pago            BOOLEAN DEFAULT false,
        pago_em         TIMESTAMPTZ,
        pago_por        INTEGER,
        pago_por_nome   TEXT,
        forma_pagamento TEXT,
        -- Endereço para delivery
        endereco_rua    TEXT,
        endereco_num    TEXT,
        endereco_bairro TEXT,
        endereco_cidade TEXT,
        endereco_ref    TEXT,
        -- Quantidade de kits no pedido (default 1)
        qtd_kits        INTEGER DEFAULT 1,
        observacao      TEXT,
        valor_total     NUMERIC(10,2) DEFAULT 0,
        criado_por      INTEGER,
        criado_por_nome TEXT,
        alterado_por    INTEGER,
        separado_por    INTEGER,
        separado_por_nome TEXT,
        entregue_por    INTEGER,
        entregue_por_nome TEXT,
        cancelado_por   INTEGER,
        cancelado_por_nome TEXT,
        motivo_cancelamento TEXT,
        criado_em       TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_pedido_itens (
        id              SERIAL PRIMARY KEY,
        pedido_id       INTEGER NOT NULL REFERENCES kit_pedidos(id) ON DELETE CASCADE,
        slot_id         INTEGER REFERENCES kit_campanha_slots(id),
        slot_nome       TEXT,
        produto_id      INTEGER REFERENCES produtos(id),
        produto_codigo  TEXT,
        produto_nome    TEXT,
        quantidade      NUMERIC(8,3) DEFAULT 1,
        peso_real       NUMERIC(8,3),          -- para itens com peso variável
        preco_custo_unit NUMERIC(10,4) DEFAULT 0
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_reservas (
        id              SERIAL PRIMARY KEY,
        pedido_id       INTEGER REFERENCES kit_pedidos(id),
        produto_id      INTEGER REFERENCES produtos(id),
        produto_nome    TEXT,
        quantidade      NUMERIC(8,3) DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'reservado'
                        CHECK (status IN ('reservado','consumido','cancelado')),
        criado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_estoque_interno (
        id              SERIAL PRIMARY KEY,
        produto_id      INTEGER UNIQUE REFERENCES produtos(id),
        produto_codigo  TEXT,
        produto_nome    TEXT,
        saldo           NUMERIC(10,3) DEFAULT 0,
        atualizado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Migration: corrige tipo NULL em slots antigos
    await pool.query(`UPDATE kit_campanha_slots SET tipo='choice' WHERE tipo IS NULL`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kit_pdv_conciliacao (
        id              SERIAL PRIMARY KEY,
        campanha_id     INTEGER REFERENCES kit_campanhas(id),
        data_ref        DATE NOT NULL,
        qtd_pdv         INTEGER DEFAULT 0,
        qtd_interna     INTEGER DEFAULT 0,
        diferenca       INTEGER GENERATED ALWAYS AS (qtd_pdv - qtd_interna) STORED,
        observacao      TEXT,
        registrado_por  INTEGER,
        criado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Migrações de colunas novas em kit_pedidos
    for (const col of [
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS pago BOOLEAN DEFAULT false",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS pago_por INTEGER",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS pago_por_nome TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS forma_pagamento TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS endereco_rua TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS endereco_num TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS endereco_bairro TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS endereco_cidade TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS endereco_ref TEXT",
      "ALTER TABLE kit_pedidos ADD COLUMN IF NOT EXISTS qtd_kits INTEGER DEFAULT 1",
    ]) { await pool.query(col).catch(() => {}); }
    // Atualizar constraint de status para incluir conciliado (se não existir)
    await pool.query(`ALTER TABLE kit_pedidos DROP CONSTRAINT IF EXISTS kit_pedidos_status_check`).catch(()=>{});
    await pool.query(`ALTER TABLE kit_pedidos ADD CONSTRAINT kit_pedidos_status_check CHECK (status IN ('rascunho','reservado','separado','entregue','cancelado','conciliado'))`).catch(()=>{});

    // Índices
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_kit_pedidos_campanha ON kit_pedidos(campanha_id);
      CREATE INDEX IF NOT EXISTS idx_kit_pedidos_status   ON kit_pedidos(status);
      CREATE INDEX IF NOT EXISTS idx_kit_reservas_pedido  ON kit_reservas(pedido_id);
      CREATE INDEX IF NOT EXISTS idx_kit_reservas_produto ON kit_reservas(produto_id);
    `).catch(() => {});
  }
  initTables().catch(e => console.error('[kits_campanha] init:', e.message));

  // ── HELPERS ─────────────────────────────────────────────────────────────────

  /** Gera número de pedido sequencial: KIT-AAAAMM-NNNN */
  async function gerarNumeroPedido() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)+1 AS seq FROM kit_pedidos WHERE DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', NOW())`
    );
    const d = new Date();
    const ym = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
    return `KIT-${ym}-${String(rows[0].seq).padStart(4,'0')}`;
  }

  /**
   * Calcula disponibilidade de uma campanha.
   * Retorna { disponivel, gargalo_slot, detalhes[] }
   */
  async function calcDisponibilidade(campanhaId) {
    const { rows: slots } = await pool.query(
      `SELECT * FROM kit_campanha_slots WHERE campanha_id=$1 AND obrigatorio=true ORDER BY ordem`,
      [campanhaId]
    );
    if (!slots.length) return { disponivel: 0, gargalo_slot: null, detalhes: [] };

    const { rows: camp } = await pool.query(
      `SELECT limite_campanha, status,
              (SELECT COUNT(*) FROM kit_pedidos
               WHERE campanha_id=$1 AND status NOT IN ('cancelado','rascunho')) AS vendidos
       FROM kit_campanhas WHERE id=$1`, [campanhaId]
    );
    if (!camp.length) return { disponivel: 0, gargalo_slot: null, detalhes: [] };

    const detalhes = [];
    let minDisp = Infinity;
    let gargalo = null;

    for (const slot of slots) {
      const prods = slot.produtos_permitidos || [];
      if (!prods.length) { detalhes.push({ slot: slot.nome, capacidade: 0, motivo: 'sem produtos' }); minDisp = 0; gargalo = slot.nome; continue; }

      // Saldo livre por produto = estoque_interno - reservas abertas
      let saldoTotal = 0;
      for (const pid of prods) {
        const { rows: est } = await pool.query(
          `SELECT COALESCE(e.saldo,0) -
                  COALESCE((SELECT SUM(r.quantidade) FROM kit_reservas r
                            JOIN kit_pedidos p ON p.id=r.pedido_id
                            WHERE r.produto_id=$1 AND r.status='reservado'
                              AND p.campanha_id=$2),0) AS livre
           FROM kit_estoque_interno e WHERE e.produto_id=$1`,
          [pid, campanhaId]
        );
        saldoTotal += Math.max(0, parseFloat(est[0]?.livre || 0));
      }

      // Capacidade do slot
      let cap;
      if (slot.tipo === 'fixed') {
        cap = Math.floor(saldoTotal / slot.quantidade);
      } else {
        // choice: soma dos estoques / quantidade exigida
        cap = Math.floor(saldoTotal / slot.quantidade);
      }

      detalhes.push({ slot: slot.nome, tipo: slot.tipo, capacidade: cap, saldo_total: saldoTotal });
      if (cap < minDisp) { minDisp = cap; gargalo = slot.nome; }
    }

    // Respeitar limite da campanha
    const vendidos = parseInt(camp[0].vendidos || 0);
    const limite = parseInt(camp[0].limite_campanha || 0);
    let disponivel = minDisp === Infinity ? 0 : minDisp;
    if (limite > 0) disponivel = Math.min(disponivel, limite - vendidos);
    disponivel = Math.max(0, disponivel);

    return { disponivel, gargalo_slot: gargalo, detalhes, vendidos, limite };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CAMPANHAS
  // ══════════════════════════════════════════════════════════════════════════

  r.get('/campanhas', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*,
          (SELECT COUNT(*) FROM kit_pedidos p WHERE p.campanha_id=c.id AND p.status NOT IN ('cancelado','rascunho')) AS vendidos,
          (SELECT COUNT(*) FROM kit_pedidos p WHERE p.campanha_id=c.id AND p.status='reservado') AS reservados,
          (SELECT COUNT(*) FROM kit_campanha_slots s WHERE s.campanha_id=c.id) AS total_slots
        FROM kit_campanhas c ORDER BY c.status ASC, c.criado_em DESC
      `);
      // Calcula disponibilidade para cada campanha ativa
      const resultado = await Promise.all(rows.map(async camp => {
        if (camp.status === 'ativa') {
          const disp = await calcDisponibilidade(camp.id);
          return { ...camp, ...disp };
        }
        return { ...camp, disponivel: null, gargalo_slot: null };
      }));
      res.json({ ok: true, data: resultado });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/campanhas/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM kit_campanhas WHERE id=$1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Não encontrada' });
      const { rows: slots } = await pool.query(
        `SELECT s.*,
                (SELECT json_agg(json_build_object('id',p.id,'codigo',p.codigo,'descricao',p.descricao,'preco_custo',p.preco_custo))
                 FROM produtos p WHERE p.id = ANY(
                   SELECT (v::text)::int FROM jsonb_array_elements(s.produtos_permitidos) v
                 )) AS produtos_info
         FROM kit_campanha_slots s WHERE s.campanha_id=$1 ORDER BY s.ordem`,
        [req.params.id]
      );
      const disp = await calcDisponibilidade(req.params.id);
      res.json({ ok: true, data: { ...rows[0], slots, ...disp } });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/campanhas', async (req, res) => {
    const { nome, descricao, preco_referencia, limite_campanha, data_inicio, data_fim, slots } = req.body;
    if (!nome) return res.status(400).json({ ok: false, erro: 'nome obrigatório' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO kit_campanhas (nome,descricao,preco_referencia,limite_campanha,data_inicio,data_fim,criado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [nome, descricao||null, preco_referencia||0, limite_campanha||0,
         data_inicio||null, data_fim||null, req.usuario?.id||null]
      );
      const campId = rows[0].id;
      // Inserir slots
      if (slots?.length) {
        for (let i=0; i<slots.length; i++) {
          const s = slots[i];
          await pool.query(`
            INSERT INTO kit_campanha_slots
              (campanha_id,nome,tipo,obrigatorio,quantidade,aceita_peso_real,ordem,produtos_permitidos)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [campId, s.nome, s.tipo||'choice', s.obrigatorio!==false, s.quantidade||1,
             s.aceita_peso_real||false, i, JSON.stringify(s.produtos_permitidos||[])]
          );
        }
      }
      res.json({ ok: true, id: campId });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/campanhas/:id', async (req, res) => {
    const { nome, descricao, preco_referencia, limite_campanha, data_inicio, data_fim, status, slots } = req.body;
    try {
      await pool.query(`
        UPDATE kit_campanhas SET nome=$1,descricao=$2,preco_referencia=$3,limite_campanha=$4,
          data_inicio=$5,data_fim=$6,status=COALESCE($7,status),atualizado_em=NOW() WHERE id=$8`,
        [nome, descricao||null, preco_referencia||0, limite_campanha||0,
         data_inicio||null, data_fim||null, status||null, req.params.id]
      );
      // Atualiza slots: upsert seguro (nunca deleta slots com pedidos vinculados)
      if (slots) {
        // Busca IDs dos slots existentes desta campanha
        const { rows: slotsExist } = await pool.query(
          `SELECT id FROM kit_campanha_slots WHERE campanha_id=$1 ORDER BY ordem,id`,
          [req.params.id]
        );
        const idsExist = slotsExist.map(r => r.id);

        for (let i = 0; i < slots.length; i++) {
          const s = slots[i];
          const prodJson = JSON.stringify(s.produtos_permitidos||[]);
          if (i < idsExist.length) {
            // Slot já existe — atualiza preservando o id (evita violar FK)
            await pool.query(`
              UPDATE kit_campanha_slots SET
                nome=$1, tipo=$2, obrigatorio=$3, quantidade=$4,
                aceita_peso_real=$5, ordem=$6, produtos_permitidos=$7
              WHERE id=$8`,
              [s.nome, s.tipo||'choice', s.obrigatorio!==false, s.quantidade||1,
               s.aceita_peso_real||false, i, prodJson, idsExist[i]]
            );
          } else {
            // Slot novo — insere
            await pool.query(`
              INSERT INTO kit_campanha_slots
                (campanha_id,nome,tipo,obrigatorio,quantidade,aceita_peso_real,ordem,produtos_permitidos)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [req.params.id, s.nome, s.tipo||'choice', s.obrigatorio!==false, s.quantidade||1,
               s.aceita_peso_real||false, i, prodJson]
            );
          }
        }
        // Remove slots excedentes que não têm pedidos vinculados
        if (idsExist.length > slots.length) {
          const idsRemover = idsExist.slice(slots.length);
          for (const sid of idsRemover) {
            const { rows: temPedido } = await pool.query(
              `SELECT 1 FROM kit_pedido_itens WHERE slot_id=$1 LIMIT 1`, [sid]
            );
            if (!temPedido.length) {
              await pool.query(`DELETE FROM kit_campanha_slots WHERE id=$1`, [sid]);
            }
            // Se tem pedido, mantém o slot oculto (não aparece no front mas não quebra FK)
          }
        }
      }
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // Disponibilidade de uma campanha
  r.get('/campanhas/:id/disponibilidade', async (req, res) => {
    try {
      const d = await calcDisponibilidade(req.params.id);
      res.json({ ok: true, data: d });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PEDIDOS
  // ══════════════════════════════════════════════════════════════════════════

  r.get('/pedidos', async (req, res) => {
    const { status, campanha_id, canal, data_ini, data_fim, busca } = req.query;
    const conds = [], params = [];
    if (status) { params.push(status); conds.push(`p.status=$${params.length}`); }
    if (campanha_id) { params.push(campanha_id); conds.push(`p.campanha_id=$${params.length}`); }
    if (canal) { params.push(canal); conds.push(`p.canal=$${params.length}`); }
    if (data_ini) { params.push(data_ini); conds.push(`p.criado_em::date>=$${params.length}`); }
    if (data_fim) { params.push(data_fim); conds.push(`p.criado_em::date<=$${params.length}`); }
    if (busca) { params.push(`%${busca}%`); conds.push(`(p.cliente_nome ILIKE $${params.length} OR p.numero ILIKE $${params.length})`); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    try {
      const { rows } = await pool.query(
        `SELECT p.*,
                (SELECT COUNT(*) FROM kit_pedido_itens WHERE pedido_id=p.id) AS total_itens
         FROM kit_pedidos p ${where} ORDER BY p.criado_em DESC LIMIT 200`,
        params
      );
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/pedidos/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM kit_pedidos WHERE id=$1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
      const { rows: itens } = await pool.query(
        `SELECT * FROM kit_pedido_itens WHERE pedido_id=$1 ORDER BY slot_nome, id`,
        [req.params.id]
      );
      res.json({ ok: true, data: { ...rows[0], itens } });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/pedidos', async (req, res) => {
    const { campanha_id, canal, cliente_nome, cliente_tel, observacao, itens, status: reqStatus,
             qtd_kits, pago, forma_pagamento,
             endereco_rua, endereco_num, endereco_bairro, endereco_cidade, endereco_ref } = req.body;
    if (!campanha_id) return res.status(400).json({ ok: false, erro: 'campanha_id obrigatório' });
    if (!itens?.length) return res.status(400).json({ ok: false, erro: 'itens obrigatórios' });

    try {
      // Validar slots obrigatórios preenchidos
      const { rows: slots } = await pool.query(
        `SELECT * FROM kit_campanha_slots WHERE campanha_id=$1`, [campanha_id]
      );
      const slotsObrig = slots.filter(s => s.obrigatorio);
      for (const slot of slotsObrig) {
        const temItem = itens.some(i => i.slot_id === slot.id);
        if (!temItem) return res.status(400).json({ ok: false, erro: `Slot obrigatório não preenchido: ${slot.nome}` });
      }

      const { rows: camp } = await pool.query(`SELECT nome FROM kit_campanhas WHERE id=$1`, [campanha_id]);
      const numero = await gerarNumeroPedido();
      const status = reqStatus || 'reservado';
      const nomeOp = req.usuario?.nome || req.usuario?.email || 'Sistema';

      // Calcular valor total (soma custo dos itens)
      let valorTotal = 0;
      for (const it of itens) {
        if (it.produto_id) {
          const { rows: p } = await pool.query(`SELECT preco_custo FROM produtos WHERE id=$1`, [it.produto_id]);
          valorTotal += (parseFloat(p[0]?.preco_custo||0)) * parseFloat(it.quantidade||1);
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const pagoAgora = pago === true || pago === 'true';
      const { rows: pedRows } = await client.query(`
          INSERT INTO kit_pedidos
            (numero,campanha_id,campanha_nome,canal,cliente_nome,cliente_tel,
             status,observacao,valor_total,qtd_kits,
             pago,pago_em,pago_por,pago_por_nome,forma_pagamento,
             endereco_rua,endereco_num,endereco_bairro,endereco_cidade,endereco_ref,
             criado_por,criado_por_nome)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
          [numero, campanha_id, camp[0]?.nome||'', canal||'balcao',
           cliente_nome||null, cliente_tel||null, status, observacao||null,
           valorTotal, parseInt(qtd_kits)||1,
           pagoAgora, pagoAgora?new Date():null,
           pagoAgora?req.usuario?.id:null, pagoAgora?nomeOp:null, forma_pagamento||null,
           endereco_rua||null, endereco_num||null, endereco_bairro||null,
           endereco_cidade||null, endereco_ref||null,
           req.usuario?.id||null, nomeOp]
        );
        const pedId = pedRows[0].id;

        // Inserir itens
        for (const it of itens) {
          const { rows: p } = await client.query(`SELECT codigo,descricao,preco_custo FROM produtos WHERE id=$1`, [it.produto_id]);
          await client.query(`
            INSERT INTO kit_pedido_itens
              (pedido_id,slot_id,slot_nome,produto_id,produto_codigo,produto_nome,quantidade,peso_real,preco_custo_unit)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [pedId, it.slot_id||null, it.slot_nome||null, it.produto_id,
             p[0]?.codigo||null, p[0]?.descricao||null,
             it.quantidade||1, it.peso_real||null, p[0]?.preco_custo||0]
          );
        }

        // Se status=reservado, criar reservas internas
        if (status === 'reservado') {
          for (const it of itens) {
            if (!it.produto_id) continue;
            const { rows: p } = await client.query(`SELECT descricao FROM produtos WHERE id=$1`, [it.produto_id]);
            await client.query(`
              INSERT INTO kit_reservas (pedido_id,produto_id,produto_nome,quantidade,status)
              VALUES ($1,$2,$3,$4,'reservado')`,
              [pedId, it.produto_id, p[0]?.descricao||'', it.quantidade||1]
            );
          }
        }

        await client.query('COMMIT');
        res.json({ ok: true, id: pedId, numero });

        // ── F2-06: registrar KIT_RESERVA por produto (try/catch isolado) ──────
        if (status === 'reservado') {
          try {
            for (const it of itens) {
              if (!it.produto_id) continue;
              await pool.query(`
                INSERT INTO movimentos_estoque
                  (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
                   quantidade, estoque_anterior, estoque_posterior, usuario_id, observacao)
                SELECT p.id, p.codigo, 'KIT_RESERVA', 'kits', $1,
                  -$2::numeric,
                  p.estoque,
                  GREATEST(0, p.estoque - $2::numeric),
                  $3, $4
                FROM produtos p WHERE p.id = $5
              `, [pedId, parseFloat(it.quantidade||1),
                  req.usuario?.id||null,
                  `Kit #${numero}: ${it.slot_nome||'item'}`,
                  it.produto_id]);
            }
            events.emit(app, 'MOVIMENTO_ESTOQUE', { origem:'kits', origem_id:pedId, tipo:'KIT_RESERVA' });
          } catch(eMov) {
            console.warn('[kits] F2-06 KIT_RESERVA movimento falhou (não crítico):', eMov.message);
          }
        }

      } catch(e) {
        await client.query('ROLLBACK'); throw e;
      } finally { client.release(); }
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /pedidos/:id — editar dados do pedido ──────────────────────────────
  r.put('/pedidos/:id', async (req, res) => {
    const { cliente_nome, cliente_tel, observacao, canal, qtd_kits,
            endereco_rua, endereco_num, endereco_bairro, endereco_cidade, endereco_ref } = req.body;
    try {
      const { rowCount } = await pool.query(`
        UPDATE kit_pedidos SET
          cliente_nome    = COALESCE($1, cliente_nome),
          cliente_tel     = COALESCE($2, cliente_tel),
          observacao      = $3,
          canal           = COALESCE($4, canal),
          qtd_kits        = COALESCE($5, qtd_kits),
          endereco_rua    = $6,
          endereco_num    = $7,
          endereco_bairro = $8,
          endereco_cidade = $9,
          endereco_ref    = $10,
          atualizado_em   = NOW()
        WHERE id = $11
      `, [
        cliente_nome||null, cliente_tel||null, observacao||null,
        canal||null, qtd_kits ? parseInt(qtd_kits) : null,
        endereco_rua||null, endereco_num||null, endereco_bairro||null,
        endereco_cidade||null, endereco_ref||null,
        parseInt(req.params.id)
      ]);
      if (!rowCount) return res.status(404).json({ ok: false, erro: 'Pedido não encontrado' });

      // Se qtd_kits mudou, recalcula quantidades dos itens e reservas proporcionalmente
      if (qtd_kits) {
        const { rows: pedAtual } = await pool.query(
          `SELECT qtd_kits, status FROM kit_pedidos WHERE id=$1`, [parseInt(req.params.id)]
        );
        const qtdAnterior = parseInt(pedAtual[0]?.qtd_kits || 1);
        const qtdNova     = parseInt(qtd_kits);
        if (qtdNova !== qtdAnterior && qtdAnterior > 0) {
          const fator = qtdNova / qtdAnterior;
          // Atualiza quantidades dos itens
          await pool.query(`
            UPDATE kit_pedido_itens
            SET quantidade = ROUND((quantidade * $1)::numeric, 3)
            WHERE pedido_id = $2
          `, [fator, parseInt(req.params.id)]);
          // Atualiza reservas
          await pool.query(`
            UPDATE kit_reservas
            SET quantidade = ROUND((quantidade * $1)::numeric, 3)
            WHERE pedido_id = $2 AND status = 'reservado'
          `, [fator, parseInt(req.params.id)]);
          // Atualiza valor_total proporcional
          await pool.query(`
            UPDATE kit_pedidos
            SET valor_total = ROUND((valor_total * $1)::numeric, 2)
            WHERE id = $2
          `, [fator, parseInt(req.params.id)]);
        }
      }

      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /pedidos/:id — excluir pedido (apenas se não entregue/conciliado) ──
  r.delete('/pedidos/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      // Verifica status — pedidos entregues ou conciliados não podem ser excluídos
      const { rows } = await pool.query(`SELECT status, numero FROM kit_pedidos WHERE id=$1`, [id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Pedido não encontrado' });

      const { status, numero } = rows[0];
      if (['entregue', 'conciliado'].includes(status)) {
        return res.status(400).json({
          ok: false,
          erro: `Pedido ${numero} não pode ser excluído (status: ${status}). Use "Cancelar" para registrar o cancelamento.`
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Devolve reservas ao estoque (se houver)
        await client.query(
          `UPDATE kit_reservas SET status='cancelado' WHERE pedido_id=$1 AND status='reservado'`,
          [id]
        );
        // Remove reservas do pedido
        await client.query(`DELETE FROM kit_reservas WHERE pedido_id=$1`, [id]);
        // Remove itens (CASCADE já faz isso, mas explícito por clareza)
        await client.query(`DELETE FROM kit_pedido_itens WHERE pedido_id=$1`, [id]);
        // Remove o pedido
        await client.query(`DELETE FROM kit_pedidos WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.json({ ok: true, numero });

        // ── F2-06: KIT_CANCELAMENTO ao excluir pedido reservado (try/catch isolado) ──
        if (status === 'reservado') {
          try {
            const { rows: itensPed } = await pool.query(
              `SELECT produto_id, quantidade FROM kit_pedido_itens WHERE pedido_id=$1 AND produto_id IS NOT NULL`,
              [id]
            );
            for (const it of itensPed) {
              await pool.query(`
                INSERT INTO movimentos_estoque
                  (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
                   quantidade, estoque_anterior, estoque_posterior, usuario_id, observacao)
                SELECT p.id, p.codigo, 'KIT_CANCELAMENTO', 'kits', $1,
                  +$2::numeric,
                  p.estoque, p.estoque + $2::numeric,
                  $3, $4
                FROM produtos p WHERE p.id = $5
              `, [id, parseFloat(it.quantidade||1),
                  req.usuario?.id||null,
                  `Kit #${numero}: excluído — devolução ao estoque`,
                  it.produto_id]);
            }
          } catch(eMov) {
            console.warn('[kits] F2-06 delete KIT_CANCELAMENTO falhou (não crítico):', eMov.message);
          }
        }

      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /pedidos/:id/pagar — marcar como pago (independente do status) ──────
  r.post('/pedidos/:id/pagar', async (req, res) => {
    const { forma_pagamento } = req.body;
    const nomeOp = req.usuario?.nome || req.usuario?.email || 'Sistema';
    try {
      const { rows } = await pool.query(`
        UPDATE kit_pedidos SET
          pago=true, pago_em=NOW(), pago_por=$1, pago_por_nome=$2, forma_pagamento=$3,
          atualizado_em=NOW()
        WHERE id=$4 RETURNING *`,
        [req.usuario?.id||null, nomeOp, forma_pagamento||null, parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Não encontrado' });
      res.json({ ok: true, data: rows[0] });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /pedidos/:id/despagar — desmarcar pagamento ──────────────────────
  r.post('/pedidos/:id/despagar', async (req, res) => {
    try {
      await pool.query(
        `UPDATE kit_pedidos SET pago=false, pago_em=NULL, pago_por=NULL, pago_por_nome=NULL, atualizado_em=NOW() WHERE id=$1`,
        [parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // Transições de status: reservado → separado → entregue | cancelado
  r.post('/pedidos/:id/status', async (req, res) => {
    const { status, motivo } = req.body;
    const VALIDOS = ['reservado','separado','entregue','cancelado'];
    if (!VALIDOS.includes(status)) return res.status(400).json({ ok: false, erro: 'status inválido' });

    try {
      const { rows } = await pool.query(`SELECT * FROM kit_pedidos WHERE id=$1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
      const ped = rows[0];
      const nomeOp = req.usuario?.nome || req.usuario?.email || 'Sistema';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const upd = {};
        if (status === 'separado') {
          upd.separado_por = req.usuario?.id; upd.separado_por_nome = nomeOp;
          // Consumir reservas → consumido
          await client.query(
            `UPDATE kit_reservas SET status='consumido' WHERE pedido_id=$1 AND status='reservado'`,
            [req.params.id]
          );
        } else if (status === 'entregue') {
          upd.entregue_por = req.usuario?.id; upd.entregue_por_nome = nomeOp;
        } else if (status === 'cancelado') {
          upd.cancelado_por = req.usuario?.id; upd.cancelado_por_nome = nomeOp;
          upd.motivo_cancelamento = motivo || null;
          // Devolver reservas
          await client.query(
            `UPDATE kit_reservas SET status='cancelado' WHERE pedido_id=$1 AND status='reservado'`,
            [req.params.id]
          );
        }

        // Monta SET dinâmico
        const sets = [`status=$1`, `atualizado_em=NOW()`];
        const vals = [status];
        Object.entries(upd).forEach(([k,v]) => { vals.push(v); sets.push(`${k}=$${vals.length}`); });
        vals.push(req.params.id);
        await client.query(
          `UPDATE kit_pedidos SET ${sets.join(',')} WHERE id=$${vals.length}`, vals
        );

        await client.query('COMMIT');
        res.json({ ok: true });

        // ── F2-06: movimentos KIT_CANCELAMENTO ou KIT_ENTREGA (try/catch isolado) ──
        try {
          if (status === 'cancelado') {
            // Devolução: gerar KIT_CANCELAMENTO por item do pedido
            const { rows: itensPed } = await pool.query(
              `SELECT produto_id, quantidade FROM kit_pedido_itens WHERE pedido_id=$1 AND produto_id IS NOT NULL`,
              [req.params.id]
            );
            for (const it of itensPed) {
              await pool.query(`
                INSERT INTO movimentos_estoque
                  (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
                   quantidade, estoque_anterior, estoque_posterior, usuario_id, observacao)
                SELECT p.id, p.codigo, 'KIT_CANCELAMENTO', 'kits', $1,
                  +$2::numeric,
                  p.estoque,
                  p.estoque + $2::numeric,
                  $3, $4
                FROM produtos p WHERE p.id = $5
              `, [req.params.id, parseFloat(it.quantidade||1),
                  req.usuario?.id||null,
                  `Kit #${ped.numero}: cancelamento — devolução ao estoque`,
                  it.produto_id]);
            }
            events.emit(app, 'MOVIMENTO_ESTOQUE', { origem:'kits', origem_id:parseInt(req.params.id), tipo:'KIT_CANCELAMENTO' });
          } else if (status === 'entregue') {
            // Saída definitiva: gerar KIT_ENTREGA por item
            const { rows: itensPed } = await pool.query(
              `SELECT produto_id, quantidade FROM kit_pedido_itens WHERE pedido_id=$1 AND produto_id IS NOT NULL`,
              [req.params.id]
            );
            for (const it of itensPed) {
              await pool.query(`
                INSERT INTO movimentos_estoque
                  (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
                   quantidade, estoque_anterior, estoque_posterior, usuario_id, observacao)
                SELECT p.id, p.codigo, 'KIT_ENTREGA', 'kits', $1,
                  -$2::numeric,
                  p.estoque,
                  GREATEST(0, p.estoque - $2::numeric),
                  $3, $4
                FROM produtos p WHERE p.id = $5
              `, [req.params.id, parseFloat(it.quantidade||1),
                  req.usuario?.id||null,
                  `Kit #${ped.numero}: entrega confirmada`,
                  it.produto_id]);
              // Atualiza estoque físico ao entregar
              await pool.query(
                `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW() WHERE id = $2`,
                [parseFloat(it.quantidade||1), it.produto_id]
              );
            }
            events.emit(app, 'MOVIMENTO_ESTOQUE', { origem:'kits', origem_id:parseInt(req.params.id), tipo:'KIT_ENTREGA' });
          }
        } catch(eMov) {
          console.warn('[kits] F2-06 movimento estoque falhou (não crítico):', eMov.message);
        }

      } catch(e) {
        await client.query('ROLLBACK'); throw e;
      } finally { client.release(); }
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ESTOQUE INTERNO
  // ══════════════════════════════════════════════════════════════════════════

  r.get('/estoque', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT e.*,
          COALESCE((SELECT SUM(r.quantidade) FROM kit_reservas r WHERE r.produto_id=e.produto_id AND r.status='reservado'),0) AS reservado,
          e.saldo - COALESCE((SELECT SUM(r.quantidade) FROM kit_reservas r WHERE r.produto_id=e.produto_id AND r.status='reservado'),0) AS livre
        FROM kit_estoque_interno e
        ORDER BY e.produto_nome
      `);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/estoque/:produto_id', async (req, res) => {
    const { saldo } = req.body;
    if (saldo === undefined) return res.status(400).json({ ok: false, erro: 'saldo obrigatório' });
    try {
      const { rows: p } = await pool.query(`SELECT codigo,descricao FROM produtos WHERE id=$1`, [req.params.produto_id]);
      if (!p.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      await pool.query(`
        INSERT INTO kit_estoque_interno (produto_id,produto_codigo,produto_nome,saldo,atualizado_em)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (produto_id) DO UPDATE SET saldo=$4, atualizado_em=NOW()`,
        [req.params.produto_id, p[0].codigo, p[0].descricao, parseFloat(saldo)]
      );
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /sync-estoque-pdv — copia produtos.estoque → kit_estoque_interno ─────
  // Para todos os produtos que já têm registro em kit_estoque_interno
  // OU que são ingredientes de algum kit ativo
  r.post('/sync-estoque-pdv', async (req, res) => {
    try {
      // 1. Atualiza registros existentes em kit_estoque_interno com o saldo de produtos.estoque
      const upd = await pool.query(`
        UPDATE kit_estoque_interno kei
        SET saldo         = COALESCE(p.estoque, 0),
            atualizado_em = NOW()
        FROM produtos p
        WHERE kei.produto_id = p.id
          AND p.estoque IS NOT NULL
        RETURNING kei.produto_id
      `);

      // 2. Insere novos registros para produtos que são ingredientes de kits
      //    mas ainda não têm entrada em kit_estoque_interno
      const ins = await pool.query(`
        INSERT INTO kit_estoque_interno (produto_id, produto_codigo, produto_nome, saldo, atualizado_em)
        SELECT DISTINCT p.id, p.codigo, p.descricao, COALESCE(p.estoque, 0), NOW()
        FROM kit_itens ki
        JOIN produtos p ON p.id = ki.produto_id
        WHERE p.estoque IS NOT NULL
          AND p.estoque > 0
          AND NOT EXISTS (
            SELECT 1 FROM kit_estoque_interno kei WHERE kei.produto_id = p.id
          )
        ON CONFLICT (produto_id) DO UPDATE
          SET saldo = EXCLUDED.saldo, atualizado_em = NOW()
        RETURNING produto_id
      `);

      publish('estoque', { type: 'kit_estoque_atualizado', atualizados: upd.rowCount });
      res.json({
        ok: true,
        atualizados: upd.rowCount,
        inseridos:   ins.rowCount,
        msg: `Sincronizado: ${upd.rowCount} atualizado(s), ${ins.rowCount} novo(s) inserido(s) no estoque de kits.`
      });
    } catch(e) {
      console.error('[sync-estoque-pdv]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Busca produtos para autocomplete nos slots
  r.get('/produtos-busca', async (req, res) => {
    const { q } = req.query;
    try {
      const { rows } = await pool.query(`
        SELECT id, codigo, descricao, preco_custo,
               COALESCE((SELECT saldo FROM kit_estoque_interno WHERE produto_id=p.id),0) AS saldo_interno
        FROM produtos p
        WHERE ativo=true AND (descricao ILIKE $1 OR codigo ILIKE $1)
        ORDER BY descricao LIMIT 30`,
        [`%${q||''}%`]
      );
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONCILIAÇÃO PDV
  // ══════════════════════════════════════════════════════════════════════════

  r.get('/conciliacao', async (req, res) => {
    const { campanha_id } = req.query;
    try {
      const conds = campanha_id ? 'WHERE c.campanha_id=$1' : '';
      const params = campanha_id ? [campanha_id] : [];
      const { rows } = await pool.query(`
        SELECT c.*, k.nome AS campanha_nome
        FROM kit_pdv_conciliacao c
        LEFT JOIN kit_campanhas k ON k.id=c.campanha_id
        ${conds} ORDER BY c.data_ref DESC`, params
      );
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/conciliacao', async (req, res) => {
    const { campanha_id, data_ref, qtd_pdv, observacao } = req.body;
    if (!campanha_id || !data_ref || qtd_pdv === undefined)
      return res.status(400).json({ ok: false, erro: 'campanha_id, data_ref e qtd_pdv obrigatórios' });
    try {
      // Conta pedidos internos entregues/conciliados da campanha na data
      const { rows: qi } = await pool.query(`
        SELECT COUNT(*) AS qtd FROM kit_pedidos
        WHERE campanha_id=$1 AND criado_em::date=$2
          AND status IN ('entregue','conciliado','separado')`,
        [campanha_id, data_ref]
      );
      const qtdInterna = parseInt(qi[0].qtd);
      const { rows } = await pool.query(`
        INSERT INTO kit_pdv_conciliacao
          (campanha_id,data_ref,qtd_pdv,qtd_interna,observacao,registrado_por)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [campanha_id, data_ref, parseInt(qtd_pdv), qtdInterna, observacao||null, req.usuario?.id||null]
      );
      res.json({ ok: true, data: rows[0] });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RELATÓRIOS / KPIs
  // ══════════════════════════════════════════════════════════════════════════

  r.get('/kpis', async (req, res) => {
    try {
      const [campRes, pedRes, resRes, pagRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='ativa') AS ativas FROM kit_campanhas`),
        pool.query(`SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='reservado') AS reservados,
          COUNT(*) FILTER (WHERE status='separado') AS separados,
          COUNT(*) FILTER (WHERE status='entregue') AS entregues,
          COUNT(*) FILTER (WHERE status='cancelado') AS cancelados,
          COUNT(*) FILTER (WHERE criado_em::date = CURRENT_DATE) AS hoje
        FROM kit_pedidos`),
        pool.query(`SELECT COUNT(*) AS total FROM kit_reservas WHERE status='reservado'`),
        pool.query(`SELECT COUNT(*) AS total FROM kit_pedidos WHERE pago=true AND status NOT IN ('cancelado')`),
      ]);
      res.json({ ok: true, data: {
        campanhas: parseInt(campRes.rows[0].total),
        campanhas_ativas: parseInt(campRes.rows[0].ativas),
        pedidos_total: parseInt(pedRes.rows[0].total),
        pedidos_reservados: parseInt(pedRes.rows[0].reservados),
        pedidos_separados: parseInt(pedRes.rows[0].separados),
        pedidos_entregues: parseInt(pedRes.rows[0].entregues),
        pedidos_cancelados: parseInt(pedRes.rows[0].cancelados),
        pedidos_hoje: parseInt(pedRes.rows[0].hoje),
        reservas_ativas: parseInt(resRes.rows[0].total),
        pedidos_pagos: parseInt(pagRes.rows[0].total||0),
      }});
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/relatorio', async (req, res) => {
    const { campanha_id, data_ini, data_fim } = req.query;
    const conds = [], params = [];
    if (campanha_id) { params.push(campanha_id); conds.push(`p.campanha_id=$${params.length}`); }
    if (data_ini) { params.push(data_ini); conds.push(`p.criado_em::date>=$${params.length}`); }
    if (data_fim) { params.push(data_fim); conds.push(`p.criado_em::date<=$${params.length}`); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    try {
      const [porKit, porCanal, porItem] = await Promise.all([
        pool.query(`SELECT p.campanha_nome, COUNT(*) AS total,
          COUNT(*) FILTER (WHERE p.status='entregue') AS entregues,
          COUNT(*) FILTER (WHERE p.status='cancelado') AS cancelados
          FROM kit_pedidos p ${where} GROUP BY p.campanha_nome ORDER BY total DESC`, params),
        pool.query(`SELECT p.canal, COUNT(*) AS total
          FROM kit_pedidos p ${where} GROUP BY p.canal ORDER BY total DESC`, params),
        pool.query(`SELECT i.slot_nome, i.produto_nome, COUNT(*) AS vezes,
          SUM(i.quantidade) AS qtd_total,
          COALESCE(SUM(i.peso_real),0) AS peso_total
          FROM kit_pedido_itens i
          JOIN kit_pedidos p ON p.id=i.pedido_id
          ${where} GROUP BY i.slot_nome,i.produto_nome
          ORDER BY i.slot_nome, vezes DESC`, params),
      ]);
      res.json({ ok: true, data: {
        por_kit: porKit.rows,
        por_canal: porCanal.rows,
        itens_mais_escolhidos: porItem.rows,
      }});
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });


  // ── GET /campanhas/:id/planejamento ── Sprint 4.5-A ──────────────────────
  // Calcula necessidade de compra para produzir N kits de uma campanha.
  // Usa produtos.estoque (estoque real) e custo_medio_90d > ultimo_custo > preco_custo.
  // NÃO usa kit_estoque_interno (saldo interno do módulo de pedidos).
  r.get('/campanhas/:id/planejamento', async (req, res) => {
    try {
      const campanhaId = parseInt(req.params.id);
      const qtdKits    = Math.max(1, parseInt(req.query.qtd) || 1);
      const dataAcao   = req.query.data_acao   || null;
      const dataLimite = req.query.data_limite || null;

      // Buscar campanha
      const { rows: camps } = await pool.query(
        `SELECT id, nome, descricao, data_inicio, data_fim, status FROM kit_campanhas WHERE id=$1`,
        [campanhaId]
      );
      if (!camps.length) return res.status(404).json({ ok: false, erro: 'Campanha não encontrada' });
      const campanha = camps[0];

      // Buscar slots obrigatórios da campanha
      const { rows: slots } = await pool.query(
        `SELECT id, nome, tipo, quantidade, obrigatorio, produtos_permitidos
         FROM kit_campanha_slots WHERE campanha_id=$1 ORDER BY ordem`,
        [campanhaId]
      );
      if (!slots.length) return res.status(400).json({ ok: false, erro: 'Campanha sem slots configurados' });

      // Coletar todos os produto_ids únicos dos slots
      const todosIds = [...new Set(
        slots.flatMap(s => (s.produtos_permitidos || []).map(Number).filter(Boolean))
      )];

      if (!todosIds.length) {
        return res.status(400).json({ ok: false, erro: 'Nenhum produto vinculado aos slots da campanha' });
      }

      // Buscar dados reais dos produtos (estoque + custos + nome)
      const { rows: prods } = await pool.query(
        `SELECT id, codigo, descricao AS nome, unidade,
                COALESCE(estoque, 0)        AS estoque_atual,
                preco_custo, ultimo_custo, custo_medio_90d
         FROM produtos WHERE id = ANY($1)`,
        [todosIds]
      );
      const prodMap = {};
      prods.forEach(p => { prodMap[p.id] = p; });

      // Montar itens de planejamento por slot
      const itens = [];
      let totalFaltaComprar = 0;
      let valorTotalEstimado = 0;
      let algumFalta = false;

      for (const slot of slots) {
        const prodIds = (slot.produtos_permitidos || []).map(Number).filter(Boolean);
        if (!prodIds.length) continue;

        for (const pid of prodIds) {
          const p = prodMap[pid];
          if (!p) continue;

          const qtdPorKit       = parseFloat(slot.quantidade || 1);
          const necessidadeTotal = parseFloat((qtdPorKit * qtdKits).toFixed(4));
          const estoqueAtual    = parseFloat(p.estoque_atual || 0);
          const faltaComprar    = parseFloat(Math.max(0, necessidadeTotal - estoqueAtual).toFixed(4));

          // Custo: prioridade custo_medio_90d > ultimo_custo > preco_custo
          let custoUnit = null, fonteCusto = 'sem_custo';
          if (p.custo_medio_90d && parseFloat(p.custo_medio_90d) > 0) {
            custoUnit = parseFloat(p.custo_medio_90d); fonteCusto = 'custo_medio_90d';
          } else if (p.ultimo_custo && parseFloat(p.ultimo_custo) > 0) {
            custoUnit = parseFloat(p.ultimo_custo); fonteCusto = 'ultimo_custo';
          } else if (p.preco_custo && parseFloat(p.preco_custo) > 0) {
            custoUnit = parseFloat(p.preco_custo); fonteCusto = 'preco_custo';
          }

          const valorEstimado = custoUnit != null && faltaComprar > 0
            ? parseFloat((faltaComprar * custoUnit).toFixed(2)) : null;

          if (faltaComprar > 0) { algumFalta = true; totalFaltaComprar += faltaComprar; }
          if (valorEstimado)   valorTotalEstimado += valorEstimado;

          itens.push({
            slot_nome:         slot.nome,
            slot_tipo:         slot.tipo,
            produto_id:        p.id,
            produto_codigo:    p.codigo,
            produto_nome:      p.nome,
            unidade:           p.unidade || 'un',
            qtd_por_kit:       qtdPorKit,
            necessidade_total: necessidadeTotal,
            estoque_atual:     estoqueAtual,
            falta_comprar:     faltaComprar,
            custo_unitario:    custoUnit,
            fonte_custo:       fonteCusto,
            valor_estimado:    valorEstimado,
            estoque_ok:        estoqueAtual >= necessidadeTotal,
          });
        }
      }

      // Status geral
      let statusGeral = 'ok';
      if (algumFalta) {
        statusGeral = 'atencao';
        // Urgente se data_limite definida e está em <= 3 dias
        if (dataLimite) {
          const diasRestantes = Math.ceil((new Date(dataLimite) - new Date()) / 86400000);
          if (diasRestantes <= 3) statusGeral = 'urgente';
        }
      }

      res.json({
        ok: true,
        campanha: { id: campanha.id, nome: campanha.nome, status: campanha.status },
        data_acao:   dataAcao,
        data_limite: dataLimite,
        qtd_kits:    qtdKits,
        status:      statusGeral,
        itens,
        resumo: {
          total_slots:          slots.length,
          total_produtos:       itens.length,
          produtos_com_falta:   itens.filter(i => i.falta_comprar > 0).length,
          produtos_sem_custo:   itens.filter(i => i.fonte_custo === 'sem_custo').length,
          valor_total_estimado: parseFloat(valorTotalEstimado.toFixed(2)),
          estoque_suficiente:   !algumFalta,
        },
      });

    } catch(e) {
      console.error('[kits/planejamento]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
