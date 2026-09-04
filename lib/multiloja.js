/**
 * Fundacao multi-loja.
 *
 * Nesta primeira etapa, a estrutura e criada e todos os usuarios atuais sao
 * vinculados a Valinhos. Os dados operacionais ainda nao sao filtrados por
 * loja; isso sera feito modulo a modulo nas proximas migracoes.
 */

const EMPRESA_PADRAO = {
  codigo: process.env.EMPRESA_PADRAO_CODIGO || 'ar-boutique-carnes',
  nome: process.env.EMPRESA_PADRAO_NOME || 'AR Boutique de Carnes LTDA',
  cnpj: process.env.EMPRESA_PADRAO_CNPJ || '46237080000102',
};

const LOJA_PADRAO = {
  codigo: process.env.LOJA_PADRAO_CODIGO || 'valinhos',
  nome: process.env.LOJA_PADRAO_NOME || 'Bom Beef Valinhos',
};

function somenteDigitos(valor) {
  return String(valor || '').replace(/\D/g, '') || null;
}

async function garantirEstruturaMultiloja(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS empresas (
        id            SERIAL PRIMARY KEY,
        codigo        TEXT NOT NULL UNIQUE,
        nome          TEXT NOT NULL,
        cnpj          TEXT,
        ativa         BOOLEAN NOT NULL DEFAULT true,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_empresas_cnpj_normalizado
      ON empresas ((regexp_replace(cnpj, '\\D', '', 'g')))
      WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '\\D', '', 'g') <> ''
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lojas (
        id            SERIAL PRIMARY KEY,
        empresa_id    INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
        codigo        TEXT NOT NULL,
        nome          TEXT NOT NULL,
        cnpj          TEXT,
        timezone      TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
        endereco      TEXT,
        cidade        TEXT,
        uf            TEXT,
        pronta_operacao BOOLEAN NOT NULL DEFAULT false,
        ativa         BOOLEAN NOT NULL DEFAULT true,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (empresa_id, codigo)
      )
    `);
    await client.query(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS endereco TEXT`);
    await client.query(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS cidade TEXT`);
    await client.query(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS uf TEXT`);
    await client.query(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS pronta_operacao BOOLEAN NOT NULL DEFAULT false`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS usuario_lojas (
        id            BIGSERIAL PRIMARY KEY,
        usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        loja_id       INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
        perfil        TEXT NOT NULL,
        permissoes    JSONB NOT NULL DEFAULT '{}'::jsonb,
        ativo         BOOLEAN NOT NULL DEFAULT true,
        principal     BOOLEAN NOT NULL DEFAULT false,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (usuario_id, loja_id)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_usuario_loja_principal
      ON usuario_lojas (usuario_id)
      WHERE principal = true
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_usuario_lojas_loja ON usuario_lojas(loja_id, ativo)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_usuario_lojas_usuario ON usuario_lojas(usuario_id, ativo)`);

    // A sessao registra em qual loja o usuario trabalhou. Continua anulavel
    // durante a transicao para manter compatibilidade com sessoes antigas.
    await client.query(`ALTER TABLE login_sessoes ADD COLUMN IF NOT EXISTS loja_id INTEGER`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'login_sessoes_loja_id_fkey'
        ) THEN
          ALTER TABLE login_sessoes
          ADD CONSTRAINT login_sessoes_loja_id_fkey
          FOREIGN KEY (loja_id) REFERENCES lojas(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_login_sessoes_loja ON login_sessoes(loja_id, iniciado_em DESC)`);

    const { rows: empresas } = await client.query(`
      INSERT INTO empresas (codigo, nome, cnpj)
      VALUES ($1, $2, $3)
      ON CONFLICT (codigo) DO UPDATE SET
        nome = EXCLUDED.nome,
        cnpj = COALESCE(empresas.cnpj, EXCLUDED.cnpj),
        atualizado_em = NOW()
      RETURNING id
    `, [EMPRESA_PADRAO.codigo, EMPRESA_PADRAO.nome, somenteDigitos(EMPRESA_PADRAO.cnpj)]);
    const empresaId = empresas[0].id;

    const { rows: lojas } = await client.query(`
      INSERT INTO lojas (empresa_id, codigo, nome, cnpj, pronta_operacao)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (empresa_id, codigo) DO UPDATE SET
        nome = EXCLUDED.nome,
        cnpj = COALESCE(lojas.cnpj, EXCLUDED.cnpj),
        pronta_operacao = true,
        atualizado_em = NOW()
      RETURNING id
    `, [empresaId, LOJA_PADRAO.codigo, LOJA_PADRAO.nome, somenteDigitos(EMPRESA_PADRAO.cnpj)]);
    const lojaId = lojas[0].id;

    // Durante a transição, rotas ainda não convertidas continuam gravando na
    // unidade histórica. Cada módulo passa a informar loja_id explicitamente
    // antes de uma segunda loja ser liberada para operação.
    await client.query(`
      CREATE OR REPLACE FUNCTION bb_loja_padrao() RETURNS INTEGER AS $$
        SELECT id FROM lojas WHERE empresa_id = ${Number(empresaId)} AND codigo = 'valinhos' LIMIT 1
      $$ LANGUAGE SQL STABLE
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS multiloja_modulos (
        modulo        TEXT PRIMARY KEY,
        nome          TEXT NOT NULL,
        ordem         INTEGER NOT NULL DEFAULT 99,
        isolado       BOOLEAN NOT NULL DEFAULT false,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO multiloja_modulos(modulo,nome,ordem) VALUES
        ('estoque_compras','Estoque e Compras',10),
        ('financeiro','Financeiro',20),
        ('producao_comercial','Produção e Comercial',30),
        ('pessoas','Pessoas',40),
        ('administracao','Administração e Auditoria',50)
      ON CONFLICT(modulo) DO UPDATE SET nome=EXCLUDED.nome,ordem=EXCLUDED.ordem
    `);

    // Fase 1 do isolamento operacional: identifica a loja em todas as tabelas
    // do núcleo Estoque & Compras, preservando integralmente os dados atuais.
    const tabelasEstoqueCompras = [
      'produtos','fornecedores','fornecedor_produtos','compras_importacoes',
      'compras_produto','validade_items','validade_confirmacoes',
      'validade_internos','movimentos_estoque'
    ];
    for (const tabela of tabelasEstoqueCompras) {
      const existe = await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`]);
      if (!existe.rows[0].tabela) continue;
      await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
      await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
      await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaId]);
      await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja ON ${tabela}(loja_id)`);
    }

    // Backfill seguro: nao altera vinculos que ja tenham sido configurados.
    await client.query(`
      INSERT INTO usuario_lojas (usuario_id, loja_id, perfil, permissoes, principal)
      SELECT u.id, $1, u.perfil, COALESCE(u.permissoes, '{}'::jsonb),
             NOT EXISTS (SELECT 1 FROM usuario_lojas atual WHERE atual.usuario_id = u.id)
      FROM usuarios u
      ON CONFLICT (usuario_id, loja_id) DO NOTHING
    `, [lojaId]);

    await client.query(`
      UPDATE usuario_lojas ul
      SET principal = true, atualizado_em = NOW()
      WHERE ul.loja_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM usuario_lojas principal
          WHERE principal.usuario_id = ul.usuario_id AND principal.principal = true
        )
    `, [lojaId]);

    // Sessoes historicas pertencem a unica loja que existia antes da migracao.
    await client.query(`UPDATE login_sessoes SET loja_id = $1 WHERE loja_id IS NULL`, [lojaId]);

    await client.query('COMMIT');
    return { empresaId, lojaId };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

async function listarLojasDoUsuario(pool, usuarioId) {
  const { rows } = await pool.query(`
    SELECT ul.id AS vinculo_id,
           ul.perfil,
           ul.permissoes,
           ul.principal,
           l.id AS loja_id,
           l.codigo AS loja_codigo,
           l.nome AS loja_nome,
           l.timezone,
           e.id AS empresa_id,
           e.codigo AS empresa_codigo,
           e.nome AS empresa_nome
    FROM usuario_lojas ul
    JOIN lojas l ON l.id = ul.loja_id AND l.ativa = true AND l.pronta_operacao = true
    JOIN empresas e ON e.id = l.empresa_id AND e.ativa = true
    WHERE ul.usuario_id = $1 AND ul.ativo = true
    ORDER BY ul.principal DESC, l.nome ASC
  `, [usuarioId]);
  return rows;
}

async function resolverLojaDoUsuario(pool, usuarioId, lojaPreferidaId = null) {
  const lojas = await listarLojasDoUsuario(pool, usuarioId);
  if (!lojas.length) return null;
  if (lojaPreferidaId !== null && lojaPreferidaId !== undefined) {
    return lojas.find(loja => Number(loja.loja_id) === Number(lojaPreferidaId)) || null;
  }
  return lojas[0];
}

function contextoLojaPublico(loja) {
  if (!loja) return null;
  return {
    id: loja.loja_id,
    codigo: loja.loja_codigo,
    nome: loja.loja_nome,
    timezone: loja.timezone,
    empresa: {
      id: loja.empresa_id,
      codigo: loja.empresa_codigo,
      nome: loja.empresa_nome,
    },
  };
}

function payloadComLoja(usuario, sessaoId, loja) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: loja?.perfil || usuario.perfil,
    sessaoId,
    lojaId: loja?.loja_id || null,
    lojaCodigo: loja?.loja_codigo || null,
    empresaId: loja?.empresa_id || null,
    vinculoLojaId: loja?.vinculo_id || null,
  };
}

module.exports = {
  garantirEstruturaMultiloja,
  listarLojasDoUsuario,
  resolverLojaDoUsuario,
  contextoLojaPublico,
  payloadComLoja,
};
