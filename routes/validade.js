/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
/**
 * routes/validade.js — M4: Controle de Validades
 *
 * Rotas:
 *   GET    /api/validade              → lista itens
 *   POST   /api/validade              → cadastra item
 *   PUT    /api/validade/:id          → atualiza (conferência, ação, código)
 *   DELETE /api/validade/:id          → remove
 *   POST   /api/validade/import       → importa planilha XLSX
 *   POST   /api/validade/:id/vincular → vincula produto_id pelo código
 *   GET    /api/validade/kpis         → KPIs de validade
 */

const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const autenticar = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.UPLOAD_MAX_MB) || 15) * 1024 * 1024 },
});

const events = require('../lib/events');

module.exports = function (pool, app) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabela ────────────────────────────────────────────────────────────
  async function initTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS validade_items (
        id                  SERIAL PRIMARY KEY,
        produto_id          INTEGER,
        codigo              TEXT,
        descricao           TEXT NOT NULL,
        data_validade       DATE,
        lote                TEXT,
        acao_antes_vencer   TEXT,
        ultima_conferencia  DATE,
        responsavel         TEXT,
        qtd_unidades        INTEGER DEFAULT 0,
        peso_total_kg       NUMERIC(8,3),
        preco_custo         NUMERIC(10,4) DEFAULT 0,
        status              TEXT DEFAULT 'ok',
        dias_alerta         INTEGER DEFAULT 7,
        localizacao         TEXT,
        observacao          TEXT,
        criado_em           TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Garante colunas novas
    const needed = [
      ['preco_custo',   'NUMERIC(10,4) DEFAULT 0'],
      ['localizacao',   'TEXT'],
      ['qtd_unidades',  'INTEGER DEFAULT 0'],
      ['dias_alerta',   'INTEGER DEFAULT 7'],
      ['atualizado_em',  'TIMESTAMPTZ DEFAULT NOW()'],
      ['resolucao',      'TEXT'],
      ['dt_resolucao',   'DATE'],
      ['obs_resolucao',  'TEXT'],
      ['encerrado_por',  'TEXT'],
      ['status',         "TEXT DEFAULT 'ativo'"],
      ['desc_original',  'TEXT'],
      ['peso_total_kg',  'NUMERIC(8,3)'],
      ['data_recebimento','DATE'],
    ];
    for (const [col, def] of needed) {
      await pool.query(`ALTER TABLE validade_items ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
    }

    // Remove constraint de status que pode conflitar
    await pool.query(`ALTER TABLE validade_items DROP CONSTRAINT IF EXISTS validade_items_status_check`).catch(() => {});

    // Tabela de confirmações de validade
    await pool.query(`
      CREATE TABLE IF NOT EXISTS validade_confirmacoes (
        id              SERIAL PRIMARY KEY,
        item_id         INTEGER NOT NULL,
        usuario_id      INTEGER,
        usuario_nome    TEXT,
        acao_hash       TEXT,
        confirmado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_val_conf_item ON validade_confirmacoes(item_id)`).catch(() => {});

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_val_codigo    ON validade_items(codigo);
      CREATE INDEX IF NOT EXISTS idx_val_validade  ON validade_items(data_validade);
      CREATE INDEX IF NOT EXISTS idx_val_status    ON validade_items(status);
    `).catch(() => {});
  }
  initTable().catch(e => console.error('[validade] initTable:', e.message));

  // ── Helper: atualiza status baseado na data ────────────────────────────────
  async function atualizarStatus() {
    const res = await pool.query(`
      UPDATE validade_items SET
        status = CASE
          WHEN data_validade < CURRENT_DATE THEN 'vencido'
          WHEN data_validade <= CURRENT_DATE + (COALESCE(dias_alerta, 7) || ' days')::INTERVAL THEN 'alerta'
          ELSE 'ok'
        END,
        atualizado_em = NOW()
      WHERE status NOT IN ('descartado','vendido')
        AND data_validade IS NOT NULL
      RETURNING id, status
    `);
    const vendidosSobrescritos = res.rows.filter(r => r.status === 'vendido');
    if (vendidosSobrescritos.length) {
      console.error('[atualizarStatus] ⚠️ SOBRESCREVEU vendidos:', vendidosSobrescritos);
    }
    console.log(`[atualizarStatus] atualizou ${res.rowCount} itens. statuses: ${JSON.stringify(res.rows.map(r=>r.status).reduce((a,s)=>{a[s]=(a[s]||0)+1;return a},{}))}` );
  }

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  r.get('/kpis', async (req, res) => {
    try {
      await atualizarStatus();
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'ok')        AS ok,
          COUNT(*) FILTER (WHERE status = 'alerta')    AS alerta,
          COUNT(*) FILTER (WHERE status = 'vencido')   AS vencidos,
          COUNT(*) FILTER (WHERE status = 'descartado' AND data_validade >= DATE_TRUNC('month', NOW())) AS descartados_mes,
          COUNT(*) FILTER (WHERE codigo IS NULL OR codigo = '') AS sem_codigo
        FROM validade_items
        WHERE status NOT IN ('descartado','vendido') OR data_validade >= DATE_TRUNC('month', NOW())
      `);
      res.json({ ok: true, data: {
        ok:            parseInt(rows[0].ok),
        alerta:        parseInt(rows[0].alerta),
        vencidos:      parseInt(rows[0].vencidos),
        descartadosMes: parseInt(rows[0].descartados_mes),
        semCodigo:     parseInt(rows[0].sem_codigo),
      }});
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /dedup — remove duplicatas (temporário) ──────────────────────────────
  r.post('/dedup', async (req, res) => {
    try {
      // Encontra e remove duplicatas mantendo o registro mais antigo (menor id)
      const { rows: dups } = await pool.query(`
        SELECT codigo, descricao, data_validade, array_agg(id ORDER BY id ASC) AS ids
        FROM validade_items
        WHERE status NOT IN ('descartado','vendido')
        GROUP BY codigo, descricao, data_validade
        HAVING COUNT(*) > 1
      `);

      let removidos = 0;
      for (const dup of dups) {
        // Manter o primeiro (menor id), remover os demais
        const idsRemover = dup.ids.slice(1);
        if (idsRemover.length) {
          await pool.query(`DELETE FROM validade_items WHERE id = ANY($1::int[])`, [idsRemover]);
          removidos += idsRemover.length;
        }
      }
      res.json({ ok: true, duplicatas: dups.length, removidos });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /dedup-check — conta duplicatas ────────────────────────────────────
  r.get('/dedup-check', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT codigo, descricao, data_validade, COUNT(*) as qtd, array_agg(id ORDER BY id) as ids
        FROM validade_items
        WHERE status NOT IN ('descartado','vendido')
        GROUP BY codigo, descricao, data_validade
        HAVING COUNT(*) > 1
        ORDER BY qtd DESC LIMIT 20
      `);
      res.json({ ok: true, data: rows, total: rows.length });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    try {
      await atualizarStatus();
      const { status, busca, semCodigo } = req.query;
      const conds = [], params = [];

      if (semCodigo === 'true') conds.push(`(codigo IS NULL OR codigo = '')`);
      if (status && status !== 'todos') { params.push(status); conds.push(`status = $${params.length}`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(descricao ILIKE $${params.length} OR codigo ILIKE $${params.length} OR lote ILIKE $${params.length})`);
      }
      conds.push(`status NOT IN ('descartado','vendido')`);

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT vi.*, p.descricao AS prod_descricao, p.preco_custo
         FROM validade_items vi
         LEFT JOIN produtos p ON p.id = vi.produto_id
         ${where} ORDER BY vi.data_validade ASC NULLS LAST, vi.descricao ASC`,
        params
      );
      // Serializa datas como strings YYYY-MM-DD para o frontend
      const data = rows.map(r => ({
        ...r,
        data_recebimento: r.data_recebimento instanceof Date
          ? r.data_recebimento.toISOString().slice(0, 10)
          : r.data_recebimento ? String(r.data_recebimento).slice(0, 10) : null,
        data_validade: r.data_validade instanceof Date
          ? r.data_validade.toISOString().slice(0, 10)
          : r.data_validade ? String(r.data_validade).slice(0, 10) : null,
        ultima_conferencia: r.ultima_conferencia instanceof Date
          ? r.ultima_conferencia.toISOString().slice(0, 10)
          : r.ultima_conferencia ? String(r.ultima_conferencia).slice(0, 10) : null,
      }));
      res.json({ ok: true, data, total: data.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id/reativar ────────────────────────────────────────────────────────
  r.put('/:id/reativar', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rows } = await pool.query(`
        UPDATE validade_items
        SET status = 'ok',
            resolucao = NULL,
            obs_resolucao = NULL,
            dt_resolucao = NULL,
            encerrado_por = NULL,
            atualizado_em = NOW()
        WHERE id = $1
        RETURNING id, descricao, status
      `, [id]);
      if (!rows.length) return res.status(404).json({ ok: false, erro: 'Item não encontrado' });
      res.json({ ok: true, data: rows[0] });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /alertas-confirmacao — produtos ≤7 dias com ação não confirmada ──────
  r.get('/alertas-confirmacao', async (req, res) => {
    try {
      const usuario_id = req.user?.id || req.usuario?.id || 0;
      const { rows } = await pool.query(`
        SELECT
          v.id, v.descricao, v.lote, v.qtd_unidades,
          TO_CHAR(v.data_validade, 'YYYY-MM-DD') AS data_validade,
          v.localizacao AS local_estoque, v.acao_antes_vencer,
          v.peso_total_kg,
          (v.data_validade::date - CURRENT_DATE) AS dias_restantes,
          MD5(v.acao_antes_vencer) AS acao_hash
        FROM validade_items v
        WHERE v.status NOT IN ('descartado','vendido')
          AND v.acao_antes_vencer IS NOT NULL AND v.acao_antes_vencer != ''
          AND v.data_validade IS NOT NULL
          AND v.data_validade::date <= CURRENT_DATE + INTERVAL '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM validade_confirmacoes vc
            WHERE vc.item_id = v.id
              AND vc.usuario_id = $1
              AND vc.acao_hash = MD5(v.acao_antes_vencer)
          )
        ORDER BY v.data_validade ASC
      `, [usuario_id || 0]);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /confirmar-acoes — registra confirmação do usuário ──────────────────
  r.post('/confirmar-acoes', async (req, res) => {
    const { ids, usuario_nome } = req.body;
    const usuario_id = req.usuario?.id;
    if (!ids?.length) return res.json({ ok: true });
    try {
      // Busca hash atual de cada item
      const { rows: itens } = await pool.query(
        `SELECT id, MD5(acao_antes_vencer) AS acao_hash FROM validade_items WHERE id = ANY($1::int[])`,
        [ids]
      );
      for (const item of itens) {
        await pool.query(
          `INSERT INTO validade_confirmacoes (item_id, usuario_id, usuario_nome, acao_hash)
           VALUES ($1, $2, $3, $4)`,
          [item.id, usuario_id || null, usuario_nome || null, item.acao_hash]
        );
      }
      res.json({ ok: true, confirmados: itens.length });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /confirmacoes — histórico de confirmações (admin) ────────────────────
  r.get('/confirmacoes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT vc.*, vi.descricao, vi.data_validade, vi.acao_antes_vencer
        FROM validade_confirmacoes vc
        LEFT JOIN validade_items vi ON vi.id = vc.item_id
        ORDER BY vc.confirmado_em DESC
        LIMIT 200
      `);
      res.json({ ok: true, data: rows });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /alertas-dashboard ─────────────────────────────────────────────────
  // Retorna produtos com ação cadastrada E próximos do vencimento (até 7 dias)
  r.get('/alertas-dashboard', async (req, res) => {
    try {
      await atualizarStatus();
      const diasAlerta = parseInt(req.query.dias || '7');
      const { rows } = await pool.query(`
        SELECT
          id, codigo, descricao, lote,
          qtd_unidades,
          TO_CHAR(data_validade, 'YYYY-MM-DD') AS data_validade,
          status, localizacao AS local_estoque, acao_antes_vencer,
          peso_total_kg,
          (CURRENT_DATE - data_validade::date) AS dias_vencido,
          (data_validade::date - CURRENT_DATE) AS dias_restantes
        FROM validade_items
        WHERE status NOT IN ('descartado','vendido')
          AND acao_antes_vencer IS NOT NULL
          AND acao_antes_vencer != ''
          AND data_validade IS NOT NULL
          AND data_validade::date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
        ORDER BY data_validade ASC, descricao ASC
      `, [diasAlerta]);
      res.json({ ok: true, data: rows, total: rows.length });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST / ─────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const v = req.body;
    if (!v.descricao) return res.status(400).json({ ok: false, erro: 'descricao obrigatória' });
    try {
      // Tenta vincular produto pelo código
      let prodId = null;
      if (v.codigo) {
        const p = await pool.query(`SELECT id FROM produtos WHERE codigo = $1`, [v.codigo.trim()]);
        if (p.rows.length) prodId = p.rows[0].id;
      }
      const { rows } = await pool.query(`
        INSERT INTO validade_items
          (produto_id, codigo, descricao, data_validade, lote, acao_antes_vencer,
           ultima_conferencia, responsavel, qtd_unidades, dias_alerta, localizacao, observacao, peso_total_kg, data_recebimento)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING *
      `, [
        prodId, v.codigo?.trim() || null, v.descricao.trim(),
        v.dataValidade || null, v.lote || null, v.acaoAntesVencer || null,
        v.ultimaConferencia || null, v.responsavel || null,
        parseInt(v.qtdUnidades || 0), parseInt(v.diasAlerta || 7),
        v.localizacao || null, v.observacao || null,
        v.pesoTotalKg ? parseFloat(v.pesoTotalKg) : null,
        v.dataRecebimento || null,
      ]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /:id ───────────────────────────────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const v = req.body;
    try {
      // Se tem código, busca produto para obter nome oficial e produto_id
      let prodId = v.produtoId || null;
      let descFinal = v.descricao || null;
      let descOriginal = null;
      if (v.codigo) {
        const p = await pool.query(
          `SELECT id, descricao FROM produtos WHERE codigo = $1 AND ativo = true LIMIT 1`,
          [v.codigo.trim()]
        );
        if (p.rows.length) {
          prodId = p.rows[0].id;
          // Salva nome original antes de sobrescrever (só se ainda não foi salvo)
          const cur = await pool.query(`SELECT descricao, desc_original FROM validade_items WHERE id=$1`, [parseInt(req.params.id)]);
          if (cur.rows.length && !cur.rows[0].desc_original) {
            descOriginal = cur.rows[0].descricao; // nome atual vira original
          }
          descFinal = p.rows[0].descricao; // sempre usa nome do cadastro
        }
      }

      await pool.query(`
        UPDATE validade_items SET
          produto_id          = COALESCE($1, produto_id),
          codigo              = COALESCE($2, codigo),
          descricao           = COALESCE($3, descricao),
          desc_original       = COALESCE(desc_original, $15),
          data_validade       = COALESCE($4, data_validade),
          lote                = COALESCE($5, lote),
          acao_antes_vencer   = COALESCE($6, acao_antes_vencer),
          ultima_conferencia  = COALESCE($7, ultima_conferencia),
          responsavel         = COALESCE($8, responsavel),
          qtd_unidades        = COALESCE($9, qtd_unidades),
          peso_total_kg       = $10,
          dias_alerta         = COALESCE($11, dias_alerta),
          localizacao         = COALESCE($12, localizacao),
          observacao          = COALESCE($13, observacao),
          data_recebimento    = COALESCE($16, data_recebimento),
          atualizado_em       = NOW()
        WHERE id = $14
      `, [
        prodId, v.codigo?.trim() || null, descFinal,
        v.dataValidade || null, v.lote || null, v.acaoAntesVencer || null,
        v.ultimaConferencia || null, v.responsavel || null,
        v.qtdUnidades !== undefined ? parseInt(v.qtdUnidades) : null,
        v.pesoTotalKg ? parseFloat(v.pesoTotalKg) : null,
        v.diasAlerta !== undefined ? parseInt(v.diasAlerta) : null,
        v.localizacao || null, v.observacao || null,
        parseInt(req.params.id), descOriginal,
        v.dataRecebimento || null,
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /:id/vincular ─────────────────────────────────────────────────────
  r.post('/:id/vincular', async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ ok: false, erro: 'codigo obrigatório' });
    try {
      const { rows: prod } = await pool.query(
        `SELECT id, descricao, preco_custo, preco_venda FROM produtos WHERE codigo = $1`, [codigo.trim()]
      );
      if (!prod.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado com este código' });

      // Busca descrição atual para salvar como original (auditoria)
      const { rows: cur } = await pool.query(
        `SELECT descricao FROM validade_items WHERE id=$1`, [parseInt(req.params.id)]
      );
      const descAtual = cur[0]?.descricao || null;

      await pool.query(`
        UPDATE validade_items
        SET produto_id    = $1,
            codigo        = $2,
            descricao     = $3,
            desc_original = COALESCE(desc_original, $4),
            preco_custo   = $5,
            atualizado_em = NOW()
        WHERE id = $6
      `, [prod[0].id, codigo.trim(), prod[0].descricao,
          descAtual, parseFloat(prod[0].preco_custo||0), parseInt(req.params.id)]);

      res.json({ ok: true, produto: { ...prod[0], codigo: codigo.trim(), desc_original: descAtual } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /auto-vincular — vincula itens sem código por nome ────────────────
  // Tenta casar cada item sem código com um produto do catálogo pelo nome
  r.post('/auto-vincular', async (req, res) => {
    try {
      // Busca todos os itens sem código
      const { rows: semCod } = await pool.query(
        `SELECT id, descricao FROM validade_items
         WHERE (codigo IS NULL OR codigo = '') AND status NOT IN ('descartado','vendido')`
      );
      if (!semCod.length) return res.json({ ok: true, vinculados: 0, nao_encontrados: 0, detalhes: [] });

      // Busca todos os produtos ativos para casar
      const { rows: prods } = await pool.query(
        `SELECT id, codigo, descricao, preco_custo FROM produtos WHERE ativo = true`
      );

      // Função de normalização para comparação
      const norm = s => s.toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
        .replace(/[^A-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ').trim();

      // Índice de produtos pelo nome normalizado
      const prodIdx = {};
      for (const p of prods) {
        prodIdx[norm(p.descricao)] = p;
      }

      let vinculados = 0;
      const detalhes = [];

      for (const item of semCod) {
        const nItem = norm(item.descricao);
        // 1. Match exato
        let prod = prodIdx[nItem];
        // 2. Se não achou, tenta match parcial: produto cujo nome está contido no item ou vice-versa
        if (!prod) {
          for (const [nProd, p] of Object.entries(prodIdx)) {
            if (nItem.includes(nProd) || nProd.includes(nItem)) {
              // Prefere o match mais longo (mais específico)
              if (!prod || nProd.length > norm(prod.descricao).length) prod = p;
            }
          }
        }
        if (prod) {
          await pool.query(
            `UPDATE validade_items SET
               produto_id    = $1, codigo = $2,
               desc_original = COALESCE(desc_original, descricao),
               descricao     = $3, preco_custo = $4,
               atualizado_em = NOW()
             WHERE id = $5`,
            [prod.id, prod.codigo, prod.descricao, parseFloat(prod.preco_custo||0), item.id]
          );
          vinculados++;
          detalhes.push({ id: item.id, item: item.descricao, produto: prod.descricao, codigo: prod.codigo });
        } else {
          detalhes.push({ id: item.id, item: item.descricao, produto: null, codigo: null });
        }
      }

      res.json({ ok: true, vinculados, nao_encontrados: semCod.length - vinculados, detalhes });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /vincular-multiplos — vincula lista de ids com mesmo código ────────
  r.post('/vincular-multiplos', async (req, res) => {
    const { ids, codigo } = req.body;
    if (!ids?.length || !codigo) return res.status(400).json({ ok: false, erro: 'ids e codigo obrigatórios' });
    try {
      const { rows: prod } = await pool.query(
        `SELECT id, descricao, preco_custo FROM produtos WHERE codigo = $1 AND ativo = true LIMIT 1`,
        [codigo.trim()]
      );
      if (!prod.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
      const p = prod[0];
      let count = 0;
      for (const id of ids) {
        await pool.query(
          `UPDATE validade_items SET
             produto_id    = $1, codigo = $2,
             desc_original = COALESCE(desc_original, descricao),
             descricao     = $3, preco_custo = $4,
             atualizado_em = NOW()
           WHERE id = $5`,
          [p.id, codigo.trim(), p.descricao, parseFloat(p.preco_custo||0), parseInt(id)]
        );
        count++;
      }
      res.json({ ok: true, vinculados: count, produto: p.descricao });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /encerrar-multiplos — marca vários como vendido/descartado/vencido ──
  r.post('/encerrar-multiplos', async (req, res) => {
    const { ids, resolucao } = req.body;
    if (!ids?.length) return res.status(400).json({ ok: false, erro: 'Informe os IDs' });
    const idsNum = ids.map(Number).filter(n => !isNaN(n) && n > 0);
    if (!idsNum.length) return res.status(400).json({ ok: false, erro: 'IDs inválidos' });
    const motivo = resolucao || 'vendido';
    // Para resolucao='vencimento', o status vira 'descartado' para entrar no histórico
    const novoStatus = motivo === 'vencimento' ? 'descartado' : motivo;
    try {
      const result = await pool.query(`
        UPDATE validade_items
        SET status=$1, resolucao=$2, dt_resolucao=CURRENT_DATE, atualizado_em=NOW()
        WHERE id=ANY($3::int[])
        RETURNING id, status, resolucao, atualizado_em
      `, [novoStatus, motivo, idsNum]);
      console.log(`[validade] encerrar-multiplos: ids=${idsNum} motivo=${motivo} status=${novoStatus} rowCount=${result.rowCount}`);
      if (result.rowCount === 0)
        return res.status(404).json({ ok: false, erro: 'Nenhum item encontrado com esses IDs' });
      res.json({ ok: true, atualizados: result.rowCount, motivo });

      // ── F1-07: se foi descarte por vencimento → gera perdas automaticamente
      // try/catch isolado — falha não afeta o encerramento já confirmado
      if (novoStatus === 'descartado') {
        try {
          // Busca dados dos itens encerrados para gerar as perdas
          const { rows: itensDesc } = await pool.query(`
            SELECT vi.id, vi.descricao, vi.codigo, vi.qtd_unidades,
                   vi.produto_id, vi.lote,
                   p.preco_custo
            FROM validade_items vi
            LEFT JOIN produtos p ON p.id = vi.produto_id
            WHERE vi.id = ANY($1::int[])
          `, [idsNum]);

          for (const item of itensDesc) {
            const dtHoje = new Date().toISOString().slice(0, 10);
            const mes    = dtHoje.slice(5, 7) + '/' + dtHoje.slice(0, 4);
            const qtd    = Math.abs(parseInt(item.qtd_unidades || 0));
            const valor  = parseFloat(item.preco_custo || 0) * qtd;

            // Cria registro em perdas (sem duplicar se já existir)
            const jaExiste = await pool.query(
              `SELECT id FROM perdas WHERE validade_item_id = $1 LIMIT 1`,
              [item.id]
            );
            if (!jaExiste.rows.length) {
              await pool.query(`
                INSERT INTO perdas
                  (validade_item_id, produto_id, descricao, motivo,
                   qtd_unidades, valor_perda, dt_perda, mes, usuario_id)
                VALUES ($1,$2,$3,'vencimento',$4,$5,$6,$7,$8)
              `, [item.id, item.produto_id || null,
                  item.descricao || item.codigo || 'Item vencido',
                  qtd, valor, dtHoje, mes, req.user?.id || null]);
            }

            // Registra movimento de estoque
            if (item.produto_id && qtd > 0) {
              await pool.query(`
                INSERT INTO movimentos_estoque
                  (produto_id, produto_codigo, tipo_movimento, origem, origem_id,
                   quantidade, estoque_anterior, estoque_posterior, usuario_id, observacao)
                SELECT p.id, p.codigo, 'VALIDADE', 'validade', $1,
                       -$2::numeric,
                       p.estoque,
                       GREATEST(0, p.estoque - $2::numeric),
                       $3, $4
                FROM produtos p WHERE p.id = $5
              `, [item.id, qtd, req.user?.id || null,
                  'Vencimento: ' + (item.descricao || item.codigo), item.produto_id]);

              await pool.query(`
                UPDATE produtos
                SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW()
                WHERE id = $2
              `, [qtd, item.produto_id]);
            }
          }

          // Emite evento de atualização de estoque
          events.emit(app, 'VALIDADE_DESCARTADA', {
            ids:      idsNum,
            motivo,
            total:    itensDesc.length,
          });

        } catch (eMov) {
          console.warn('[validade] F1-07 movimento falhou (não crítico):', eMov.message);
        }
      }

    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /multiplos — exclui vários itens de uma vez ──────────────────────
  r.delete('/multiplos', async (req, res) => {
    const idsRaw = req.body?.ids;
    if (!idsRaw?.length) return res.status(400).json({ ok: false, erro: 'Informe os IDs' });
    const ids = idsRaw.map(Number).filter(n => !isNaN(n) && n > 0);
    if (!ids.length) return res.status(400).json({ ok: false, erro: 'IDs inválidos' });
    try {
      await pool.query(`UPDATE perdas SET validade_item_id=NULL WHERE validade_item_id=ANY($1::int[])`, [ids]);
      const r = await pool.query(`DELETE FROM validade_items WHERE id=ANY($1::int[])`, [ids]);
      res.json({ ok: true, removidos: r.rowCount });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /limpar-tudo — admin apaga todos os itens de validade ────────────
  r.delete('/limpar-tudo', async (req, res) => {
    if (req.user?.perfil !== 'admin')
      return res.status(403).json({ ok: false, erro: 'Acesso restrito ao administrador' });
    try {
      await pool.query(`UPDATE perdas SET validade_item_id=NULL WHERE validade_item_id IS NOT NULL`);
      const r = await pool.query(`DELETE FROM validade_items`);
      res.json({ ok: true, removidos: r.rowCount });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── DELETE /:id — encerra com motivo ──────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    const { resolucao, obs_resolucao, encerrado_por, dt_resolucao } = req.body || {};
    // Usa o resolucao como status se for vendido/descartado, senão descartado
    const novoStatus = ['vendido','descartado'].includes(resolucao) ? resolucao : 'descartado';
    try {
      await pool.query(
        `UPDATE validade_items SET
           status=$1, resolucao=$2, obs_resolucao=$3,
           encerrado_por=$4, dt_resolucao=COALESCE($5::date,CURRENT_DATE),
           atualizado_em=NOW()
         WHERE id=$6`,
        [novoStatus, resolucao||'outro', obs_resolucao||null, encerrado_por||null,
         dt_resolucao||null, parseInt(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /historico ─────────────────────────────────────────────────────────
  r.get('/historico', async (req, res) => {
    try {
      const { resolucao, de, ate, busca } = req.query;
      // Histórico = encerrados (descartado/vendido) + vencidos ainda ativos
      const conds = [`(status IN ('descartado','vendido') OR status = 'vencido')`], params = [];
      if (resolucao && resolucao !== 'todos') {
        if (resolucao === 'vencimento') {
          // Filtra por resolucao='vencimento' OU status='vencido' (não encerrado ainda)
          params.push('%'); // dummy para manter índice
          conds.push(`(resolucao='vencimento' OR status='vencido')`);
        } else {
          params.push(resolucao); conds.push(`resolucao=$${params.length}`);
        }
      }
      if (de)  { params.push(de);  conds.push(`COALESCE(dt_resolucao, data_validade)>=$${params.length}::date`); }
      if (ate) { params.push(ate); conds.push(`COALESCE(dt_resolucao, data_validade)<=$${params.length}::date`); }
      if (busca) {
        params.push(`%${busca}%`);
        conds.push(`(descricao ILIKE $${params.length} OR COALESCE(codigo,'') ILIKE $${params.length})`);
      }
      // Remove o dummy param se foi adicionado para vencimento
      const cleanParams = params.filter(p => p !== '%');
      const cleanConds  = conds.map(c => c.replace('$'+(params.indexOf('%')+1), "'vencimento'")).filter(c => !c.includes('$NaN'));
      // Monta query mais simples sem o dummy
      const conds2 = [`(status IN ('descartado','vendido') OR status = 'vencido')`], params2 = [];
      if (resolucao && resolucao !== 'todos') {
        if (resolucao === 'vencimento') {
          conds2.push(`(resolucao='vencimento' OR status='vencido')`);
        } else {
          params2.push(resolucao); conds2.push(`resolucao=$${params2.length}`);
        }
      }
      if (de)  { params2.push(de);  conds2.push(`COALESCE(dt_resolucao, data_validade)>=$${params2.length}::date`); }
      if (ate) { params2.push(ate); conds2.push(`COALESCE(dt_resolucao, data_validade)<=$${params2.length}::date`); }
      if (busca) {
        params2.push(`%${busca}%`);
        conds2.push(`(descricao ILIKE $${params2.length} OR COALESCE(codigo,'') ILIKE $${params2.length})`);
      }
      const { rows } = await pool.query(
        `SELECT * FROM validade_items WHERE ${conds2.join(' AND ')}
         ORDER BY COALESCE(dt_resolucao, data_validade) DESC NULLS LAST, atualizado_em DESC`, params2
      );
      const fmt = v => v instanceof Date ? v.toISOString().slice(0,10) : v ? String(v).slice(0,10) : null;
      const data = rows.map(r => ({
        ...r,
        data_validade: fmt(r.data_validade),
        dt_resolucao:  fmt(r.dt_resolucao),
        ultima_conferencia: fmt(r.ultima_conferencia),
      }));
      res.json({ ok: true, data, total: data.length });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── PUT /historico/:id — editar item do histórico ──────────────────────────
  r.put('/historico/:id', async (req, res) => {
    const { descricao, codigo, data_validade, dt_resolucao, resolucao, obs_resolucao, qtd_unidades, peso_total_kg, preco_custo, lote } = req.body;
    try {
      await pool.query(`
        UPDATE validade_items SET
          descricao       = COALESCE($1, descricao),
          codigo          = $2,
          data_validade   = COALESCE($3::date, data_validade),
          dt_resolucao    = COALESCE($4::date, dt_resolucao),
          resolucao       = COALESCE($5, resolucao),
          obs_resolucao   = $6,
          qtd_unidades    = COALESCE($7, qtd_unidades),
          peso_total_kg   = COALESCE($8, peso_total_kg),
          preco_custo     = COALESCE($9, preco_custo),
          lote            = $10,
          atualizado_em   = NOW()
        WHERE id = $11
      `, [descricao||null, codigo||null, data_validade||null, dt_resolucao||null,
          resolucao||null, obs_resolucao||null, qtd_unidades||null, peso_total_kg||null,
          preco_custo||null, lote||null, parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /import ───────────────────────────────────────────────────────────
  r.post('/import', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo não enviado' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });

      // Escolhe a aba: preferência para 'Pereciveis', 'Perecíveis', 'Validade', senão a primeira
      const abaPref = ['Pereciveis','Perecíveis','Perecivel','Perecível','Validade','Ativos'];
      let sheetName = wb.SheetNames[0];
      for (const pref of abaPref) {
        const found = wb.SheetNames.find(n => n.toLowerCase().includes(pref.toLowerCase()));
        if (found) { sheetName = found; break; }
      }
      const sheet = wb.Sheets[sheetName];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (rows.length < 2) return res.status(422).json({ ok: false, erro: 'Planilha vazia' });

      const header = rows[0].map(c => String(c).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\n/g,' ').trim());
      const col = (nomes) => {
        for (const n of nomes) {
          const i = header.findIndex(h => h.includes(n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')));
          if (i >= 0) return i;
        }
        return -1;
      };

      // Colunas — compatível com formato Bom Beef (DATA VALIDADE, Produto, CÓDIGO, etc.)
      const colVal     = col(['data validade','validade','vencimento','vence','exp']);
      const colDesc    = col(['produto','descrição','descricao','item','nome']);
      const colCod     = col(['código','codigo','cod','sku']);
      const colQtdPec  = col(['quantidade de peças','qtd peças','quantidade de pecas','peças (no estoque)','peças']);
      const colQtdKg   = col(['quantidade estoque (em kg)','quantidade\nestoque','em kg','kg']);
      const colLocal   = col(['local','localização','localizacao','posição']);
      const colAcao    = col(['ação antes','acao antes','ação','acao','action']);
      const colConf    = col(['última conferência','ultima conferencia','conferência','conferencia','ultima conf']);
      const colLote    = col(['lote','batch']);
      const colResp    = col(['responsável','responsavel','resp']);
      // Qtd: usa peças se tiver, senão kg
      const colQtd     = colQtdPec >= 0 ? colQtdPec : col(['qtd','quantidade','qty','unid']);

      if (colDesc < 0) {
        return res.status(422).json({ ok: false, erro: 'Coluna de descrição/produto não encontrada', cabecalho: header, aba: sheetName });
      }
      if (colVal < 0) {
        return res.status(422).json({ ok: false, erro: 'Coluna de data de validade não encontrada', cabecalho: header, aba: sheetName });
      }

      const client = await pool.connect();
      let inseridos = 0, erros = 0, duplicatas = 0;
      const detalheErros = [];

      try {
        await client.query('BEGIN');
        for (let i = 1; i < rows.length; i++) {
          const row  = rows[i];
          const desc = String(row[colDesc] ?? '').trim();
          if (!desc) continue;

          const cod   = colCod  >= 0 ? String(row[colCod]  ?? '').trim() || null : null;
          const qtdRaw = colQtd >= 0 ? row[colQtd] : 0;
          const qtdNum = typeof qtdRaw === 'number' ? qtdRaw
                       : parseFloat(String(qtdRaw||'0').replace(',','.'));
          const qtd = isNaN(qtdNum) ? 0 : Math.round(qtdNum);
          const resp  = colResp >= 0 ? String(row[colResp]  ?? '').trim() || null : null;
          const acao  = colAcao >= 0 ? String(row[colAcao]  ?? '').trim() || null : null;
          const lote  = colLote >= 0 ? String(row[colLote]  ?? '').trim() || null : null;
          const local = colLocal>= 0 ? String(row[colLocal] ?? '').trim() || null : null;

          const parseDate = (v) => {
            if (!v) return null;
            if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
            const s = String(v).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.split('/').reverse().join('-');
            if (/^\d{2}\/\d{4}$/.test(s)) {
              const [mm, yyyy] = s.split('/');
              return `${yyyy}-${mm}-${String(new Date(parseInt(yyyy), parseInt(mm), 0).getDate()).padStart(2,'0')}`;
            }
            // Excel serial date number
            if (/^\d{5}$/.test(s)) {
              const d = new Date((parseInt(s) - 25569) * 86400 * 1000);
              return d.toISOString().slice(0,10);
            }
            return null;
          };

          const dataVal  = colVal  >= 0 ? parseDate(row[colVal])  : null;
          const dataConf = colConf >= 0 ? parseDate(row[colConf]) : null;

          // Tenta vincular produto
          let prodId = null;
          if (cod) {
            const p = await client.query(`SELECT id FROM produtos WHERE codigo = $1`, [cod]);
            if (p.rows.length) prodId = p.rows[0].id;
          }

          // Verifica duplicata: mesmo produto (desc ou codigo) + mesma data de validade
          // Ignora itens vendidos/descartados — eles podem ser re-cadastrados
          const dupCheck = await client.query(`
            SELECT id FROM validade_items
            WHERE data_validade=$1::date
              AND (descricao=$2 OR ($3::text IS NOT NULL AND codigo=$3))
              AND status NOT IN ('vendido','descartado')
            LIMIT 1
          `, [dataVal, desc, cod||null]);
          if(dupCheck.rows.length){ duplicatas++; continue; }

          try {
            await client.query(`
              INSERT INTO validade_items
                (produto_id, codigo, descricao, data_validade, lote, acao_antes_vencer,
                 ultima_conferencia, responsavel, qtd_unidades, localizacao)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [prodId, cod, desc, dataVal, lote, acao, dataConf, resp, qtd, local]);
            inseridos++;
          } catch (e) {
            erros++;
            detalheErros.push({ linha: i + 1, descricao: desc, erro: e.message });
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK'); throw e;
      } finally { client.release(); }

      res.json({ ok: true, inseridos, erros, detalheErros });
    } catch (e) {
      res.status(500).json({ ok: false, erro: 'Erro ao processar planilha: ' + e.message });
    }
  });

  return r;
};
