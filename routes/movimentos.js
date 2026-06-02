/**
 * routes/movimentos.js — Endpoint de movimentação de estoque (F1-03)
 * Bom Beef Sistema de Gestão — AR Boutique de Carnes LTDA
 *
 * POST /api/estoque/movimento  — registra um movimento e atualiza produtos.estoque
 * GET  /api/estoque/historico/:produto_id — histórico de movimentos de um produto
 *
 * REGRAS:
 * - Nunca altera dados de tabelas existentes sem transação
 * - Falha no registro de movimento NÃO bloqueia o fluxo de negócio do chamador
 * - produtos.estoque é atualizado atomicamente junto ao movimento
 */

'use strict';

const express   = require('express');
const autenticar = require('../middleware/auth');
const events    = require('../lib/events');

module.exports = function(pool, app) {
  const r = express.Router();
  r.use(autenticar());

  // Tipos válidos — espelho do CHECK constraint na tabela
  const TIPOS_VALIDOS = new Set([
    'ENTRADA_COMPRA','ENTRADA_AJUSTE','VENDA','PERDA','VALIDADE',
    'KIT_RESERVA','KIT_CANCELAMENTO','RETIRADA_FUNCIONARIO',
    'AJUSTE_INVENTARIO','IMPORTACAO_PDV'
  ]);

  // ── POST /movimento — registra movimento e atualiza estoque ──────────────────
  r.post('/movimento', async (req, res) => {
    const {
      produto_id,
      tipo_movimento,
      quantidade,
      origem,
      origem_id,
      observacao,
    } = req.body;

    // Validações básicas
    if (!produto_id)     return res.status(400).json({ ok: false, erro: 'produto_id obrigatório' });
    if (!tipo_movimento) return res.status(400).json({ ok: false, erro: 'tipo_movimento obrigatório' });
    if (!TIPOS_VALIDOS.has(tipo_movimento))
      return res.status(400).json({ ok: false, erro: `tipo_movimento inválido: ${tipo_movimento}` });
    if (quantidade === undefined || quantidade === null)
      return res.status(400).json({ ok: false, erro: 'quantidade obrigatória' });

    const qtd = parseFloat(quantidade);
    if (isNaN(qtd)) return res.status(400).json({ ok: false, erro: 'quantidade inválida' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Busca produto e estoque atual (com lock para evitar race condition)
      const { rows: prods } = await client.query(
        'SELECT id, codigo, estoque FROM produtos WHERE id = $1 FOR UPDATE',
        [produto_id]
      );
      if (!prods.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      }

      const produto        = prods[0];
      const estoqueAnterior = parseFloat(produto.estoque || 0);
      const estoquePosterior = Math.max(0, estoqueAnterior + qtd);

      // 2. Atualiza produtos.estoque
      await client.query(
        'UPDATE produtos SET estoque = $1, atualizado_em = NOW() WHERE id = $2',
        [estoquePosterior, produto_id]
      );

      // 3. Registra movimento
      const { rows: movRows } = await client.query(`
        INSERT INTO movimentos_estoque
          (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
           quantidade, estoque_anterior, estoque_posterior, usuario_id, observacao)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, data_movimento
      `, [
        produto_id,
        produto.codigo,
        tipo_movimento,
        origem || null,
        origem_id ? parseInt(origem_id) : null,
        qtd,
        estoqueAnterior,
        estoquePosterior,
        req.user?.id || null,
        observacao || null,
      ]);

      await client.query('COMMIT');

      const movimento = movRows[0];

      // 4. Emite evento SSE (fora da transação — falha não reverte)
      events.emit(app, 'MOVIMENTO_ESTOQUE', {
        movimento_id:      movimento.id,
        produto_id,
        produto_codigo:    produto.codigo,
        tipo_movimento,
        quantidade:        qtd,
        estoque_anterior:  estoqueAnterior,
        estoque_posterior: estoquePosterior,
        origem,
      });

      // Se for saída de estoque, emite ESTOQUE_ATUALIZADO também
      if (qtd < 0 || tipo_movimento === 'IMPORTACAO_PDV') {
        events.emit(app, 'ESTOQUE_ATUALIZADO', {
          produto_id,
          produto_codigo: produto.codigo,
          novo_estoque:   estoquePosterior,
        });
      }

      res.status(201).json({
        ok: true,
        movimento_id:      movimento.id,
        data_movimento:    movimento.data_movimento,
        estoque_anterior:  estoqueAnterior,
        estoque_posterior: estoquePosterior,
      });

    } catch(e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[movimentos] erro:', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    } finally {
      client.release();
    }
  });

  // ── GET /historico/:produto_id — histórico de movimentos ─────────────────────
  r.get('/historico/:produto_id', async (req, res) => {
    const limite    = Math.min(parseInt(req.query.limite) || 50, 200);
    const data_ini  = req.query.data_ini || null;
    const data_fim  = req.query.data_fim || null;
    const tipo      = req.query.tipo     || null;

    try {
      const params  = [parseInt(req.params.produto_id)];
      let   where   = 'WHERE m.produto_id = $1';

      if (data_ini) { params.push(data_ini); where += ` AND m.data_movimento >= $${params.length}`; }
      if (data_fim) { params.push(data_fim); where += ` AND m.data_movimento <= $${params.length}`; }
      if (tipo)     { params.push(tipo);     where += ` AND m.tipo_movimento = $${params.length}`; }

      params.push(limite);

      const { rows } = await pool.query(`
        SELECT
          m.id, m.data_movimento, m.tipo_movimento, m.origem, m.origem_id,
          m.quantidade, m.estoque_anterior, m.estoque_posterior,
          m.observacao, m.criado_em,
          u.nome AS usuario_nome
        FROM movimentos_estoque m
        LEFT JOIN usuarios u ON u.id = m.usuario_id
        ${where}
        ORDER BY m.data_movimento DESC
        LIMIT $${params.length}
      `, params);

      res.json({ ok: true, data: rows, total: rows.length });
    } catch(e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /saldo/:produto_id — saldo calculado pelos movimentos ────────────────
  r.get('/saldo/:produto_id', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          p.id, p.codigo, p.descricao,
          p.estoque AS estoque_atual,
          COUNT(m.id)::int AS total_movimentos,
          MAX(m.data_movimento) AS ultimo_movimento
        FROM produtos p
        LEFT JOIN movimentos_estoque m ON m.produto_id = p.id
        WHERE p.id = $1
        GROUP BY p.id, p.codigo, p.descricao, p.estoque
      `, [parseInt(req.params.produto_id)]);

      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      res.json({ ok: true, data: rows[0] });
    } catch(e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /auditoria — visão consolidada F2-09 ────────────────────────────────
  // Retorna movimentos com produto + usuário + filtros avançados
  r.get('/auditoria', async (req, res) => {
    const limite   = Math.min(parseInt(req.query.limite) || 100, 500);
    const pagina   = Math.max(1, parseInt(req.query.pagina) || 1);
    const offset   = (pagina - 1) * limite;
    const tipo     = req.query.tipo     || null;
    const origem   = req.query.origem   || null;
    const usuario  = req.query.usuario  || null;
    const produto  = req.query.produto  || null;  // busca por código ou descrição
    const dataIni  = req.query.data_ini || null;
    const dataFim  = req.query.data_fim || null;
    const mesRef   = req.query.mes      || null;   // MM/YYYY

    try {
      const params = [];
      const conds  = [];

      if (tipo)    { params.push(tipo);    conds.push(`m.tipo_movimento = $${params.length}`); }
      if (origem)  { params.push(origem);  conds.push(`m.origem = $${params.length}`); }
      if (usuario) { params.push(parseInt(usuario)); conds.push(`m.usuario_id = $${params.length}`); }
      if (produto) { params.push(`%${produto}%`); conds.push(`(p.codigo ILIKE $${params.length} OR p.descricao ILIKE $${params.length})`); }
      if (dataIni) { params.push(dataIni); conds.push(`m.data_movimento >= $${params.length}`); }
      if (dataFim) { params.push(dataFim); conds.push(`m.data_movimento <= $${params.length}::date + INTERVAL '1 day'`); }
      if (mesRef)  { params.push(mesRef);  conds.push(`TO_CHAR(m.data_movimento,'MM/YYYY') = $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      // Contar total para paginação
      const countParams = [...params];
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM movimentos_estoque m
         LEFT JOIN produtos p ON p.id = m.produto_id
         ${where}`, countParams
      );
      const total = countRows[0].n;

      // Buscar registros
      params.push(limite); const pLim = params.length;
      params.push(offset); const pOff = params.length;

      const { rows } = await pool.query(`
        SELECT
          m.id,
          m.data_movimento,
          m.tipo_movimento,
          m.origem,
          m.origem_id,
          m.quantidade,
          m.estoque_anterior,
          m.estoque_posterior,
          m.observacao,
          -- Produto
          p.id             AS produto_id,
          p.codigo         AS produto_codigo,
          p.descricao      AS produto_descricao,
          p.unidade        AS produto_unidade,
          -- Usuário
          u.id             AS usuario_id,
          u.nome           AS usuario_nome
        FROM movimentos_estoque m
        LEFT JOIN produtos  p ON p.id = m.produto_id
        LEFT JOIN usuarios  u ON u.id = m.usuario_id
        ${where}
        ORDER BY m.data_movimento DESC
        LIMIT $${pLim} OFFSET $${pOff}
      `, params);

      res.json({
        ok: true,
        data: rows,
        total,
        pagina,
        paginas: Math.ceil(total / limite),
        limite,
      });
    } catch(e) {
      console.error('[movimentos/auditoria]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /tipos — lista tipos de movimentos disponíveis ───────────────────
  r.get('/tipos', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT tipo_movimento, COUNT(*)::int AS total, MAX(data_movimento) AS ultimo
        FROM movimentos_estoque
        GROUP BY tipo_movimento
        ORDER BY total DESC
      `);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
