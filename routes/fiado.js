/**
 * routes/fiado.js — Controle de Vendas Fiado / Contas de Clientes
 * Bom Beef Valinhos — AR Boutique de Carnes LTDA
 */
const express = require('express');
const autenticar = require('../middleware/auth');

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabelas ───────────────────────────────────────────────────────────
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes_fiado (
        id                SERIAL PRIMARY KEY,
        nome              TEXT NOT NULL,
        telefone          TEXT,
        tipo_cliente      TEXT NOT NULL DEFAULT 'normal' CHECK(tipo_cliente IN('normal','especial','socio','funcionario')),
        funcionario_id    INTEGER,
        desconto_pct      NUMERIC(5,2) DEFAULT 0,
        limite_credito    NUMERIC(12,2),
        status            TEXT NOT NULL DEFAULT 'ativo' CHECK(status IN('ativo','inativo')),
        observacoes       TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendas_fiado (
        id                SERIAL PRIMARY KEY,
        cliente_id        INTEGER NOT NULL REFERENCES clientes_fiado(id),
        data_compra       DATE NOT NULL DEFAULT CURRENT_DATE,
        subtotal_venda    NUMERIC(12,2) DEFAULT 0,
        desconto_total    NUMERIC(12,2) DEFAULT 0,
        total_final       NUMERIC(12,2) DEFAULT 0,
        saldo_restante    NUMERIC(12,2) DEFAULT 0,
        status            TEXT NOT NULL DEFAULT 'aberto' CHECK(status IN('aberto','parcial','pago','aguardando','reprovado','cancelado')),
        precisa_aprovacao BOOLEAN DEFAULT FALSE,
        aprovado_por      TEXT,
        aprovado_em       TIMESTAMPTZ,
        motivo_reprovacao TEXT,
        observacoes       TEXT,
        usuario_resp      TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS itens_venda_fiado (
        id                SERIAL PRIMARY KEY,
        venda_id          INTEGER NOT NULL REFERENCES vendas_fiado(id) ON DELETE CASCADE,
        codigo_produto    TEXT,
        nome_produto      TEXT NOT NULL,
        quantidade        NUMERIC(10,3) NOT NULL DEFAULT 1,
        valor_unit_venda  NUMERIC(12,2) NOT NULL DEFAULT 0,
        valor_unit_custo  NUMERIC(12,2) DEFAULT 0,
        desconto_pct      NUMERIC(5,2) DEFAULT 0,
        valor_final_item  NUMERIC(12,2) NOT NULL DEFAULT 0
      )`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamentos_fiado (
        id                SERIAL PRIMARY KEY,
        cliente_id        INTEGER NOT NULL REFERENCES clientes_fiado(id),
        data_pagamento    DATE NOT NULL DEFAULT CURRENT_DATE,
        valor_pago        NUMERIC(12,2) NOT NULL,
        forma_pagamento   TEXT NOT NULL DEFAULT 'dinheiro',
        observacoes       TEXT,
        usuario_resp      TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamento_venda_fiado (
        id                SERIAL PRIMARY KEY,
        pagamento_id      INTEGER NOT NULL REFERENCES pagamentos_fiado(id),
        venda_id          INTEGER NOT NULL REFERENCES vendas_fiado(id),
        valor_abatido     NUMERIC(12,2) NOT NULL
      )`).catch(()=>{});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS historico_fiado (
        id                SERIAL PRIMARY KEY,
        cliente_id        INTEGER REFERENCES clientes_fiado(id),
        venda_id          INTEGER REFERENCES vendas_fiado(id),
        pagamento_id      INTEGER REFERENCES pagamentos_fiado(id),
        tipo_evento       TEXT NOT NULL,
        descricao         TEXT,
        usuario           TEXT,
        data_evento       TIMESTAMPTZ DEFAULT NOW()
      )`).catch(()=>{});
  }
  initTables();

  // Helper: registrar histórico
  async function log(cliente_id, tipo, desc, usuario, venda_id=null, pag_id=null) {
    await pool.query(
      `INSERT INTO historico_fiado(cliente_id,venda_id,pagamento_id,tipo_evento,descricao,usuario)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [cliente_id, venda_id, pag_id, tipo, desc, usuario]
    ).catch(()=>{});
  }

  // Helper: recalcular saldo do cliente
  async function recalcSaldo(cliente_id) {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN v.status IN('aberto','parcial') THEN v.saldo_restante ELSE 0 END),0) AS saldo_aberto
      FROM vendas_fiado v
      WHERE v.cliente_id=$1 AND v.status NOT IN('cancelado','reprovado','aguardando')
    `, [cliente_id]);
    return parseFloat(rows[0]?.saldo_aberto || 0);
  }

  // ── MIGRAÇÃO: retiradas → clientes_fiado ──────────────────────────────────
  async function migrarRetiradas() {
    try {
      // Garante coluna funcionario_id
      await pool.query(`ALTER TABLE clientes_fiado ADD COLUMN IF NOT EXISTS funcionario_id INTEGER`).catch(()=>{});
      // Garantir unicidade de funcionario_id para evitar duplicatas
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_fiado_func ON clientes_fiado(funcionario_id) WHERE funcionario_id IS NOT NULL`).catch(()=>{});
      // Remover duplicatas existentes (manter o de menor id)
      await pool.query(`
        DELETE FROM clientes_fiado a
        WHERE a.funcionario_id IS NOT NULL
          AND a.id > (SELECT MIN(b.id) FROM clientes_fiado b WHERE b.funcionario_id=a.funcionario_id)
      `).catch(()=>{});
      // Cria clientes para funcionários que ainda não existem
      const { rows: funcs } = await pool.query(`SELECT f.id, f.nome FROM funcionarios f WHERE f.ativo=true`).catch(()=>({rows:[]})); // F2-13: rh_funcionarios → funcionarios
      for (const f of funcs) {
        await pool.query(`
          INSERT INTO clientes_fiado(nome, tipo_cliente, funcionario_id, status)
          VALUES($1, 'funcionario', $2, 'ativo')
          ON CONFLICT (funcionario_id) DO NOTHING
        `, [f.nome, f.id]).catch(()=>{});
      }
      // Migra retiradas existentes para vendas_fiado
      const { rows: rets } = await pool.query(`
        SELECT r.*, f.nome AS func_nome,
          (SELECT cf.id FROM clientes_fiado cf WHERE cf.funcionario_id=r.funcionario_id AND cf.tipo_cliente='funcionario' LIMIT 1) AS cliente_id
        FROM retiradas r
        JOIN funcionarios f ON f.id=r.funcionario_id -- F2-13
        WHERE r.funcionario_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM vendas_fiado vf
            WHERE vf.observacoes LIKE '%ret_id:'||r.id||'%'
          )
        LIMIT 500
      `).catch(()=>({rows:[]}));
      let migradas = 0;
      for (const r of rets) {
        if (!r.cliente_id) continue;
        const total = parseFloat(r.valor_total||0) || parseFloat(r.preco_unitario||0)*parseFloat(r.qtd||1);
        if (total <= 0) continue;
        const { rows: [v] } = await pool.query(`
          INSERT INTO vendas_fiado(cliente_id, data_compra, subtotal_venda, desconto_total, total_final, saldo_restante, status, observacoes, usuario_resp)
          VALUES($1,$2,$3,0,$3,$3,'aberto',$4,'Migrado de Retiradas')
          RETURNING id
        `, [r.cliente_id, r.dt_retirada||new Date().toISOString().slice(0,10), total.toFixed(2), `ret_id:${r.id}`]).catch(()=>null);
        if (v) {
          await pool.query(`
            INSERT INTO itens_venda_fiado(venda_id, codigo_produto, nome_produto, quantidade, valor_unit_venda, valor_unit_custo, desconto_pct, valor_final_item)
            VALUES($1,$2,$3,$4,$5,$5,0,$6)
          `, [v.id, null, r.descricao, r.qtd||1, parseFloat(r.preco_unitario||0).toFixed(2), total.toFixed(2)]).catch(()=>{});
          migradas++;
        }
      }
      if (migradas > 0) console.log(`[fiado] ${migradas} retirada(s) migrada(s) para Compras Pendentes`);
    } catch(e) { console.error('[migrarRetiradas]', e.message); }
  }
  setTimeout(migrarRetiradas, 3000); // executa 3s após start

  // ── CLIENTES ───────────────────────────────────────────────────────────────
  // Sincroniza funcionários como clientes tipo 'funcionario'
  r.post('/sync-funcionarios', async (req, res) => {
    try {
      const { rows: funcs } = await pool.query(`SELECT id, nome FROM funcionarios WHERE ativo=true`); // F2-13
      let criados = 0;
      for (const f of funcs) {
        const existing = await pool.query(`SELECT id FROM clientes_fiado WHERE funcionario_id=$1`, [f.id]);
        if (!existing.rows.length) {
          await pool.query(`INSERT INTO clientes_fiado(nome,tipo_cliente,funcionario_id,status) VALUES($1,'funcionario',$2,'ativo')`, [f.nome, f.id]);
          criados++;
        }
      }
      res.json({ ok:true, criados });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.get('/clientes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*,
          COALESCE((SELECT SUM(v.saldo_restante) FROM vendas_fiado v
            WHERE v.cliente_id=c.id AND v.status IN('aberto','parcial')),0) AS saldo_aberto,
          COALESCE((SELECT SUM(v.total_final) FROM vendas_fiado v
            WHERE v.cliente_id=c.id AND EXTRACT(MONTH FROM v.data_compra)=EXTRACT(MONTH FROM NOW())
            AND EXTRACT(YEAR FROM v.data_compra)=EXTRACT(YEAR FROM NOW())
            AND v.status NOT IN('cancelado','reprovado')),0) AS comprado_mes,
          (SELECT MAX(p.data_pagamento) FROM pagamentos_fiado p WHERE p.cliente_id=c.id) AS ultimo_pagamento,
          (SELECT MAX(v.data_compra) FROM vendas_fiado v WHERE v.cliente_id=c.id
            AND v.status NOT IN('cancelado','reprovado')) AS ultima_compra,
          (SELECT COUNT(*) FROM vendas_fiado v WHERE v.cliente_id=c.id
            AND v.status='aguardando') AS vendas_pendentes
        FROM clientes_fiado c
        ORDER BY c.nome
      `);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.get('/clientes/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*,
          COALESCE((SELECT SUM(v.saldo_restante) FROM vendas_fiado v
            WHERE v.cliente_id=c.id AND v.status IN('aberto','parcial')),0) AS saldo_aberto,
          COALESCE((SELECT SUM(v.total_final) FROM vendas_fiado v
            WHERE v.cliente_id=c.id AND v.status NOT IN('cancelado','reprovado')),0) AS total_comprado,
          COALESCE((SELECT SUM(p.valor_pago) FROM pagamentos_fiado p WHERE p.cliente_id=c.id),0) AS total_pago
        FROM clientes_fiado c WHERE c.id=$1
      `, [parseInt(req.params.id)]);
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Cliente não encontrado' });
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/clientes', async (req, res) => {
    const { nome, telefone, tipo_cliente='normal', desconto_pct=0, limite_credito, status='ativo', observacoes } = req.body;
    if (!nome?.trim()) return res.status(400).json({ ok:false, erro:'Nome obrigatório' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO clientes_fiado(nome,telefone,tipo_cliente,desconto_pct,limite_credito,status,observacoes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [nome.trim(), telefone||null, tipo_cliente, desconto_pct||0, limite_credito||null, status, observacoes||null]
      );
      await log(rows[0].id, 'cadastro_criado', `Cliente "${nome}" cadastrado`, req.user?.nome);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/clientes/:id', async (req, res) => {
    const { nome, telefone, tipo_cliente, desconto_pct, limite_credito, status, observacoes } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE clientes_fiado SET nome=$1,telefone=$2,tipo_cliente=$3,desconto_pct=$4,
         limite_credito=$5,status=$6,observacoes=$7,updated_at=NOW()
         WHERE id=$8 RETURNING *`,
        [nome, telefone||null, tipo_cliente, desconto_pct||0, limite_credito||null, status, observacoes||null, parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Não encontrado' });
      await log(rows[0].id, 'cliente_editado', `Dados do cliente atualizados`, req.user?.nome);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── VENDAS ─────────────────────────────────────────────────────────────────
  r.get('/vendas', async (req, res) => {
    const { cliente_id, status } = req.query;
    try {
      let where = 'WHERE 1=1';
      const params = [];
      if (cliente_id) { params.push(cliente_id); where += ` AND v.cliente_id=$${params.length}`; }
      if (status)     { params.push(status);      where += ` AND v.status=$${params.length}`; }
      const { rows } = await pool.query(`
        SELECT v.*, c.nome AS cliente_nome, c.tipo_cliente, c.telefone,
          (SELECT json_agg(i ORDER BY i.id) FROM itens_venda_fiado i WHERE i.venda_id=v.id) AS itens
        FROM vendas_fiado v JOIN clientes_fiado c ON c.id=v.cliente_id
        ${where} ORDER BY v.data_compra DESC, v.id DESC LIMIT 200
      `, params);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.post('/vendas', async (req, res) => {
    const { cliente_id, data_compra, itens=[], observacoes } = req.body;
    if (!cliente_id || !itens.length) return res.status(400).json({ ok:false, erro:'cliente e itens obrigatórios' });
    const cli = await pool.query('SELECT * FROM clientes_fiado WHERE id=$1', [cliente_id]);
    if (!cli.rows.length) return res.status(404).json({ ok:false, erro:'Cliente não encontrado' });
    const c = cli.rows[0];
    if (c.status !== 'ativo') return res.status(400).json({ ok:false, erro:'Cliente inativo' });

    const usuario = req.user?.nome || 'Sistema';
    const precisa = c.tipo_cliente === 'socio';

    // Calcula totais
    let subtotal=0, desconto_total=0, total_final=0;
    for (const item of itens) {
      const vUnit = parseFloat(item.valor_unit_venda||0);
      const desc  = c.tipo_cliente==='especial' ? parseFloat(c.desconto_pct||0) : parseFloat(item.desconto_pct||0);
      const final = c.tipo_cliente==='socio'
        ? parseFloat(item.valor_unit_custo||0) * parseFloat(item.quantidade||1)
        : vUnit * parseFloat(item.quantidade||1) * (1 - desc/100);
      subtotal     += vUnit * parseFloat(item.quantidade||1);
      desconto_total += (vUnit * parseFloat(item.quantidade||1)) - final;
      total_final  += final;
      item._final   = final;
      item._desc    = desc;
    }

    // Validar limite
    const saldoAtual = await recalcSaldo(cliente_id);
    if (c.limite_credito && !precisa) {
      if (saldoAtual + total_final > parseFloat(c.limite_credito)) {
        const config = await pool.query(`SELECT valor FROM config WHERE chave='fiado_bloquear_limite'`).catch(()=>({rows:[]}));
        if (config.rows[0]?.valor === 'true') {
          return res.status(400).json({ ok:false, erro:`Limite de crédito excedido. Saldo atual: R$ ${saldoAtual.toFixed(2)}, Limite: R$ ${parseFloat(c.limite_credito).toFixed(2)}`, limite_excedido:true });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const status = precisa ? 'aguardando' : 'aberto';
      const { rows: [venda] } = await client.query(
        `INSERT INTO vendas_fiado(cliente_id,data_compra,subtotal_venda,desconto_total,total_final,saldo_restante,status,precisa_aprovacao,observacoes,usuario_resp)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [cliente_id, data_compra||new Date().toISOString().slice(0,10),
         subtotal.toFixed(2), desconto_total.toFixed(2), total_final.toFixed(2),
         precisa ? 0 : total_final.toFixed(2),
         status, precisa, observacoes||null, usuario]
      );
      for (const item of itens) {
        await client.query(
          `INSERT INTO itens_venda_fiado(venda_id,codigo_produto,nome_produto,quantidade,valor_unit_venda,valor_unit_custo,desconto_pct,valor_final_item)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [venda.id, item.codigo_produto||null, item.nome_produto, item.quantidade,
           item.valor_unit_venda||0, item.valor_unit_custo||0, item._desc||0, item._final.toFixed(2)]
        );
      }
      await client.query('COMMIT');
      const desc = precisa
        ? `Venda R$ ${total_final.toFixed(2)} aguardando aprovação (sócio)`
        : `Venda R$ ${total_final.toFixed(2)} lançada`;
      await log(cliente_id, precisa?'venda_aguardando':'venda_lancada', desc, usuario, venda.id);
      res.json({ ok:true, data:venda, aviso: c.limite_credito && (saldoAtual+total_final)>parseFloat(c.limite_credito) ? 'Limite excedido' : null });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ ok:false, erro:e.message }); }
    finally { client.release(); }
  });

  // ── PUT /vendas/:id/editar — editar itens/preços de venda aberta/parcial ──
  r.put('/vendas/:id/editar', async (req, res) => {
    const { itens, observacoes } = req.body;
    if (!itens || !itens.length) return res.status(400).json({ ok:false, erro:'itens obrigatórios' });

    try {
      // Só permite editar vendas abertas ou parcialmente pagas
      const { rows: [venda] } = await pool.query(
        `SELECT v.*, c.tipo_cliente, c.desconto_pct AS desc_cliente, c.nome AS cliente_nome
         FROM vendas_fiado v JOIN clientes_fiado c ON c.id=v.cliente_id WHERE v.id=$1`,
        [parseInt(req.params.id)]
      );
      if (!venda) return res.status(404).json({ ok:false, erro:'Venda não encontrada' });
      if (!['aberto','parcial','aguardando'].includes(venda.status)) {
        return res.status(400).json({ ok:false, erro:`Não é possível editar venda com status "${venda.status}". Apenas vendas em aberto, parciais ou aguardando aprovação podem ser editadas.` });
      }

      // Recalcular totais com os novos itens
      const c = { tipo_cliente: venda.tipo_cliente, desconto_pct: venda.desc_cliente };
      let subtotal=0, desconto_total=0, total_final=0;
      for (const item of itens) {
        const vUnit = parseFloat(item.valor_unit_venda||0);
        const desc  = c.tipo_cliente==='especial'
          ? parseFloat(c.desconto_pct||0)
          : parseFloat(item.desconto_pct||0);
        const final = c.tipo_cliente==='socio'
          ? parseFloat(item.valor_unit_custo||0) * parseFloat(item.quantidade||1)
          : vUnit * parseFloat(item.quantidade||1) * (1 - desc/100);
        subtotal      += vUnit * parseFloat(item.quantidade||1);
        desconto_total += (vUnit * parseFloat(item.quantidade||1)) - final;
        total_final   += final;
        item._final = final;
        item._desc  = desc;
      }

      // Preservar valor já pago — saldo restante = novo total - já pago
      const ja_pago = parseFloat(venda.total_final||0) - parseFloat(venda.saldo_restante||0);
      const novo_saldo = Math.max(0, total_final - ja_pago);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Atualizar cabeçalho da venda
        await client.query(
          `UPDATE vendas_fiado SET
             subtotal_venda=$1, desconto_total=$2, total_final=$3, saldo_restante=$4,
             observacoes=COALESCE($5, observacoes), atualizado_em=NOW()
           WHERE id=$6`,
          [subtotal.toFixed(2), desconto_total.toFixed(2), total_final.toFixed(2),
           novo_saldo.toFixed(2), observacoes||null, parseInt(req.params.id)]
        );
        // Substituir itens
        await client.query(`DELETE FROM itens_venda_fiado WHERE venda_id=$1`, [parseInt(req.params.id)]);
        for (const item of itens) {
          await client.query(
            `INSERT INTO itens_venda_fiado(venda_id,codigo_produto,nome_produto,quantidade,valor_unit_venda,valor_unit_custo,desconto_pct,valor_final_item)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [parseInt(req.params.id), item.codigo_produto||null, item.nome_produto,
             item.quantidade, item.valor_unit_venda||0, item.valor_unit_custo||0,
             item._desc||0, item._final.toFixed(2)]
          );
        }
        await client.query('COMMIT');
        await log(venda.cliente_id, 'venda_editada',
          `Venda editada: ${itens.length} item(s), novo total R$ ${total_final.toFixed(2)}`,
          req.user?.nome, parseInt(req.params.id));
        res.json({ ok:true, novo_total: total_final, novo_saldo });
      } catch(e) {
        await client.query('ROLLBACK');
        res.status(500).json({ ok:false, erro:e.message });
      } finally { client.release(); }
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/vendas/:id/aprovar', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false, erro:'Sem permissão' });
    try {
      const { rows } = await pool.query(
        `UPDATE vendas_fiado SET status='aberto', saldo_restante=total_final,
         aprovado_por=$1, aprovado_em=NOW(), updated_at=NOW() WHERE id=$2 AND status='aguardando' RETURNING *`,
        [req.user.nome, parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Venda não encontrada ou já processada' });
      await log(rows[0].cliente_id, 'venda_aprovada', `Venda aprovada por ${req.user.nome}`, req.user.nome, rows[0].id);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/vendas/:id/reprovar', async (req, res) => {
    if (!['admin','gestor'].includes(req.user?.perfil)) return res.status(403).json({ ok:false, erro:'Sem permissão' });
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(400).json({ ok:false, erro:'Motivo obrigatório' });
    try {
      const { rows } = await pool.query(
        `UPDATE vendas_fiado SET status='reprovado', motivo_reprovacao=$1, saldo_restante=0,
         aprovado_por=$2, aprovado_em=NOW(), updated_at=NOW() WHERE id=$3 AND status='aguardando' RETURNING *`,
        [motivo, req.user.nome, parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Não encontrada' });
      // Se reprovado, converter para cliente normal
      await pool.query(`UPDATE clientes_fiado SET tipo_cliente='normal' WHERE id=$1 AND tipo_cliente='socio'`, [rows[0].cliente_id]);
      await log(rows[0].cliente_id, 'venda_reprovada', `Venda reprovada: ${motivo}`, req.user.nome, rows[0].id);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  r.put('/vendas/:id/cancelar', async (req, res) => {
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(400).json({ ok:false, erro:'Motivo obrigatório' });
    try {
      const { rows } = await pool.query(
        `UPDATE vendas_fiado SET status='cancelado', saldo_restante=0,
         observacoes=CONCAT(COALESCE(observacoes,''),' [CANCELADO: ',CAST($1 AS TEXT),']'), updated_at=NOW()
         WHERE id=$2 AND status NOT IN('cancelado','reprovado') RETURNING *`,
        [motivo, parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ ok:false, erro:'Não encontrada' });
      await log(rows[0].cliente_id, 'venda_cancelada', `Venda cancelada: ${motivo}`, req.user?.nome, rows[0].id);
      res.json({ ok:true, data:rows[0] });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── PAGAMENTOS ─────────────────────────────────────────────────────────────
  r.post('/pagamentos', async (req, res) => {
    const { cliente_id, data_pagamento, valor_pago, forma_pagamento='dinheiro', observacoes, venda_id } = req.body;
    if (!cliente_id || !valor_pago) return res.status(400).json({ ok:false, erro:'Campos obrigatórios faltando' });
    const usuario = req.user?.nome || 'Sistema';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [pag] } = await client.query(
        `INSERT INTO pagamentos_fiado(cliente_id,data_pagamento,valor_pago,forma_pagamento,observacoes,usuario_resp)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [cliente_id, data_pagamento||new Date().toISOString().slice(0,10),
         valor_pago, forma_pagamento, observacoes||null, usuario]
      );

      // Abater nas vendas
      let restante = parseFloat(valor_pago);
      let vendasAbatidas = [];

      if (venda_id) {
        // Pagamento para venda específica
        const { rows: [v] } = await client.query(
          `SELECT * FROM vendas_fiado WHERE id=$1 AND cliente_id=$2 AND status IN('aberto','parcial')`, [venda_id, cliente_id]
        );
        if (v) {
          const abater = Math.min(restante, parseFloat(v.saldo_restante));
          const novoSaldo = parseFloat(v.saldo_restante) - abater;
          const novoStatus = novoSaldo <= 0.005 ? 'pago' : 'parcial';
          await client.query(
            `UPDATE vendas_fiado SET saldo_restante=$1, status=$2, updated_at=NOW() WHERE id=$3`,
            [novoSaldo.toFixed(2), novoStatus, v.id]
          );
          await client.query(
            `INSERT INTO pagamento_venda_fiado(pagamento_id,venda_id,valor_abatido) VALUES($1,$2,$3)`,
            [pag.id, v.id, abater.toFixed(2)]
          );
          vendasAbatidas.push({ venda_id: v.id, abatido: abater });
          restante -= abater;
        }
      } else {
        // Abater nas mais antigas em aberto
        const { rows: vendas } = await client.query(
          `SELECT * FROM vendas_fiado WHERE cliente_id=$1 AND status IN('aberto','parcial')
           ORDER BY data_compra ASC, id ASC`, [cliente_id]
        );
        for (const v of vendas) {
          if (restante <= 0.005) break;
          const abater = Math.min(restante, parseFloat(v.saldo_restante));
          const novoSaldo = parseFloat(v.saldo_restante) - abater;
          const novoStatus = novoSaldo <= 0.005 ? 'pago' : 'parcial';
          await client.query(
            `UPDATE vendas_fiado SET saldo_restante=$1, status=$2, updated_at=NOW() WHERE id=$3`,
            [novoSaldo.toFixed(2), novoStatus, v.id]
          );
          await client.query(
            `INSERT INTO pagamento_venda_fiado(pagamento_id,venda_id,valor_abatido) VALUES($1,$2,$3)`,
            [pag.id, v.id, abater.toFixed(2)]
          );
          vendasAbatidas.push({ venda_id: v.id, abatido: abater });
          restante -= abater;
        }
      }

      // Se sobrou, registrar como crédito do cliente
      let credito = restante > 0.005 ? restante : 0;

      await client.query('COMMIT');
      await log(cliente_id, 'pagamento_registrado',
        `Pagamento R$ ${parseFloat(valor_pago).toFixed(2)} via ${forma_pagamento}${credito>0?' (crédito R$'+credito.toFixed(2)+')':''}`,
        usuario, null, pag.id);
      res.json({ ok:true, data:pag, vendas_abatidas:vendasAbatidas, credito_gerado:credito });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ ok:false, erro:e.message }); }
    finally { client.release(); }
  });

  r.get('/pagamentos', async (req, res) => {
    const { cliente_id } = req.query;
    try {
      const { rows } = await pool.query(`
        SELECT p.*,
          (SELECT json_agg(json_build_object('venda_id',pv.venda_id,'valor_abatido',pv.valor_abatido))
           FROM pagamento_venda_fiado pv WHERE pv.pagamento_id=p.id) AS vendas_abatidas
        FROM pagamentos_fiado p
        WHERE ($1::int IS NULL OR p.cliente_id=$1)
        ORDER BY p.data_pagamento DESC, p.id DESC LIMIT 200
      `, [cliente_id||null]);
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── HISTÓRICO ──────────────────────────────────────────────────────────────
  r.get('/historico', async (req, res) => {
    const { cliente_id } = req.query;
    try {
      const { rows } = await pool.query(
        `SELECT * FROM historico_fiado WHERE ($1::int IS NULL OR cliente_id=$1) ORDER BY data_evento DESC LIMIT 300`,
        [cliente_id||null]
      );
      res.json({ ok:true, data:rows });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── MINHA CONTA (funcionário logado) ─────────────────────────────────────
  r.get('/minha-conta', async (req, res) => {
    try {
      // Busca funcionário vinculado ao usuário logado pelo nome
      const { rows: [cli] } = await pool.query(`
        SELECT cf.*, f.nome AS func_nome
        FROM clientes_fiado cf
        LEFT JOIN funcionarios f ON f.id=cf.funcionario_id -- F2-13
        WHERE cf.tipo_cliente='funcionario'
          AND (cf.funcionario_id=(SELECT id FROM funcionarios WHERE LOWER(nome) LIKE LOWER($1) LIMIT 1) -- F2-13
               OR LOWER(cf.nome) LIKE LOWER($1))
        LIMIT 1
      `, [`%${req.user?.nome?.split(' ')[0]}%`]);
      if (!cli) return res.json({ ok:true, data:null });
      const { rows: vendas } = await pool.query(`
        SELECT v.*, (SELECT json_agg(i) FROM itens_venda_fiado i WHERE i.venda_id=v.id) AS itens
        FROM vendas_fiado v WHERE v.cliente_id=$1 AND v.status NOT IN('cancelado','reprovado')
        ORDER BY v.data_compra DESC LIMIT 50
      `, [cli.id]);
      const { rows: pagamentos } = await pool.query(`SELECT * FROM pagamentos_fiado WHERE cliente_id=$1 ORDER BY data_pagamento DESC LIMIT 20`, [cli.id]);
      const saldo = vendas.filter(v=>['aberto','parcial'].includes(v.status)).reduce((s,v)=>s+parseFloat(v.saldo_restante||0),0);
      res.json({ ok:true, data:{ cliente:cli, vendas, pagamentos, saldo } });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── KPIs / DASHBOARD ───────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const { rows: [k] } = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN v.status IN('aberto','parcial') THEN v.saldo_restante END),0) AS total_aberto,
          COUNT(DISTINCT CASE WHEN v.status IN('aberto','parcial') THEN v.cliente_id END) AS clientes_com_saldo,
          COALESCE(SUM(CASE WHEN v.status='aguardando' THEN 1 ELSE 0 END),0) AS pendentes_aprovacao,
          COALESCE(SUM(CASE WHEN EXTRACT(MONTH FROM v.data_compra)=EXTRACT(MONTH FROM NOW())
            AND EXTRACT(YEAR FROM v.data_compra)=EXTRACT(YEAR FROM NOW())
            AND v.status NOT IN('cancelado','reprovado') THEN v.total_final END),0) AS vendido_mes
        FROM vendas_fiado v
      `);
      const { rows: [r2] } = await pool.query(`
        SELECT COALESCE(SUM(p.valor_pago),0) AS recebido_mes
        FROM pagamentos_fiado p
        WHERE EXTRACT(MONTH FROM p.data_pagamento)=EXTRACT(MONTH FROM NOW())
          AND EXTRACT(YEAR FROM p.data_pagamento)=EXTRACT(YEAR FROM NOW())
      `);
      const { rows: acima } = await pool.query(`
        SELECT COUNT(*) AS qt FROM (
          SELECT c.id FROM clientes_fiado c
          WHERE c.limite_credito IS NOT NULL AND c.limite_credito > 0
            AND (SELECT COALESCE(SUM(v.saldo_restante),0) FROM vendas_fiado v
                 WHERE v.cliente_id=c.id AND v.status IN('aberto','parcial')) > c.limite_credito
        ) x
      `);
      res.json({ ok:true, data: { ...k, recebido_mes: r2.recebido_mes, acima_limite: acima[0].qt } });
    } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
  });

  // ── PENDENTES APROVAÇÃO (para dashboard admin) ────────────────────────────
  r.get('/pendentes-aprovacao/count', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*) AS total FROM vendas_fiado WHERE status='aguardando'`);
      res.json({ ok:true, total: parseInt(rows[0].total) });
    } catch(e) { res.json({ ok:false, total:0 }); }
  });

  return r;
};
