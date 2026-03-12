/**
 * routes/validade.js
 * Módulo de controle de validades — usado pelo PWA mobile
 *
 * Rotas:
 *   GET  /api/validade/estoque         → lista lotes ativos com produto e urgência
 *   GET  /api/validade/alertas         → só vencidos + críticos + urgentes
 *   GET  /api/validade/kpis            → contadores por status
 *   POST /api/validade/lote            → adiciona lote manualmente
 *   POST /api/validade/baixa/:loteId   → registra baixa (venda/descarte/perda)
 *   GET  /api/validade/perdas          → histórico de perdas
 *   GET  /api/validade/funcionarios    → lista funcionários ativos para o select
 */

const express = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();

  // Todos os endpoints exigem autenticação
  r.use(autenticar);

  // ── helpers ────────────────────────────────────────────────────────────────
  function calcStatus(dataValidade) {
    if (!dataValidade) return 'sem-data';
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const val  = new Date(dataValidade); val.setHours(0, 0, 0, 0);
    const dias = Math.round((val - hoje) / 86400000);
    if (dias < 0)   return 'vencido';
    if (dias <= 7)  return 'critico';
    if (dias <= 15) return 'urgente';
    if (dias <= 30) return 'atencao';
    return 'ok';
  }

  function calcDias(dataValidade) {
    if (!dataValidade) return null;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const val  = new Date(dataValidade); val.setHours(0, 0, 0, 0);
    return Math.round((val - hoje) / 86400000);
  }

  // ── GET /estoque ──────────────────────────────────────────────────────────
  // Lista todos os lotes ativos com quantidade > 0, agrupando info do produto
  r.get('/estoque', async (req, res) => {
    try {
      const { status } = req.query; // filtro opcional: vencido|critico|urgente|atencao|ok

      const sql = `
        SELECT
          l.id,
          l.codigo_produto,
          pm.descricao_produto      AS nome,
          pm.descricao_reduzida     AS nome_curto,
          pm.categoria,
          pm.unidade,
          l.lote,
          l.data_validade,
          l.quantidade_atual,
          l.local_armazenamento     AS local,
          l.custo_unitario,
          l.observacao,
          l.criado_em
        FROM lotes_estoque l
        JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
        WHERE l.ativo = true
          AND l.quantidade_atual > 0
          AND pm.controla_validade = true
        ORDER BY l.data_validade ASC NULLS LAST, pm.descricao_produto ASC
      `;

      const { rows } = await pool.query(sql);

      const result = rows
        .map(row => ({
          ...row,
          status:    calcStatus(row.data_validade),
          dias:      calcDias(row.data_validade),
          quantidade_atual: parseFloat(row.quantidade_atual) || 0,
          custo_unitario:   parseFloat(row.custo_unitario)   || 0,
        }))
        .filter(row => !status || row.status === status);

      res.json({ ok: true, data: result });
    } catch (e) {
      console.error('[validade/estoque]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /alertas ──────────────────────────────────────────────────────────
  r.get('/alertas', async (req, res) => {
    try {
      const sql = `
        SELECT
          l.id, l.codigo_produto,
          pm.descricao_produto AS nome,
          pm.unidade,
          l.lote, l.data_validade,
          l.quantidade_atual,
          l.local_armazenamento AS local,
          l.custo_unitario
        FROM lotes_estoque l
        JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
        WHERE l.ativo = true
          AND l.quantidade_atual > 0
          AND pm.controla_validade = true
          AND (l.data_validade IS NULL OR l.data_validade <= CURRENT_DATE + INTERVAL '15 days')
        ORDER BY l.data_validade ASC NULLS FIRST
      `;
      const { rows } = await pool.query(sql);
      const result = rows.map(row => ({
        ...row,
        status: calcStatus(row.data_validade),
        dias:   calcDias(row.data_validade),
        quantidade_atual: parseFloat(row.quantidade_atual) || 0,
        custo_unitario:   parseFloat(row.custo_unitario)   || 0,
      }));
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /kpis ─────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE data_validade < CURRENT_DATE)                              AS vencidos,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)   AS criticos,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE + 8 AND CURRENT_DATE + 15) AS urgentes,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE + 16 AND CURRENT_DATE + 30) AS atencao,
          COUNT(*) FILTER (WHERE data_validade > CURRENT_DATE + 30)                         AS ok,
          COUNT(*) FILTER (WHERE data_validade IS NULL)                                     AS sem_data,
          COUNT(*)                                                                           AS total
        FROM lotes_estoque l
        JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
        WHERE l.ativo = true AND l.quantidade_atual > 0 AND pm.controla_validade = true
      `);

      // Perdas do mês
      const { rows: perdas } = await pool.query(`
        SELECT COUNT(*) AS qtd_perdas,
               COALESCE(SUM(valor_estimado),0) AS valor_perdas
        FROM perdas
        WHERE DATE_TRUNC('month', data_perda) = DATE_TRUNC('month', NOW())
      `);

      res.json({
        ok: true,
        data: {
          ...rows[0],
          qtd_perdas_mes:   parseInt(perdas[0].qtd_perdas),
          valor_perdas_mes: parseFloat(perdas[0].valor_perdas),
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /lote ────────────────────────────────────────────────────────────
  // Adiciona lote manualmente (para quando o produto não veio da NF-e)
  r.post('/lote', async (req, res) => {
    const { codigo_produto, lote, data_validade, quantidade, custo_unitario, local_armazenamento, observacao } = req.body;
    if (!codigo_produto || !quantidade) return res.status(400).json({ ok: false, erro: 'codigo_produto e quantidade são obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO lotes_estoque
          (codigo_produto, lote, data_validade, quantidade, quantidade_atual, custo_unitario, local_armazenamento, usuario_lancamento, observacao)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)
        RETURNING *
      `, [codigo_produto, lote||null, data_validade||null, quantidade, custo_unitario||null, local_armazenamento||null, req.user.id, observacao||null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) {
      console.error('[validade/lote]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /baixa/:loteId ───────────────────────────────────────────────────
  // Reduz quantidade do lote e, se for perda/descarte, registra em perdas
  r.post('/baixa/:loteId', async (req, res) => {
    const { loteId } = req.params;
    const { quantidade, tipo, funcionario_responsavel, observacao } = req.body;

    if (!quantidade || quantidade <= 0) return res.status(400).json({ ok: false, erro: 'Quantidade inválida' });
    if (!tipo) return res.status(400).json({ ok: false, erro: 'Tipo obrigatório (venda|descarte|perda|transferencia)' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Busca lote
      const { rows: loteRows } = await client.query(
        'SELECT * FROM lotes_estoque WHERE id=$1 AND ativo=true FOR UPDATE', [loteId]
      );
      if (!loteRows.length) throw new Error('Lote não encontrado');
      const lote = loteRows[0];

      if (quantidade > lote.quantidade_atual) throw new Error(`Quantidade (${quantidade}) maior que estoque atual (${lote.quantidade_atual})`);

      const novaQtd = parseFloat(lote.quantidade_atual) - parseFloat(quantidade);

      // Atualiza ou desativa lote
      if (novaQtd <= 0) {
        await client.query('UPDATE lotes_estoque SET quantidade_atual=0, ativo=false, atualizado_em=NOW() WHERE id=$1', [loteId]);
      } else {
        await client.query('UPDATE lotes_estoque SET quantidade_atual=$1, atualizado_em=NOW() WHERE id=$2', [novaQtd, loteId]);
      }

      // Registra perda se tipo for perda/descarte/vencimento
      let perdaId = null;
      if (['perda', 'descarte', 'vencimento'].includes(tipo)) {
        const motivo = tipo === 'vencimento' ? 'Produto vencido' : tipo === 'descarte' ? 'Descarte' : 'Perda operacional';
        const { rows: perdaRows } = await client.query(`
          INSERT INTO perdas
            (codigo_produto, lote_id, data_perda, quantidade, motivo, tipo_motivo, funcionario_responsavel, usuario_lancamento, observacao)
          VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8)
          RETURNING id
        `, [lote.codigo_produto, loteId, quantidade, motivo, tipo, funcionario_responsavel||null, req.user.id, observacao||null]);
        perdaId = perdaRows[0].id;
      }

      await client.query('COMMIT');
      res.json({ ok: true, novaQuantidade: novaQtd, loteDesativado: novaQtd <= 0, perdaId });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[validade/baixa]', e.message);
      res.status(400).json({ ok: false, erro: e.message });
    } finally {
      client.release();
    }
  });

  // ── GET /perdas ───────────────────────────────────────────────────────────
  r.get('/perdas', async (req, res) => {
    try {
      const { mes } = req.query; // formato: YYYY-MM
      let where = '';
      const params = [];
      if (mes) {
        where = `WHERE DATE_TRUNC('month', p.data_perda) = $1::date`;
        params.push(mes + '-01');
      }

      const { rows } = await pool.query(`
        SELECT
          p.*,
          pm.descricao_produto AS nome_produto,
          pm.categoria,
          pm.unidade
        FROM perdas p
        JOIN produtos_mestre pm ON pm.codigo_produto = p.codigo_produto
        ${where}
        ORDER BY p.data_perda DESC, p.id DESC
        LIMIT 200
      `, params);

      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /funcionarios ─────────────────────────────────────────────────────
  r.get('/funcionarios', async (req, res) => {
    try {
      // Tenta buscar da tabela de usuários como fallback
      const { rows } = await pool.query(`
        SELECT id, nome FROM usuarios WHERE ativo = true ORDER BY nome ASC
      `);
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.json({ ok: true, data: [] });
    }
  });

  // ── POST /sincronizar-lote ────────────────────────────────────────────────
  r.post('/sincronizar-lote', async (req, res) => {
    const { codigo_produto, nome_produto, data_validade, quantidade_atual, custo_unitario, local_armazenamento, unidade } = req.body;
    if (!codigo_produto) return res.status(400).json({ ok: false, erro: 'codigo_produto obrigatório' });

    try {
      // Garante que o produto existe em produtos_mestre (upsert simples)
      await pool.query(`
        INSERT INTO produtos_mestre (codigo_produto, descricao_produto, unidade, controla_validade)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (codigo_produto) DO UPDATE SET controla_validade = true
      `, [codigo_produto, nome_produto || codigo_produto, unidade || 'KG']);

      // Verifica se já existe lote ativo para esse produto com essa validade
      const { rows: existing } = await pool.query(`
        SELECT id FROM lotes_estoque 
        WHERE codigo_produto = $1 AND ativo = true
        AND (data_validade = $2 OR (data_validade IS NULL AND $2 IS NULL))
        LIMIT 1
      `, [codigo_produto, data_validade || null]);

      if (existing.length) {
        await pool.query(`
          UPDATE lotes_estoque 
          SET quantidade_atual = $1, custo_unitario = COALESCE($2, custo_unitario),
              local_armazenamento = COALESCE($3, local_armazenamento), atualizado_em = NOW()
          WHERE id = $4
        `, [quantidade_atual || 0, custo_unitario || null, local_armazenamento || null, existing[0].id]);
      } else {
        await pool.query(`
          INSERT INTO lotes_estoque
            (codigo_produto, data_validade, quantidade, quantidade_atual, custo_unitario, local_armazenamento, usuario_lancamento)
          VALUES ($1, $2, $3, $3, $4, $5, $6)
        `, [codigo_produto, data_validade || null, quantidade_atual || 0,
            custo_unitario || null, local_armazenamento || null, req.user.id]);
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('[validade/sincronizar-lote]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });


  r.get('/produtos-search', async (req, res) => {
    try {
      const { q = '' } = req.query;
      const { rows } = await pool.query(`
        SELECT codigo_produto, descricao_produto, descricao_reduzida, unidade, preco_custo
        FROM produtos_mestre
        WHERE ativo = true AND controla_validade = true
          AND (descricao_produto ILIKE $1 OR codigo_produto ILIKE $1)
        ORDER BY descricao_produto ASC
        LIMIT 20
      `, [`%${q}%`]);
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
