/**
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Sistema de Gestão Interna Bom Beef Valinhos
 * Uso exclusivo. Reprodução, cópia ou redistribuição proibidas.
 * © 2024-2025 AR Boutique de Carnes LTDA
 */
/**
 * routes/config.js — M6: Configurações do Sistema
 *
 * Rotas:
 *   GET/POST/PUT/DELETE /api/config/funcionarios   → CRUD funcionários
 *   GET/POST/PUT        /api/config/metas          → CRUD metas mensais
 *   GET/POST/PUT/DELETE /api/config/categorias     → CRUD categorias DRE
 *   GET/PUT             /api/config/sistema        → configurações gerais
 */

const express    = require('express');
const autenticar = require('../middleware/auth');
const { requireNivel } = require('../middleware/auth');

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar());

  // ── Init tabelas ───────────────────────────────────────────────────────────
  async function initTable() {
    // Tabela de ações antes de vencer (gerenciada pelo admin)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS validade_acoes (
        id        SERIAL PRIMARY KEY,
        descricao TEXT NOT NULL,
        ativo     BOOLEAN DEFAULT true,
        ordem     INTEGER DEFAULT 99,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    // Seed inicial se vazia
    const cnt = await pool.query('SELECT COUNT(*) FROM validade_acoes').then(r=>parseInt(r.rows[0].count)).catch(()=>0);
    if(cnt === 0){
      await pool.query(`
        INSERT INTO validade_acoes (descricao, ordem) VALUES
        ('Promover com 30% de desconto', 1),
        ('Promover com 50% de desconto', 2),
        ('Montar kit anti-desperdício', 3),
        ('Doação para funcionários', 4),
        ('Verificar com fornecedor', 5),
        ('Retirar de circulação', 6),
        ('Descarte imediato', 7)
      `).catch(()=>{});
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS funcionarios (
        id                SERIAL PRIMARY KEY,
        nome              TEXT NOT NULL,
        cargo             TEXT,
        email             TEXT,
        telefone          TEXT,
        limite_retirada   NUMERIC(10,2) DEFAULT 0,
        usuario_id        INTEGER REFERENCES usuarios(id),
        ativo             BOOLEAN DEFAULT true,
        criado_em         TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metas (
        id                  SERIAL PRIMARY KEY,
        mes                 TEXT UNIQUE NOT NULL,
        faturamento_meta    NUMERIC(14,2) DEFAULT 0,
        faturamento_real    NUMERIC(14,2) DEFAULT 0,
        meta_perda_pct      NUMERIC(5,2) DEFAULT 2,
        meta_retiradas      NUMERIC(14,2) DEFAULT 0,
        observacao          TEXT,
        criado_em           TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categorias_dre (
        id              SERIAL PRIMARY KEY,
        grupo           TEXT NOT NULL,
        subgrupo        TEXT NOT NULL,
        label_exibicao  TEXT,
        ordem           INTEGER DEFAULT 0,
        ativo           BOOLEAN DEFAULT true
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_sistema (
        chave   TEXT PRIMARY KEY,
        valor   TEXT,
        descricao TEXT
      )
    `);

    // Sincroniza categorias DRE com o CATS real do classificador
    // Usa TRUNCATE + INSERT para garantir que o banco reflete o padrão atual
    // Sempre sincroniza o banco com o CATS canônico do DRE
    // Verifica se as categorias corretas já existem pela presença de 'VENDAS DE MERCADORIAS'
    const catsOk = await pool.query(`SELECT COUNT(*) FROM categorias_dre WHERE subgrupo='VENDAS DE MERCADORIAS'`).then(r=>parseInt(r.rows[0].count)).catch(()=>0);
    if (!catsOk) {
      await pool.query(`TRUNCATE categorias_dre RESTART IDENTITY`).catch(()=>{});
      await pool.query(`
        INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem) VALUES
        -- RECEITAS
        ('RECEITAS','VENDAS DE MERCADORIAS','VENDAS DE MERCADORIAS',1),
        ('RECEITAS','Juros de aplicacoes financeiras','Juros de aplicações financeiras',2),
        ('RECEITAS','Descontos financeiros obtidos','Descontos financeiros obtidos',3),
        ('RECEITAS','Delivery','Delivery',4),
        ('RECEITAS','Outros Créditos','Outros Créditos',5),
        ('RECEITAS','Transferência entre contas','Transferência entre contas',6),
        ('RECEITAS','Outros (não classificar)','Outros (não classificar)',7),
        -- CMV
        ('CMV','COMPRAS - REVENDA','COMPRAS - REVENDA',10),
        ('CMV','Bovino','Bovino',11),
        ('CMV','Suíno','Suíno',12),
        ('CMV','Cordeiro','Cordeiro',13),
        ('CMV','Aves','Aves',14),
        ('CMV','Outras Proteínas','Outras Proteínas',15),
        ('CMV','Carvão','Carvão',16),
        ('CMV','Empório (Diversos)','Empório (Diversos)',17),
        ('CMV','Bebidas','Bebidas',18),
        ('CMV','Acessórios','Acessórios',19),
        ('CMV','Embalagens','Embalagens',20),
        ('CMV','Acompanhamentos','Acompanhamentos',21),
        ('CMV','Gelo','Gelo',22),
        ('CMV','Sorvete','Sorvete',23),
        ('CMV','Pães','Pães',24),
        -- PESSOAL
        ('PESSOAL','Salarios e ordenados','Salários e ordenados',30),
        ('PESSOAL','FGTS','FGTS',31),
        ('PESSOAL','Vale transporte','Vale transporte',32),
        ('PESSOAL','Vale alimentação','Vale alimentação',33),
        ('PESSOAL','Provisão 13º Salario','Provisão 13º Salário',34),
        ('PESSOAL','Provisão Férias','Provisão Férias',35),
        ('PESSOAL','Provisão Fgts s/ 13º','Provisão FGTS s/ 13º',36),
        ('PESSOAL','Provisão Fgts s/ Férias','Provisão FGTS s/ Férias',37),
        ('PESSOAL','Sindicato','Sindicato',38),
        ('PESSOAL','INSS empresa','INSS empresa',39),
        -- VENDAS
        ('VENDAS_CAT','Fretes com vendas','Fretes com vendas',40),
        ('VENDAS_CAT','Royalties','Royalties',41),
        ('VENDAS_CAT','Embalagens para delivery','Embalagens para delivery',42),
        ('VENDAS_CAT','Marketing','Marketing',43),
        ('VENDAS_CAT','Publicidade','Publicidade',44),
        -- CONSUMO
        ('CONSUMO','Alugueis de imoveis','Aluguéis de imóveis',50),
        ('CONSUMO','Alugueis de Equipamentos','Aluguéis de Equipamentos',51),
        ('CONSUMO','Energia eletrica','Energia elétrica',52),
        ('CONSUMO','Agua e esgoto','Água e esgoto',53),
        ('CONSUMO','Telefone','Telefone',54),
        ('CONSUMO','Internet','Internet',55),
        ('CONSUMO','Gás','Gás',56),
        -- TERCEIROS
        ('TERCEIROS','Assistencia Contábil','Assistência Contábil',60),
        ('TERCEIROS','Serviços com Segurança','Serviços com Segurança',61),
        ('TERCEIROS','Serviços de Manutenção e Higiene','Serviços de Manutenção e Higiene',62),
        ('TERCEIROS','Serviços com Internet/Software','Serviços com Internet/Software',63),
        ('TERCEIROS','Serviços prestados por terceiros','Serviços prestados por terceiros',64),
        ('TERCEIROS','Serviços de Consultoria de Alimentos','Consultoria de Alimentos',65),
        ('TERCEIROS','Advocacia','Advocacia',66),
        ('TERCEIROS','RH / Recrutamento','RH / Recrutamento',67),
        -- MATERIAL
        ('MATERIAL','Material de Embalagens','Material de Embalagens',70),
        ('MATERIAL','Material de Higiene e Limpeza','Material de Higiene e Limpeza',71),
        ('MATERIAL','Material de Copa e cozinha','Material de Copa e cozinha',72),
        ('MATERIAL','Materiais diversos','Materiais diversos',73),
        ('MATERIAL','EPI / Uniformes','EPI / Uniformes',74),
        -- FINANCEIRAS
        ('FINANCEIRAS','Juros de mora','Juros de mora',80),
        ('FINANCEIRAS','Juros e comissoes bancarias','Juros e comissões bancárias',81),
        ('FINANCEIRAS','Multa de Mora','Multa de Mora',82),
        ('FINANCEIRAS','Tarifas Bancarias','Tarifas Bancárias',83),
        ('FINANCEIRAS','IOF S/ Imp. S/ Oper. Financeiras','IOF',84),
        ('FINANCEIRAS','Tarifa de Administração de Cartões','Tarifa de Adm. de Cartões',85),
        ('FINANCEIRAS','Empréstimo','Empréstimo',86),
        ('FINANCEIRAS','Antecipação de Recebíveis','Antecipação de Recebíveis',87),
        -- OUTRAS
        ('OUTRAS','Depreciação e Amortização','Depreciação e Amortização',90),
        ('OUTRAS','Seguro','Seguro',91),
        ('OUTRAS','Outras Despesas','Outras Despesas',92),
        -- IMPOSTOS
        ('IMPOSTOS','IPTU','IPTU',100),
        ('IMPOSTOS','TFE','TFE',101),
        ('IMPOSTOS','Simples Nacional','Simples Nacional',102),
        ('IMPOSTOS','ICMS Sobre Diferencial de Aliquota','ICMS Diferencial de Alíquota',103),
        ('IMPOSTOS','DARF','DARF',104),
        ('IMPOSTOS','ISS / ISSQN','ISS / ISSQN',105)
        ON CONFLICT DO NOTHING
      `).catch(e => console.error('[config] seed categorias:', e.message));
    } // fim if (!catsOk)

    // Config padrão
    await pool.query(`
      INSERT INTO config_sistema (chave, valor, descricao) VALUES
        ('nome_empresa',    'Bom Beef',         'Nome da empresa'),
        ('logo_emoji',      '🥩',               'Emoji do logo'),
        ('dias_alerta_val', '7',                'Dias de antecedência para alerta de validade'),
        ('taxa_desconto_fun','100',             'Desconto padrão para retiradas de funcionários (%)'),
        ('fuso_horario',    'America/Sao_Paulo','Fuso horário do sistema')
      ON CONFLICT (chave) DO NOTHING
    `);
  }
  initTable().catch(e => console.error('[config] initTable:', e.message));

  // ══════════════════════════════════════════════════════════════════════
  // FUNCIONÁRIOS
  // ══════════════════════════════════════════════════════════════════════

  r.get('/funcionarios', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT f.*, u.email AS usuario_email
        FROM funcionarios f
        LEFT JOIN usuarios u ON u.id = f.usuario_id
        ORDER BY f.nome ASC
      `);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/funcionarios', requireNivel('gestor'), async (req, res) => {
    const f = req.body;
    if (!f.nome) return res.status(400).json({ ok: false, erro: 'nome obrigatório' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO funcionarios (nome, cargo, email, telefone, limite_retirada, usuario_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [f.nome.trim(), f.cargo || null, f.email || null, f.telefone || null,
          parseFloat(f.limiteRetirada || 0), f.usuarioId || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/funcionarios/:id', requireNivel('gestor'), async (req, res) => {
    const f = req.body;
    try {
      await pool.query(`
        UPDATE funcionarios SET
          nome              = COALESCE($1, nome),
          cargo             = COALESCE($2, cargo),
          email             = COALESCE($3, email),
          telefone          = COALESCE($4, telefone),
          limite_retirada   = COALESCE($5, limite_retirada),
          usuario_id        = COALESCE($6, usuario_id),
          ativo             = COALESCE($7, ativo),
          atualizado_em     = NOW()
        WHERE id = $8
      `, [
        f.nome || null, f.cargo || null, f.email || null, f.telefone || null,
        f.limiteRetirada !== undefined ? parseFloat(f.limiteRetirada) : null,
        f.usuarioId || null, f.ativo !== undefined ? f.ativo : null,
        parseInt(req.params.id),
      ]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.delete('/funcionarios/:id', autenticar('admin'), async (req, res) => {
    try {
      await pool.query(`UPDATE funcionarios SET ativo = false, atualizado_em = NOW() WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // METAS
  // ══════════════════════════════════════════════════════════════════════

  r.get('/metas', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM metas ORDER BY mes DESC`);
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.get('/metas/:mes', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM metas WHERE mes = $1`, [req.params.mes]);
      const mes = req.params.mes;
      if (!rows.length) {
        // Retorna estrutura vazia com o mês
        return res.json({ ok: true, data: { mes, faturamento_meta: 0, faturamento_real: 0, meta_perda_pct: 2, meta_retiradas: 0 } });
      }
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/metas', requireNivel('gestor'), async (req, res) => {
    const m = req.body;
    if (!m.mes) return res.status(400).json({ ok: false, erro: 'mes obrigatório (MM/YYYY)' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO metas (mes, faturamento_meta, faturamento_real, meta_perda_pct, meta_retiradas, observacao)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (mes) DO UPDATE SET
          faturamento_meta  = EXCLUDED.faturamento_meta,
          faturamento_real  = EXCLUDED.faturamento_real,
          meta_perda_pct    = EXCLUDED.meta_perda_pct,
          meta_retiradas    = EXCLUDED.meta_retiradas,
          observacao        = EXCLUDED.observacao,
          atualizado_em     = NOW()
        RETURNING *
      `, [m.mes, parseFloat(m.faturamentoMeta || 0), parseFloat(m.faturamentoReal || 0),
          parseFloat(m.metaPerdaPct || 2), parseFloat(m.metaRetiradas || 0), m.observacao || null]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // CATEGORIAS DRE
  // ══════════════════════════════════════════════════════════════════════

  r.get('/categorias', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM categorias_dre WHERE ativo = true ORDER BY grupo, ordem, subgrupo`
      );
      res.json({ ok: true, data: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/categorias', requireNivel('gestor'), async (req, res) => {
    const c = req.body;
    if (!c.grupo || !c.subgrupo) return res.status(400).json({ ok: false, erro: 'grupo e subgrupo obrigatórios' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO categorias_dre (grupo, subgrupo, label_exibicao, ordem)
        VALUES ($1,$2,$3,$4) RETURNING *
      `, [c.grupo, c.subgrupo, c.labelExibicao || c.subgrupo, parseInt(c.ordem || 99)]);
      res.json({ ok: true, data: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/categorias/:id', requireNivel('gestor'), async (req, res) => {
    const c = req.body;
    try {
      await pool.query(`
        UPDATE categorias_dre SET
          grupo           = COALESCE($1, grupo),
          subgrupo        = COALESCE($2, subgrupo),
          label_exibicao  = COALESCE($3, label_exibicao),
          ordem           = COALESCE($4, ordem),
          ativo           = COALESCE($5, ativo)
        WHERE id = $6
      `, [c.grupo || null, c.subgrupo || null, c.labelExibicao || null,
          c.ordem !== undefined ? parseInt(c.ordem) : null,
          c.ativo !== undefined ? c.ativo : null,
          parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.delete('/categorias/:id', autenticar('admin'), async (req, res) => {
    try {
      await pool.query(`UPDATE categorias_dre SET ativo = false WHERE id = $1`, [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // CONFIG SISTEMA
  // ══════════════════════════════════════════════════════════════════════

  r.get('/sistema', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT chave, valor FROM config_sistema`);
      const cfg = {};
      rows.forEach(r => { cfg[r.chave] = r.valor; });
      // Expõe logo_base64 explicitamente
      res.json({ ok: true, data: { ...cfg, logo_base64: cfg.logo_base64 || null } });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/sistema', requireNivel('admin'), async (req, res) => {
    const updates = req.body; // { chave: valor, ... }
    try {
      for (const [chave, valor] of Object.entries(updates)) {
        await pool.query(`
          INSERT INTO config_sistema (chave, valor) VALUES ($1, $2)
          ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
        `, [chave, String(valor)]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /acoes-validade ───────────────────────────────────────────────────
  r.get('/acoes-validade', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM validade_acoes WHERE ativo=true ORDER BY ordem, descricao`);
      res.json({ ok: true, data: rows });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/acoes-validade', async (req, res) => {
    const { descricao, ordem } = req.body;
    if(!descricao) return res.status(400).json({ ok: false, erro: 'descricao obrigatória' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO validade_acoes (descricao, ordem) VALUES ($1, $2) RETURNING *`,
        [descricao.trim(), parseInt(ordem)||99]
      );
      res.json({ ok: true, data: rows[0] });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.delete('/acoes-validade/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE validade_acoes SET ativo=false WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/acoes-validade/:id', async (req, res) => {
    const { descricao, ordem } = req.body;
    try {
      await pool.query(
        `UPDATE validade_acoes SET descricao=$1, ordem=$2 WHERE id=$3`,
        [descricao.trim(), parseInt(ordem)||99, req.params.id]
      );
      res.json({ ok: true });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /acoes-validade ───────────────────────────────────────────────────
  r.get('/acoes-validade', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM validade_acoes WHERE ativo=true ORDER BY ordem, descricao`);
      res.json({ ok: true, data: rows });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.post('/acoes-validade', async (req, res) => {
    const { descricao, ordem } = req.body;
    if(!descricao) return res.status(400).json({ ok: false, erro: 'descricao obrigatória' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO validade_acoes (descricao, ordem) VALUES ($1, $2) RETURNING *`,
        [descricao.trim(), parseInt(ordem)||99]
      );
      res.json({ ok: true, data: rows[0] });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.delete('/acoes-validade/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE validade_acoes SET ativo=false WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  r.put('/acoes-validade/:id', async (req, res) => {
    const { descricao, ordem } = req.body;
    try {
      await pool.query(
        `UPDATE validade_acoes SET descricao=$1, ordem=$2 WHERE id=$3`,
        [descricao.trim(), parseInt(ordem)||99, req.params.id]
      );
      res.json({ ok: true });
    } catch(e){ res.status(500).json({ ok: false, erro: e.message }); }
  });

  return r;
};
