/**
 * routes/validade.js
 * Controle de validades — desktop + PWA mobile
 *
 * Tabelas novas (criadas automaticamente no primeiro uso):
 *   vld_estoque     — estoque desktop (importado de planilha)
 *   vld_faturamento — faturamento histórico por mês (MM/YYYY)
 *   vld_retiradas   — retiradas de funcionárias
 *   vld_config      — chave/valor para metas, prazos, locais, bônus
 *
 * Tabelas existentes (compartilhadas):
 *   perdas          — perdas registradas (mobile + desktop)
 *   lotes_estoque   — lotes do banco (mobile)
 *   produtos_mestre — catálogo de produtos
 */

const express = require('express');
const autenticar = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar);

  // ══════════════════════════════════════════════════════════════════════
  // INIT — cria tabelas se não existirem
  // ══════════════════════════════════════════════════════════════════════
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vld_estoque (
        id            TEXT PRIMARY KEY,
        cod_produto   TEXT,
        nome_produto  TEXT NOT NULL,
        data_validade DATE,
        qtd_atual     NUMERIC(12,3) DEFAULT 0,
        unidade       TEXT DEFAULT 'UN',
        local         TEXT,
        data_entrada  DATE,
        valor_unit    NUMERIC(10,2) DEFAULT 0,
        acao_vencer   TEXT,
        conferencia   TEXT,
        resultado     TEXT,
        custom_dias   JSONB,
        ativo         BOOLEAN DEFAULT true,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vld_faturamento (
        mes_ref  TEXT PRIMARY KEY,  -- formato MM/YYYY
        real     NUMERIC(14,2),
        previsto NUMERIC(14,2),
        manual   NUMERIC(14,2),
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vld_retiradas (
        id           TEXT PRIMARY KEY,
        func_id      TEXT,
        func_nome    TEXT NOT NULL,
        data         DATE NOT NULL,
        produto      TEXT NOT NULL,
        qtd          NUMERIC(12,3) NOT NULL,
        unidade      TEXT DEFAULT 'KG',
        preco_custo  NUMERIC(10,2),
        preco_venda  NUMERIC(10,2),
        total_custo  NUMERIC(12,2),
        total_venda  NUMERIC(12,2),
        observacao   TEXT,
        criado_em    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vld_config (
        chave       TEXT PRIMARY KEY,
        valor_json  JSONB NOT NULL,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }
  initTables().catch(e => console.error('[validade] initTables:', e.message));

  // ── helpers ────────────────────────────────────────────────────────────
  function calcStatus(dv) {
    if (!dv) return 'sem-data';
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const val  = new Date(dv); val.setHours(0,0,0,0);
    const d    = Math.round((val - hoje) / 86400000);
    if (d < 0)   return 'vencido';
    if (d <= 7)  return 'critico';
    if (d <= 15) return 'urgente';
    if (d <= 30) return 'atencao';
    return 'ok';
  }
  function calcDias(dv) {
    if (!dv) return null;
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const val  = new Date(dv); val.setHours(0,0,0,0);
    return Math.round((val - hoje) / 86400000);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CONFIG (metas, prazos, locais, bonus)
  // ══════════════════════════════════════════════════════════════════════

  // GET /config/:chave
  r.get('/config/:chave', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT valor_json FROM vld_config WHERE chave = $1`, [req.params.chave]
      );
      res.json({ ok: true, data: rows[0]?.valor_json ?? null });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // POST /config/:chave  { valor: <any> }
  r.post('/config/:chave', async (req, res) => {
    try {
      await pool.query(`
        INSERT INTO vld_config (chave, valor_json, atualizado_em)
        VALUES ($1, $2, NOW())
        ON CONFLICT (chave) DO UPDATE
          SET valor_json = $2, atualizado_em = NOW()
      `, [req.params.chave, JSON.stringify(req.body.valor)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // GET /config-bulk?chaves=meta,locais,bonus,...
  r.get('/config-bulk', async (req, res) => {
    try {
      const chaves = (req.query.chaves || '').split(',').filter(Boolean);
      if (!chaves.length) return res.json({ ok: true, data: {} });
      const { rows } = await pool.query(
        `SELECT chave, valor_json FROM vld_config WHERE chave = ANY($1)`, [chaves]
      );
      const data = {};
      rows.forEach(r => { data[r.chave] = r.valor_json; });
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // ESTOQUE DESKTOP (vld_estoque)
  // ══════════════════════════════════════════════════════════════════════

  // GET /estoque-desktop
  r.get('/estoque-desktop', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT * FROM vld_estoque WHERE ativo = true ORDER BY data_validade ASC NULLS LAST, nome_produto ASC
      `);
      const data = rows.map(x => ({
        id:           x.id,
        cProd:        x.cod_produto,
        xProd:        x.nome_produto,
        dVal:         x.data_validade ? x.data_validade.toISOString().slice(0,10) : null,
        qAtual:       parseFloat(x.qtd_atual) || 0,
        uCom:         x.unidade,
        local:        x.local,
        entrada:      x.data_entrada ? x.data_entrada.toISOString().slice(0,10) : null,
        valorUnit:    parseFloat(x.valor_unit) || 0,
        acaoAnteVencer: x.acao_vencer,
        conferencia:  x.conferencia,
        resultado:    x.resultado,
        customDias:   x.custom_dias,
        status:       calcStatus(x.data_validade),
        dias:         calcDias(x.data_validade),
      }));
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // POST /estoque-desktop/bulk  { produtos: [...] }  — upsert em lote (import planilha)
  r.post('/estoque-desktop/bulk', async (req, res) => {
    const { produtos = [], modo = 'merge' } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (modo === 'sub') {
        await client.query(`UPDATE vld_estoque SET ativo = false`);
      }
      for (const p of produtos) {
        await client.query(`
          INSERT INTO vld_estoque
            (id, cod_produto, nome_produto, data_validade, qtd_atual, unidade,
             local, data_entrada, valor_unit, acao_vencer, conferencia, resultado,
             custom_dias, ativo, atualizado_em)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,NOW())
          ON CONFLICT (id) DO UPDATE SET
            cod_produto   = EXCLUDED.cod_produto,
            nome_produto  = EXCLUDED.nome_produto,
            data_validade = EXCLUDED.data_validade,
            qtd_atual     = EXCLUDED.qtd_atual,
            unidade       = EXCLUDED.unidade,
            local         = EXCLUDED.local,
            data_entrada  = EXCLUDED.data_entrada,
            valor_unit    = EXCLUDED.valor_unit,
            acao_vencer   = EXCLUDED.acao_vencer,
            conferencia   = EXCLUDED.conferencia,
            resultado     = EXCLUDED.resultado,
            custom_dias   = EXCLUDED.custom_dias,
            ativo         = true,
            atualizado_em = NOW()
        `, [
          p.id, p.cProd||null, p.xProd, p.dVal||null,
          p.qAtual||0, p.uCom||'UN', p.local||null,
          p.entrada||null, p.valorUnit||0, p.acaoAnteVencer||null,
          p.conferencia||null, p.resultado||null,
          p.customDias ? JSON.stringify(p.customDias) : null
        ]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, count: produtos.length });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // PUT /estoque-desktop/:id  — edita produto
  r.put('/estoque-desktop/:id', async (req, res) => {
    const p = req.body;
    try {
      await pool.query(`
        UPDATE vld_estoque SET
          cod_produto=$1, nome_produto=$2, data_validade=$3, qtd_atual=$4,
          unidade=$5, local=$6, data_entrada=$7, valor_unit=$8,
          acao_vencer=$9, conferencia=$10, resultado=$11, custom_dias=$12,
          atualizado_em=NOW()
        WHERE id=$13
      `, [
        p.cProd||null, p.xProd, p.dVal||null, p.qAtual||0,
        p.uCom||'UN', p.local||null, p.entrada||null, p.valorUnit||0,
        p.acaoAnteVencer||null, p.conferencia||null, p.resultado||null,
        p.customDias ? JSON.stringify(p.customDias) : null,
        req.params.id
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // DELETE /estoque-desktop/:id  — desativa produto
  r.delete('/estoque-desktop/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE vld_estoque SET ativo=false, atualizado_em=NOW() WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // DELETE /estoque-desktop/bulk  { ids: [...] }
  r.post('/estoque-desktop/bulk-delete', async (req, res) => {
    const { ids = [] } = req.body;
    try {
      await pool.query(`UPDATE vld_estoque SET ativo=false, atualizado_em=NOW() WHERE id = ANY($1)`, [ids]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // POST /estoque-desktop/:id/baixa  — registra baixa/saída
  r.post('/estoque-desktop/:id/baixa', async (req, res) => {
    const { qtd, tipo, resp, obs } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM vld_estoque WHERE id=$1 AND ativo=true FOR UPDATE`, [req.params.id]
      );
      if (!rows.length) throw new Error('Produto não encontrado');
      const x = rows[0];
      const semEstoque = parseFloat(x.qtd_atual) <= 0;

      if (!semEstoque) {
        const nova = Math.max(0, parseFloat(x.qtd_atual) - (parseFloat(qtd)||0));
        if (nova <= 0 || tipo === 'venda') {
          await client.query(`UPDATE vld_estoque SET ativo=false, qtd_atual=0, atualizado_em=NOW() WHERE id=$1`, [req.params.id]);
        } else {
          await client.query(`UPDATE vld_estoque SET qtd_atual=$1, atualizado_em=NOW() WHERE id=$2`, [nova, req.params.id]);
        }
        // Registra perda se for descarte/perda/vencimento
        if (['descarte','perda','vencimento'].includes(tipo)) {
          const p4 = await client.query(`SELECT valor_json FROM vld_config WHERE chave='metas'`);
          const fator = (p4.rows[0]?.valor_json?.fator || 50) / 100;
          const vc = parseFloat(x.valor_unit) || 0;
          await client.query(`
            INSERT INTO perdas (codigo_produto, data_perda, quantidade, motivo, tipo_motivo,
              funcionario_responsavel, usuario_lancamento, observacao)
            VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
          `, [
            x.cod_produto||x.nome_produto,
            qtd, tipo==='vencimento'?'Produto vencido':tipo==='descarte'?'Descarte':'Perda operacional',
            tipo, resp||null, req.usuario.id, obs||null
          ]);
        }
      } else {
        // Sem estoque — só desativa
        await client.query(`UPDATE vld_estoque SET ativo=false, atualizado_em=NOW() WHERE id=$1`, [req.params.id]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // FATURAMENTO HISTÓRICO (vld_faturamento)
  // ══════════════════════════════════════════════════════════════════════

  // GET /faturamento
  r.get('/faturamento', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM vld_faturamento ORDER BY mes_ref DESC`);
      const data = {};
      rows.forEach(r => {
        data[r.mes_ref] = {
          real:    r.real    ? parseFloat(r.real)    : null,
          previsto:r.previsto? parseFloat(r.previsto): null,
          manual:  r.manual  ? parseFloat(r.manual)  : null,
        };
      });
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // POST /faturamento  { mes_ref, real?, previsto? }
  r.post('/faturamento', async (req, res) => {
    const { mes_ref, real, previsto } = req.body;
    if (!mes_ref) return res.status(400).json({ ok: false, erro: 'mes_ref obrigatório' });
    try {
      await pool.query(`
        INSERT INTO vld_faturamento (mes_ref, real, previsto, manual, atualizado_em)
        VALUES ($1, $2, $3, $2, NOW())
        ON CONFLICT (mes_ref) DO UPDATE SET
          real      = COALESCE($2, vld_faturamento.real),
          previsto  = COALESCE($3, vld_faturamento.previsto),
          manual    = COALESCE($2, vld_faturamento.manual),
          atualizado_em = NOW()
      `, [mes_ref, real||null, previsto||null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // DELETE /faturamento/:mes_ref
  r.delete('/faturamento/:mes', async (req, res) => {
    try {
      await pool.query(`DELETE FROM vld_faturamento WHERE mes_ref = $1`, [req.params.mes]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // RETIRADAS DE FUNCIONÁRIAS (vld_retiradas)
  // ══════════════════════════════════════════════════════════════════════

  // GET /retiradas?mes=MM/YYYY
  r.get('/retiradas', async (req, res) => {
    try {
      const { mes } = req.query;
      let where = '';
      const params = [];
      if (mes) {
        // MM/YYYY → filtra pelo mês/ano
        const [mm, yyyy] = mes.split('/');
        where = `WHERE EXTRACT(MONTH FROM data)=$1 AND EXTRACT(YEAR FROM data)=$2`;
        params.push(parseInt(mm), parseInt(yyyy));
      }
      const { rows } = await pool.query(
        `SELECT * FROM vld_retiradas ${where} ORDER BY data DESC, criado_em DESC`, params
      );
      const data = rows.map(r => ({
        id:          r.id,
        func_id:     r.func_id,
        func_nome:   r.func_nome,
        data:        r.data.toISOString().slice(0,10),
        produto:     r.produto,
        qtd:         parseFloat(r.qtd),
        un:          r.unidade,
        pc:          parseFloat(r.preco_custo)||0,
        pv:          r.preco_venda ? parseFloat(r.preco_venda) : null,
        totalCusto:  parseFloat(r.total_custo)||0,
        totalVenda:  r.total_venda ? parseFloat(r.total_venda) : null,
        obs:         r.observacao,
      }));
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // POST /retiradas
  r.post('/retiradas', async (req, res) => {
    const { id, func_id, func_nome, data, produto, qtd, un, pc, pv, totalCusto, totalVenda, obs } = req.body;
    if (!func_nome || !data || !produto || !qtd || !pc)
      return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: func_nome, data, produto, qtd, pc' });
    try {
      await pool.query(`
        INSERT INTO vld_retiradas
          (id, func_id, func_nome, data, produto, qtd, unidade,
           preco_custo, preco_venda, total_custo, total_venda, observacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [id||require('crypto').randomUUID(), func_id||null, func_nome, data, produto,
          qtd, un||'KG', pc, pv||null, totalCusto||0, totalVenda||null, obs||null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // DELETE /retiradas/:id
  r.delete('/retiradas/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM vld_retiradas WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // ROTAS EXISTENTES DO MOBILE (mantidas intactas)
  // ══════════════════════════════════════════════════════════════════════

  r.get('/estoque', async (req, res) => {
    try {
      const { status } = req.query;
      const { rows } = await pool.query(`
        SELECT l.id, l.codigo_produto, pm.descricao_produto AS nome,
          pm.descricao_reduzida AS nome_curto, pm.categoria, pm.unidade,
          l.lote, l.data_validade, l.quantidade_atual,
          l.local_armazenamento AS local, l.custo_unitario, l.observacao, l.criado_em
        FROM lotes_estoque l
        JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
        WHERE l.ativo = true AND l.quantidade_atual > 0
          AND COALESCE(pm.controla_validade, true) = true
        ORDER BY l.data_validade ASC NULLS LAST, pm.descricao_produto ASC
      `);
      const result = rows
        .map(row => ({
          ...row,
          status:           calcStatus(row.data_validade),
          dias:             calcDias(row.data_validade),
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

  r.get('/alertas', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT l.id, l.codigo_produto, pm.descricao_produto AS nome, pm.unidade,
          l.lote, l.data_validade, l.quantidade_atual,
          l.local_armazenamento AS local, l.custo_unitario
        FROM lotes_estoque l
        JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
        WHERE l.ativo = true AND l.quantidade_atual > 0
          AND COALESCE(pm.controla_validade, true) = true
          AND (l.data_validade IS NULL OR l.data_validade <= CURRENT_DATE + INTERVAL '15 days')
        ORDER BY l.data_validade ASC NULLS FIRST
      `);
      res.json({ ok: true, data: rows.map(row => ({
        ...row,
        status: calcStatus(row.data_validade),
        dias:   calcDias(row.data_validade),
        quantidade_atual: parseFloat(row.quantidade_atual) || 0,
        custo_unitario:   parseFloat(row.custo_unitario)   || 0,
      }))});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/kpis', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE data_validade < CURRENT_DATE)                                                    AS vencidos,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days')         AS criticos,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE + INTERVAL '8 days'  AND CURRENT_DATE + INTERVAL '15 days') AS urgentes,
          COUNT(*) FILTER (WHERE data_validade BETWEEN CURRENT_DATE + INTERVAL '16 days' AND CURRENT_DATE + INTERVAL '30 days') AS atencao,
          COUNT(*) FILTER (WHERE data_validade > CURRENT_DATE + INTERVAL '30 days')                               AS ok,
          COUNT(*) FILTER (WHERE data_validade IS NULL)                                                           AS sem_data,
          COUNT(*)                                                                                                 AS total
        FROM lotes_estoque l
        JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
        WHERE l.ativo = true AND l.quantidade_atual > 0
          AND COALESCE(pm.controla_validade, true) = true
      `);
      const { rows: perdas } = await pool.query(`
        SELECT COUNT(*) AS qtd_perdas, COALESCE(SUM(valor_estimado),0) AS valor_perdas
        FROM perdas
        WHERE DATE_TRUNC('month', data_perda) = DATE_TRUNC('month', NOW())
      `);
      res.json({ ok: true, data: {
        ...rows[0],
        qtd_perdas_mes:   parseInt(perdas[0].qtd_perdas),
        valor_perdas_mes: parseFloat(perdas[0].valor_perdas),
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/lote', async (req, res) => {
    const { codigo_produto, lote, data_validade, quantidade, custo_unitario, local_armazenamento, observacao } = req.body;
    if (!codigo_produto || !quantidade) return res.status(400).json({ ok: false, erro: 'codigo_produto e quantidade obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO lotes_estoque
          (codigo_produto, lote, data_validade, quantidade, quantidade_atual,
           custo_unitario, local_armazenamento, usuario_lancamento, observacao)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *
      `, [codigo_produto, lote||null, data_validade||null, quantidade,
          custo_unitario||null, local_armazenamento||null, req.usuario.id, observacao||null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/baixa/:loteId', async (req, res) => {
    const { loteId } = req.params;
    const { quantidade, tipo, funcionario_responsavel, observacao } = req.body;
    if (!quantidade || quantidade <= 0) return res.status(400).json({ ok: false, erro: 'Quantidade inválida' });
    if (!tipo) return res.status(400).json({ ok: false, erro: 'Tipo obrigatório' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lr } = await client.query(
        `SELECT * FROM lotes_estoque WHERE id=$1 AND ativo=true FOR UPDATE`, [loteId]
      );
      if (!lr.length) throw new Error('Lote não encontrado');
      const lote = lr[0];
      if (quantidade > lote.quantidade_atual) throw new Error(`Quantidade excede estoque (${lote.quantidade_atual})`);
      const nova = parseFloat(lote.quantidade_atual) - parseFloat(quantidade);
      if (nova <= 0) {
        await client.query(`UPDATE lotes_estoque SET quantidade_atual=0, ativo=false, atualizado_em=NOW() WHERE id=$1`, [loteId]);
      } else {
        await client.query(`UPDATE lotes_estoque SET quantidade_atual=$1, atualizado_em=NOW() WHERE id=$2`, [nova, loteId]);
      }
      let perdaId = null;
      if (['perda','descarte','vencimento'].includes(tipo)) {
        const motivo = tipo==='vencimento'?'Produto vencido':tipo==='descarte'?'Descarte':'Perda operacional';
        const { rows: pr } = await client.query(`
          INSERT INTO perdas
            (codigo_produto, lote_id, data_perda, quantidade, motivo, tipo_motivo,
             funcionario_responsavel, usuario_lancamento, observacao)
          VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8) RETURNING id
        `, [lote.codigo_produto, loteId, quantidade, motivo, tipo,
            funcionario_responsavel||null, req.usuario.id, observacao||null]);
        perdaId = pr[0].id;
      }
      await client.query('COMMIT');
      res.json({ ok: true, novaQuantidade: nova, loteDesativado: nova <= 0, perdaId });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  r.get('/perdas', async (req, res) => {
    try {
      const { mes } = req.query;
      let where = '', params = [];
      if (mes) { where = `WHERE DATE_TRUNC('month', p.data_perda) = $1::date`; params.push(mes+'-01'); }
      const { rows } = await pool.query(`
        SELECT p.*,
          COALESCE(pm.descricao_produto, p.codigo_produto) AS nome_produto,
          pm.categoria, pm.unidade
        FROM perdas p
        LEFT JOIN produtos_mestre pm ON pm.codigo_produto = p.codigo_produto
        ${where}
        ORDER BY p.data_perda DESC, p.id DESC LIMIT 200
      `, params);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/funcionarios', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT id, nome FROM usuarios WHERE ativo = true ORDER BY nome ASC`);
      res.json({ ok: true, data: rows });
    } catch (e) { res.json({ ok: true, data: [] }); }
  });

  r.get('/produtos-search', async (req, res) => {
    try {
      const { q = '' } = req.query;
      const { rows } = await pool.query(`
        SELECT codigo_produto, descricao_produto, descricao_reduzida, unidade, preco_custo
        FROM produtos_mestre
        WHERE ativo = true AND COALESCE(controla_validade, true) = true
          AND (descricao_produto ILIKE $1 OR codigo_produto ILIKE $1)
        ORDER BY descricao_produto ASC LIMIT 20
      `, [`%${q}%`]);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/sincronizar-lote', async (req, res) => {
    const { codigo_produto, nome_produto, data_validade, quantidade_atual, custo_unitario, local_armazenamento, unidade } = req.body;
    if (!codigo_produto) return res.status(400).json({ ok: false, erro: 'codigo_produto obrigatório' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO produtos_mestre (codigo_produto, descricao_produto, unidade, controla_validade, ativo)
        VALUES ($1,$2,$3,true,true)
        ON CONFLICT (codigo_produto) DO UPDATE SET
          descricao_produto = COALESCE(EXCLUDED.descricao_produto, produtos_mestre.descricao_produto),
          controla_validade = true
      `, [codigo_produto, nome_produto||codigo_produto, unidade||'KG']);
      const { rows: ex } = await client.query(`
        SELECT id FROM lotes_estoque
        WHERE codigo_produto=$1 AND ativo=true
          AND ((data_validade=$2::date) OR (data_validade IS NULL AND $2 IS NULL))
        LIMIT 1
      `, [codigo_produto, data_validade||null]);
      if (ex.length) {
        await client.query(`
          UPDATE lotes_estoque SET quantidade_atual=$1,
            custo_unitario=COALESCE($2,custo_unitario),
            local_armazenamento=COALESCE($3,local_armazenamento),
            atualizado_em=NOW() WHERE id=$4
        `, [quantidade_atual||0, custo_unitario||null, local_armazenamento||null, ex[0].id]);
      } else {
        await client.query(`
          INSERT INTO lotes_estoque
            (codigo_produto, data_validade, quantidade, quantidade_atual,
             custo_unitario, local_armazenamento, usuario_lancamento)
          VALUES ($1,$2,$3,$3,$4,$5,$6)
        `, [codigo_produto, data_validade||null, quantidade_atual||0,
            custo_unitario||null, local_armazenamento||null, req.usuario.id]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  return r;
};
