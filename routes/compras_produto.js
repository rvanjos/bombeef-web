// routes/compras_produto.js — Sprint 4.2 — Central de Decisão de Compra
'use strict';
const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const autenticar = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

module.exports = function(pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── AUTO-MIGRATE ──────────────────────────────────────────────────────────
  ;(async () => {
    const c = await pool.connect();
    try {
      await c.query(`
        CREATE TABLE IF NOT EXISTS compras_importacoes (
          id                 SERIAL PRIMARY KEY,
          nome_arquivo       TEXT NOT NULL,
          periodo_ini        DATE,
          periodo_fim        DATE,
          total_linhas       INTEGER DEFAULT 0,
          total_ignorados    INTEGER DEFAULT 0,
          total_sem_vinculo  INTEGER DEFAULT 0,
          total_valor        NUMERIC(14,2) DEFAULT 0,
          fornecedores_json  JSONB DEFAULT '[]',
          usuario_id         INTEGER,
          criado_em          TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await c.query(`
        CREATE TABLE IF NOT EXISTS compras_produto (
          id                 SERIAL PRIMARY KEY,
          importacao_id      INTEGER REFERENCES compras_importacoes(id),
          produto_codigo     TEXT NOT NULL,
          produto_id         INTEGER,
          produto_nome       TEXT,
          grupo              TEXT,
          subgrupo           TEXT,
          fornecedor_nome    TEXT,
          fornecedor_cnpj    TEXT,
          fornecedor_codigo  TEXT,
          numero_nfe         TEXT,
          serie_nfe          TEXT,
          cod_item_nfe       TEXT,
          cfop               TEXT,
          id_entrada_pdv     INTEGER,
          data_emissao       DATE,
          data_entrada       DATE NOT NULL,
          quantidade         NUMERIC(12,4) NOT NULL,
          unidade            TEXT,
          valor_unitario     NUMERIC(10,4) NOT NULL,
          valor_total        NUMERIC(14,2),
          valor_total_liquido NUMERIC(14,2),
          icmsst             NUMERIC(10,2),
          origem             TEXT DEFAULT 'pdv_xlsx',
          arquivo_importado  TEXT,
          criado_em          TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Índices
      await c.query(`CREATE INDEX IF NOT EXISTS idx_cp_codigo  ON compras_produto(produto_codigo)`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_cp_entrada ON compras_produto(data_entrada)`);
      await c.query(`CREATE INDEX IF NOT EXISTS idx_cp_impid   ON compras_produto(importacao_id)`);
      await c.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_dedup
        ON compras_produto(numero_nfe, serie_nfe, fornecedor_cnpj, produto_codigo, cod_item_nfe)
        WHERE numero_nfe IS NOT NULL AND serie_nfe IS NOT NULL AND fornecedor_cnpj IS NOT NULL AND cod_item_nfe IS NOT NULL
      `);

      // Novos campos em produtos (não-destrutivos)
      for (const col of [
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ultimo_custo        NUMERIC(10,4)',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_medio_90d     NUMERIC(10,4)',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_medio_total   NUMERIC(10,4)',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_medio_3ped    NUMERIC(10,4)',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ultimo_fornecedor   TEXT',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ultima_entrada_em   DATE',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS variacao_custo_pct  NUMERIC(6,2)',
        'ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tendencia_custo     TEXT',
      ]) { await c.query(col).catch(() => {}); }

    } finally { c.release(); }
  })().catch(e => console.error('[compras] migrate error:', e.message));

  // ── HELPERS ───────────────────────────────────────────────────────────────
  // Arredondamento X4,90 ou X9,90
  function arredondarPreco(base) {
    const dez = Math.floor(base / 10) * 10;
    const cands = [dez + 4.90, dez + 9.90, dez + 14.90, dez + 19.90];
    const ok = cands.filter(c => c >= base - 0.001);
    return ok.length ? Math.round(ok[0] * 100) / 100 : cands[cands.length - 1];
  }

  // Calcular tendência (regressão linear das últimas 5 compras)
  function calcTendencia(valores) {
    // valores = array do mais antigo ao mais recente
    const n = valores.length;
    if (n < 3) return 'sem_dados';
    const xm = (n - 1) / 2;
    const ym = valores.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    valores.forEach((v, i) => { const dx = i - xm; num += dx * (v - ym); den += dx * dx; });
    if (den === 0) return 'estavel';
    const slope = num / den;
    const pct = Math.abs(slope) / (ym || 1);
    if (pct > 0.005) return slope > 0 ? 'alta' : 'baixa';
    return 'estavel';
  }

  // Recalcular campos de custo em produtos após importação
  async function recalcularCustos(client, codigosAfetados) {
    for (const codigo of codigosAfetados) {
      const [hist, ped3, cmp90, cmpTot] = await Promise.all([
        // últimas 5 compras para tendência
        client.query(`SELECT valor_unitario, data_entrada FROM compras_produto
          WHERE produto_codigo=$1 ORDER BY data_entrada DESC, id DESC LIMIT 5`, [codigo]),
        // CMP 3 pedidos
        client.query(`SELECT ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),4) AS v
          FROM compras_produto WHERE produto_codigo=$1
          AND importacao_id IN (
            SELECT DISTINCT importacao_id FROM compras_produto WHERE produto_codigo=$1
            ORDER BY MIN(data_entrada) DESC LIMIT 3
          )`, [codigo]),
        // CMP 90d
        client.query(`SELECT ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),4) AS v
          FROM compras_produto WHERE produto_codigo=$1 AND data_entrada >= CURRENT_DATE-90`, [codigo]),
        // CMP total
        client.query(`SELECT ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),4) AS v
          FROM compras_produto WHERE produto_codigo=$1`, [codigo]),
      ]);

      if (!hist.rows.length) continue;
      const vals = hist.rows.map(r => parseFloat(r.valor_unitario));
      const ultimo = vals[0]; // mais recente (DESC)
      const tendencia = calcTendencia([...vals].reverse());

      // penúltimo custo para variação
      const penultimo = vals.length > 1 ? vals[1] : null;
      const variacaoPct = penultimo ? ((ultimo - penultimo) / penultimo * 100) : null;

      // fornecedor e data mais recentes
      const rec = await client.query(`SELECT fornecedor_nome, data_entrada FROM compras_produto
        WHERE produto_codigo=$1 ORDER BY data_entrada DESC, id DESC LIMIT 1`, [codigo]);

      await client.query(`
        UPDATE produtos SET
          ultimo_custo       = $2,
          custo_medio_3ped   = $3,
          custo_medio_90d    = $4,
          custo_medio_total  = $5,
          variacao_custo_pct = $6,
          tendencia_custo    = $7,
          ultimo_fornecedor  = $8,
          ultima_entrada_em  = $9
        WHERE codigo = $1
      `, [
        codigo,
        ultimo,
        ped3.rows[0]?.v || null,
        cmp90.rows[0]?.v || null,
        cmpTot.rows[0]?.v || null,
        variacaoPct ? parseFloat(variacaoPct.toFixed(2)) : null,
        tendencia,
        rec.rows[0]?.fornecedor_nome || null,
        rec.rows[0]?.data_entrada || null,
      ]);
    }
  }

  // ── POST /importar ─────────────────────────────────────────────────────────
  r.post('/importar', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Nenhum arquivo enviado' });
    const userId = req.user?.id;

    let wb, rows = [];
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch (e) {
      return res.status(400).json({ ok: false, erro: 'Arquivo inválido: ' + e.message });
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Detectar linha de cabeçalho — planilha PDV tem 2 linhas de header (mescladas)
    // Linha 1: cabeçalhos de grupos (Valor Total, Total Liquido, etc)
    // Linha 2: sub-cabeçalhos com nomes de colunas
    let hdrRow = null, hdrRow1 = null, hdrIdx = -1;
    for (let i = 0; i < Math.min(raw.length, 5); i++) {
      const r2 = raw[i];
      if (r2 && r2.some && r2.some(v => v && typeof v === 'string' &&
          (v.toLowerCase().includes('produto') || v.toLowerCase().includes('cód')))) {
        hdrRow = r2;
        hdrIdx = i;
        // Linha 1 é sempre a anterior (para colunas mescladas sem valor na linha 2)
        hdrRow1 = i > 0 ? raw[i-1] : null;
        break;
      }
    }
    if (!hdrRow) return res.status(400).json({ ok: false, erro: 'Cabeçalho não encontrado' });

    // Combinar: onde hdrRow tem null, usar hdrRow1 (colunas mescladas)
    const hdrCombined = hdrRow.map((v, i) => v || (hdrRow1 && hdrRow1[i]) || null);

    // Mapeamento por nome de coluna
    const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
    const ci = (nomes) => {
      for (const nm of nomes) {
        // 1ª tentativa: match exato
        const exact = hdrCombined.findIndex(h => h && typeof h === 'string' && norm(h) === norm(nm));
        if (exact >= 0) return exact;
      }
      for (const nm of nomes) {
        // 2ª tentativa: contém
        const idx = hdrCombined.findIndex(h => h && typeof h === 'string' && norm(h).includes(norm(nm)));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const iID   = ci(['id. entrada','id entrada']);
    const iCodF = ci(['cód. fornecedor','cod. fornecedor','cod fornecedor']);
    const iCNPJ = ci(['cnpj']);
    const iDReg = ci(['data registro','data reg']);
    const iDSai = ci(['data saida','data saída','data sai']);
    const iSer  = ci(['serie','série']);
    const iNF   = ci(['notafiscal','nota fiscal','nf']);
    const iCProd= ci(['cód. produto','cod. produto','cod produto','código produto']);
    const iCPForn=ci(['cód. produto fornecedor','cod. produto fornecedor','cod produto forn']);
    const iProd = ci(['produto']);
    const iGrp  = ci(['grupo']);
    const iSub  = ci(['subgrupo']);
    const iCFOP = ci(['cfop']);
    // Preferir 2ª ocorrência de "quantidade" (Entrada) — fallback para a 1ª (Saída, ok quando Fator=1)
    const iQtd = (() => {
      let count = 0;
      for (let j = 0; j < hdrCombined.length; j++) {
        const h = hdrCombined[j];
        if (h && typeof h === 'string' && h.toLowerCase().trim() === 'quantidade') {
          count++;
          if (count === 2) return j; // Entrada
        }
      }
      return ci(['quantidade']); // fallback 1ª ocorrência
    })();
    const iUn   = ci(['unidade']);      // coluna Entrada Unidade
    const iVlUn = ci(['valor unitário','valor unitario']); // pega a 1ª — depois pega a 2ª
    const iVlTot= ci(['valor total']);
    const iLiq  = ci(['total liquido','total líquido']);
    const iICMS = ci(['icmsst']);

    // Para "Entrada Valor Unitário" precisamos do 2º match de "valor unitário"
    const iVlUnEnt = (() => {
      let count = 0;
      for (let j = 0; j < hdrCombined.length; j++) {
        const h = hdrCombined[j];
        if (h && typeof h === 'string' && h.toLowerCase().includes('valor unit')) {
          count++;
          if (count === 2) return j; // 2ª ocorrência = Entrada
        }
      }
      return iVlUn; // fallback
    })();

    // Parsear linhas de dados
    let fornecedorAtual = null, dataBlocoAtual = null;
    const itens = [];

    for (let i = hdrIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      if (!row || row.every(v => v === null || v === '')) continue;

      const col0 = String(row[0] || '').trim();

      // Linha de cabeçalho de grupo
      if (col0.toLowerCase().startsWith('fornecedor:')) {
        fornecedorAtual = col0.replace(/^fornecedor:\s*/i, '').trim();
        continue;
      }
      if (col0.toLowerCase().startsWith('data:')) {
        dataBlocoAtual = col0.replace(/^data:\s*/i, '').trim();
        continue;
      }
      // Linha de totais (AB tem formato "R$ X")
      if (row[iLiq] && typeof row[iLiq] === 'string' && row[iLiq].includes('R$')) continue;
      // Linha sem produto_codigo válido
      const codProd = iCProd >= 0 ? String(row[iCProd] || '').trim() : null;
      if (!codProd) continue;

      const vlUn = iVlUnEnt >= 0 && row[iVlUnEnt] != null
        ? parseFloat(row[iVlUnEnt]) : (iVlUn >= 0 ? parseFloat(row[iVlUn]) : 0);
      const qtd = iQtd >= 0 ? parseFloat(row[iQtd]) : 0;
      if (!qtd || !vlUn) continue;

      // Data entrada
      let dtEntry = null;
      const rawDt = iDReg >= 0 ? row[iDReg] : null;
      if (rawDt instanceof Date) dtEntry = rawDt.toISOString().slice(0, 10);
      else if (rawDt) {
        const s = String(rawDt).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) dtEntry = s.split('/').reverse().join('-');
        else dtEntry = s.slice(0, 10);
      } else if (dataBlocoAtual) {
        const s = dataBlocoAtual;
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) dtEntry = s.split('/').reverse().join('-');
      }
      if (!dtEntry) continue;

      let dtEmit = null;
      const rawDs = iDSai >= 0 ? row[iDSai] : null;
      if (rawDs instanceof Date) dtEmit = rawDs.toISOString().slice(0, 10);
      else if (rawDs) {
        const s = String(rawDs).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) dtEmit = s.split('/').reverse().join('-');
      }

      itens.push({
        produto_codigo:    codProd,
        produto_nome:      iProd >= 0 ? String(row[iProd] || '').trim() : null,
        grupo:             iGrp  >= 0 ? String(row[iGrp]  || '').trim() : null,
        subgrupo:          iSub  >= 0 ? String(row[iSub]  || '').trim() : null,
        fornecedor_nome:   fornecedorAtual,
        fornecedor_cnpj:   iCNPJ >= 0 ? String(row[iCNPJ] || '').trim() : null,
        fornecedor_codigo: iCodF >= 0 ? String(row[iCodF] || '').trim() : null,
        numero_nfe:        iNF   >= 0 ? String(row[iNF]   || '').trim() : null,
        serie_nfe:         iSer  >= 0 ? String(row[iSer]  || '').trim() : null,
        cod_item_nfe:      iCPForn>= 0? String(row[iCPForn]||'').trim() : null,
        cfop:              iCFOP >= 0 ? String(row[iCFOP] || '').trim() : null,
        id_entrada_pdv:    iID   >= 0 && row[iID] ? parseInt(row[iID]) : null,
        data_emissao:      dtEmit,
        data_entrada:      dtEntry,
        quantidade:        parseFloat(qtd.toFixed(4)),
        unidade:           iUn   >= 0 ? String(row[iUn]   || '').trim() : null,
        valor_unitario:    parseFloat(parseFloat(vlUn).toFixed(4)),
        valor_total:       iVlTot>= 0 && row[iVlTot] ? parseFloat(parseFloat(row[iVlTot]).toFixed(2)) : parseFloat((qtd * vlUn).toFixed(2)),
        valor_total_liquido: iLiq >= 0 && row[iLiq] && typeof row[iLiq] === 'number' ? parseFloat(parseFloat(row[iLiq]).toFixed(2)) : null,
        icmsst:            iICMS >= 0 && row[iICMS] ? parseFloat(parseFloat(row[iICMS]).toFixed(2)) : null,
        arquivo_importado: req.file.originalname,
      });
    }

    if (!itens.length) return res.status(400).json({ ok: false, erro: 'Nenhum item válido encontrado na planilha' });

    // Inserir no banco
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Criar importação
      const periodos = itens.map(it => it.data_entrada).sort();
      const fornSeen = [...new Set(itens.map(it => it.fornecedor_nome).filter(Boolean))];
      const totalValor = itens.reduce((s, it) => s + (it.valor_total || 0), 0);

      const impRes = await client.query(`
        INSERT INTO compras_importacoes
          (nome_arquivo, periodo_ini, periodo_fim, total_valor, fornecedores_json, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [req.file.originalname, periodos[0], periodos[periodos.length-1],
          parseFloat(totalValor.toFixed(2)), JSON.stringify(fornSeen), userId]);
      const impId = impRes.rows[0].id;

      // Verificar produtos existentes
      const codigos = [...new Set(itens.map(it => it.produto_codigo))];
      const prodRes = await client.query(
        `SELECT id, codigo FROM produtos WHERE codigo = ANY($1)`, [codigos]);
      const prodMap = {};
      prodRes.rows.forEach(p => { prodMap[p.codigo] = p.id; });

      let importados = 0, ignorados = 0, semVinculo = 0;
      const codigosAfetados = new Set();
      const semVinculoList = [];

      for (const it of itens) {
        const prodId = prodMap[it.produto_codigo] || null;
        if (!prodId) { semVinculo++; semVinculoList.push({ codigo: it.produto_codigo, nome: it.produto_nome }); }

        // Deduplicação P1
        if (it.numero_nfe && it.serie_nfe && it.fornecedor_cnpj && it.cod_item_nfe) {
          const dup = await client.query(`
            SELECT id FROM compras_produto
            WHERE numero_nfe=$1 AND serie_nfe=$2 AND fornecedor_cnpj=$3
              AND produto_codigo=$4 AND cod_item_nfe=$5 LIMIT 1
          `, [it.numero_nfe, it.serie_nfe, it.fornecedor_cnpj, it.produto_codigo, it.cod_item_nfe]);
          if (dup.rows.length) { ignorados++; continue; }
        } else {
          // Deduplicação P2
          const dup2 = await client.query(`
            SELECT id FROM compras_produto
            WHERE data_entrada=$1 AND produto_codigo=$2
              AND ROUND(valor_unitario::numeric,2)=ROUND($3::numeric,2)
              AND ROUND(quantidade::numeric,3)=ROUND($4::numeric,3) LIMIT 1
          `, [it.data_entrada, it.produto_codigo, it.valor_unitario, it.quantidade]);
          if (dup2.rows.length) { ignorados++; continue; }
        }

        await client.query(`
          INSERT INTO compras_produto
            (importacao_id,produto_codigo,produto_id,produto_nome,grupo,subgrupo,
             fornecedor_nome,fornecedor_cnpj,fornecedor_codigo,numero_nfe,serie_nfe,
             cod_item_nfe,cfop,id_entrada_pdv,data_emissao,data_entrada,
             quantidade,unidade,valor_unitario,valor_total,valor_total_liquido,
             icmsst,origem,arquivo_importado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        `, [impId,it.produto_codigo,prodId,it.produto_nome,it.grupo,it.subgrupo,
            it.fornecedor_nome,it.fornecedor_cnpj,it.fornecedor_codigo,it.numero_nfe,
            it.serie_nfe,it.cod_item_nfe,it.cfop,it.id_entrada_pdv,it.data_emissao,
            it.data_entrada,it.quantidade,it.unidade,it.valor_unitario,it.valor_total,
            it.valor_total_liquido,it.icmsst,'pdv_xlsx',it.arquivo_importado]);

        importados++;
        if (prodId) codigosAfetados.add(it.produto_codigo);
      }

      // Atualizar totais da importação
      await client.query(`
        UPDATE compras_importacoes
        SET total_linhas=$2, total_ignorados=$3, total_sem_vinculo=$4
        WHERE id=$1
      `, [impId, importados, ignorados, semVinculo]);

      await client.query('COMMIT');

      // Recalcular custos fora da transação
      if (codigosAfetados.size) {
        await recalcularCustos(client, [...codigosAfetados]).catch(e =>
          console.warn('[compras] recalc warn:', e.message));
      }

      res.json({ ok: true, importacao_id: impId, importados, ignorados,
        sem_vinculo: semVinculo, sem_vinculo_lista: semVinculoList.slice(0, 20) });

    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[compras/importar]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    } finally { client.release(); }
  });

  // ── GET /importacoes ───────────────────────────────────────────────────────
  r.get('/importacoes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, nome_arquivo, periodo_ini, periodo_fim,
               total_linhas, total_ignorados, total_sem_vinculo,
               total_valor, fornecedores_json, criado_em
        FROM compras_importacoes ORDER BY criado_em DESC LIMIT 50
      `);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /historico ─────────────────────────────────────────────────────────
  r.get('/historico', async (req, res) => {
    try {
      const { produto, fornecedor, grupo, ini, fim, limit = 200 } = req.query;
      const params = [], conds = [];
      if (produto)    { params.push(`%${produto}%`);    conds.push(`(cp.produto_codigo ILIKE $${params.length} OR cp.produto_nome ILIKE $${params.length})`); }
      if (fornecedor) { params.push(`%${fornecedor}%`); conds.push(`cp.fornecedor_nome ILIKE $${params.length}`); }
      if (grupo)      { params.push(grupo);              conds.push(`cp.grupo = $${params.length}`); }
      if (ini)        { params.push(ini);                conds.push(`cp.data_entrada >= $${params.length}`); }
      if (fim)        { params.push(fim);                conds.push(`cp.data_entrada <= $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      params.push(parseInt(limit));

      const { rows } = await pool.query(`
        SELECT cp.*,
          LAG(cp.valor_unitario) OVER (PARTITION BY cp.produto_codigo ORDER BY cp.data_entrada, cp.id) AS custo_anterior
        FROM compras_produto cp
        ${where}
        ORDER BY cp.data_entrada DESC, cp.id DESC
        LIMIT $${params.length}
      `, params);

      const data = rows.map(r => ({
        ...r,
        variacao_pct: r.custo_anterior
          ? parseFloat(((r.valor_unitario - r.custo_anterior) / r.custo_anterior * 100).toFixed(2))
          : null,
      }));

      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /analise/:codigo ───────────────────────────────────────────────────
  r.get('/analise/:codigo', async (req, res) => {
    try {
      const { codigo } = req.params;
      const JANELA = 30;

      const [prod, histCompras, precos90, evolucao] = await Promise.all([
        // Produto + campos calculados
        pool.query(`
          SELECT p.*, p.ultimo_custo, p.custo_medio_3ped, p.custo_medio_90d,
                 p.custo_medio_total, p.ultimo_fornecedor, p.ultima_entrada_em,
                 p.variacao_custo_pct, p.tendencia_custo,
                 -- Venda média diária (30d)
                 COALESCE(v.media_diaria, 0) AS media_diaria,
                 COALESCE(v.total_qtd_30d, 0) AS total_qtd_30d,
                 CASE WHEN COALESCE(v.media_diaria,0) > 0
                      THEN ROUND(GREATEST(p.estoque,0) / v.media_diaria, 1) ELSE NULL
                 END AS cobertura_dias
          FROM produtos p
          LEFT JOIN (
            SELECT codigo,
              ROUND(SUM(quantidade)::numeric / NULLIF(COUNT(DISTINCT data_venda),0), 3) AS media_diaria,
              SUM(quantidade) AS total_qtd_30d
            FROM vendas_produto
            WHERE data_venda >= CURRENT_DATE - ${JANELA}
            GROUP BY codigo
          ) v ON v.codigo = p.codigo
          WHERE p.codigo = $1
        `, [codigo]),
        // Menor e maior custo histórico + últimas 5 para tendência
        pool.query(`
          SELECT MIN(valor_unitario) AS menor_custo, MAX(valor_unitario) AS maior_custo,
                 COUNT(*) AS total_compras,
                 (SELECT json_agg(sub ORDER BY sub.data_entrada ASC) FROM (
                   SELECT valor_unitario, data_entrada, fornecedor_nome
                   FROM compras_produto WHERE produto_codigo=$1
                   ORDER BY data_entrada DESC, id DESC LIMIT 5
                 ) sub) AS ultimas5
          FROM compras_produto WHERE produto_codigo=$1
        `, [codigo]),
        // Preços praticados nas vendas (últimos 90d)
        pool.query(`
          SELECT
            ROUND(SUM(valor_total)/NULLIF(SUM(quantidade),0), 2)  AS preco_medio_90d,
            ROUND(MAX(valor_total/NULLIF(quantidade,0)), 2)        AS preco_max_90d,
            ROUND(MIN(valor_total/NULLIF(quantidade,0)), 2)        AS preco_min_90d,
            (SELECT ROUND((valor_total/NULLIF(quantidade,0))::numeric,2)
             FROM vendas_produto WHERE codigo=$1
             ORDER BY data_venda DESC LIMIT 1)                     AS ultima_venda_preco,
            (SELECT data_venda FROM vendas_produto WHERE codigo=$1
             ORDER BY data_venda DESC LIMIT 1)                     AS ultima_venda_data
          FROM vendas_produto
          WHERE codigo=$1 AND data_venda >= CURRENT_DATE-90
        `, [codigo]),
        // Evolução mensal de custo (12 meses)
        pool.query(`
          SELECT TO_CHAR(data_entrada,'YYYY-MM') AS mes,
                 ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),2) AS custo_medio
          FROM compras_produto WHERE produto_codigo=$1
            AND data_entrada >= CURRENT_DATE - INTERVAL '12 months'
          GROUP BY 1 ORDER BY 1
        `, [codigo]),
      ]);

      if (!prod.rows.length) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });

      const p  = prod.rows[0];
      const h  = histCompras.rows[0] || {};
      const pr = precos90.rows[0] || {};

      res.json({ ok: true, data: {
        // operacional
        codigo: p.codigo, descricao: p.descricao, unidade: p.unidade,
        categoria: p.categoria, curva_abc: p.curva_abc,
        estoque: parseFloat(p.estoque || 0), estoque_minimo: parseFloat(p.estoque_minimo || 0),
        media_diaria: parseFloat(p.media_diaria || 0),
        total_qtd_30d: parseFloat(p.total_qtd_30d || 0),
        cobertura_dias: p.cobertura_dias ? parseFloat(p.cobertura_dias) : null,
        // custo
        preco_custo_manual: parseFloat(p.preco_custo || 0),
        ultimo_custo:       p.ultimo_custo ? parseFloat(p.ultimo_custo) : null,
        custo_medio_3ped:   p.custo_medio_3ped ? parseFloat(p.custo_medio_3ped) : null,
        custo_medio_90d:    p.custo_medio_90d ? parseFloat(p.custo_medio_90d) : null,
        custo_medio_total:  p.custo_medio_total ? parseFloat(p.custo_medio_total) : null,
        menor_custo:        h.menor_custo ? parseFloat(h.menor_custo) : null,
        maior_custo:        h.maior_custo ? parseFloat(h.maior_custo) : null,
        total_compras:      parseInt(h.total_compras || 0),
        ultimas5_compras:   h.ultimas5 || [],
        ultimo_fornecedor:  p.ultimo_fornecedor,
        ultima_entrada_em:  p.ultima_entrada_em,
        variacao_custo_pct: p.variacao_custo_pct ? parseFloat(p.variacao_custo_pct) : null,
        tendencia_custo:    p.tendencia_custo || 'sem_dados',
        // preço venda
        preco_venda:        parseFloat(p.preco_venda || 0),
        preco_medio_90d:    pr.preco_medio_90d ? parseFloat(pr.preco_medio_90d) : null,
        preco_max_90d:      pr.preco_max_90d ? parseFloat(pr.preco_max_90d) : null,
        preco_min_90d:      pr.preco_min_90d ? parseFloat(pr.preco_min_90d) : null,
        ultima_venda_preco: pr.ultima_venda_preco ? parseFloat(pr.ultima_venda_preco) : null,
        ultima_venda_data:  pr.ultima_venda_data || null,
        // evolução
        evolucao_mensal:    evolucao.rows,
      }});
    } catch (e) { console.error('[compras/analise]', e.message); res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /giro ──────────────────────────────────────────────────────────────
  r.get('/giro', async (req, res) => {
    try {
      const { grupo, abc, status } = req.query;
      const params = [], conds = ['p.ativo = true'];
      if (grupo) { params.push(grupo); conds.push(`p.categoria = $${params.length}`); }
      if (abc)   { params.push(abc);   conds.push(`p.curva_abc = $${params.length}`); }

      const { rows } = await pool.query(`
        SELECT
          p.codigo, p.descricao, p.unidade, p.categoria, p.curva_abc,
          p.estoque, p.estoque_minimo,
          p.ultimo_custo, p.tendencia_custo, p.ultima_entrada_em, p.ultimo_fornecedor,
          COALESCE(v.media_diaria,0)   AS media_diaria,
          COALESCE(v.total_qtd_30d,0)  AS total_qtd_30d,
          CASE WHEN COALESCE(v.media_diaria,0)>0
               THEN ROUND(GREATEST(p.estoque,0)/v.media_diaria,1) ELSE NULL
          END AS cobertura_dias
        FROM produtos p
        LEFT JOIN (
          SELECT codigo,
            ROUND(SUM(quantidade)::numeric/NULLIF(COUNT(DISTINCT data_venda),0),3) AS media_diaria,
            SUM(quantidade) AS total_qtd_30d
          FROM vendas_produto WHERE data_venda >= CURRENT_DATE-30 GROUP BY codigo
        ) v ON v.codigo = p.codigo
        WHERE ${conds.join(' AND ')}
          AND (p.estoque_minimo > 0 OR p.ultimo_custo IS NOT NULL OR COALESCE(v.media_diaria,0)>0)
        ORDER BY
          CASE WHEN COALESCE(v.media_diaria,0)>0
               THEN GREATEST(p.estoque,0)/NULLIF(v.media_diaria,0) ELSE 999 END ASC NULLS LAST,
          p.descricao ASC
        LIMIT 300
      `, params);

      const data = rows.map(r => {
        const cob = r.cobertura_dias !== null ? parseFloat(r.cobertura_dias) : null;
        const diasSemCompra = r.ultima_entrada_em
          ? Math.floor((Date.now() - new Date(r.ultima_entrada_em).getTime()) / 86400000) : null;
        let urgencia = null;
        if (cob !== null) {
          if (cob < 5)  urgencia = 'urgente';
          else if (cob < 15) urgencia = 'atencao';
          else urgencia = 'saudavel';
        }
        // Alerta de ruptura: cobertura < tempo de entrega estimado (5d padrão)
        const alertaRuptura = cob !== null && cob < 5;
        // Alerta estoque parado: tem estoque mas sem venda há >30d
        const alertaParado = parseFloat(r.estoque||0) > 0
          && parseFloat(r.media_diaria||0) === 0
          && diasSemCompra !== null && diasSemCompra > 30;

        return {
          ...r, cob, urgencia, alertaRuptura, alertaParado, diasSemCompra,
          estoque: parseFloat(r.estoque||0),
          estoque_minimo: parseFloat(r.estoque_minimo||0),
          media_diaria: parseFloat(r.media_diaria||0),
        };
      }).filter(r => !status || r.urgencia === status);

      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /oportunidades ─────────────────────────────────────────────────────
  r.get('/oportunidades', async (req, res) => {
    try {
      // Retorna produtos com historico de compras + cobertura + classificação
      // A classificação de oportunidade é calculada no frontend ao informar cotação
      // Aqui: produtos ordenados por urgência operacional com dados de custo
      const { rows } = await pool.query(`
        SELECT
          p.codigo, p.descricao, p.unidade, p.categoria, p.curva_abc,
          p.estoque, p.estoque_minimo,
          p.ultimo_custo, p.custo_medio_90d, p.custo_medio_3ped,
          p.tendencia_custo, p.ultima_entrada_em, p.ultimo_fornecedor,
          p.variacao_custo_pct,
          (SELECT MIN(valor_unitario) FROM compras_produto WHERE produto_codigo=p.codigo) AS menor_custo,
          (SELECT MAX(valor_unitario) FROM compras_produto WHERE produto_codigo=p.codigo) AS maior_custo,
          COALESCE(v.media_diaria,0)  AS media_diaria,
          CASE WHEN COALESCE(v.media_diaria,0)>0
               THEN ROUND(GREATEST(p.estoque,0)/v.media_diaria,1) ELSE NULL
          END AS cobertura_dias
        FROM produtos p
        LEFT JOIN (
          SELECT codigo,
            ROUND(SUM(quantidade)::numeric/NULLIF(COUNT(DISTINCT data_venda),0),3) AS media_diaria
          FROM vendas_produto WHERE data_venda >= CURRENT_DATE-30 GROUP BY codigo
        ) v ON v.codigo=p.codigo
        WHERE p.ativo=true AND p.ultimo_custo IS NOT NULL
        ORDER BY
          CASE WHEN COALESCE(v.media_diaria,0)>0
               THEN GREATEST(p.estoque,0)/NULLIF(v.media_diaria,0) ELSE 999 END ASC NULLS LAST
        LIMIT 100
      `);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /evolucao/:codigo ──────────────────────────────────────────────────
  r.get('/evolucao/:codigo', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT TO_CHAR(data_entrada,'YYYY-MM') AS mes,
               ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),2) AS custo_medio,
               COUNT(*) AS n_compras
        FROM compras_produto WHERE produto_codigo=$1
          AND data_entrada >= CURRENT_DATE - INTERVAL '18 months'
        GROUP BY 1 ORDER BY 1
      `, [req.params.codigo]);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /fornecedores-ranking ──────────────────────────────────────────────
  r.get('/fornecedores-ranking', async (req, res) => {
    try {
      const { codigo } = req.query;
      const cond = codigo ? 'AND produto_codigo=$1' : '';
      const params = codigo ? [codigo] : [];
      const { rows } = await pool.query(`
        SELECT
          produto_codigo, produto_nome,
          fornecedor_nome, fornecedor_cnpj,
          COUNT(*) AS n_compras,
          ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),2) AS cmp_90d,
          ROUND(SUM(quantidade*valor_unitario)/NULLIF(SUM(quantidade),0),2) AS cmp_total,
          MIN(valor_unitario) AS menor_custo,
          MAX(valor_unitario) AS maior_custo,
          MAX(data_entrada)   AS ultima_compra
        FROM compras_produto
        WHERE data_entrada >= CURRENT_DATE-90 ${cond}
        GROUP BY produto_codigo, produto_nome, fornecedor_nome, fornecedor_cnpj
        ORDER BY produto_codigo, cmp_90d ASC
        LIMIT 200
      `, params);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
