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

async function garantirEstruturaMultiloja(pool, { operacional = false } = {}) {
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
        SELECT COALESCE(
          NULLIF(current_setting('app.loja_id', true),'')::integer,
          (SELECT id FROM lojas WHERE empresa_id = ${Number(empresaId)} AND codigo = 'valinhos' LIMIT 1)
        )
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS multiloja_migracoes (
        versao       TEXT PRIMARY KEY,
        aplicado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const versaoOperacional = '2026-09-financeiro-v1';
    const migracaoAplicada = operacional && (await client.query(
      `SELECT 1 FROM multiloja_migracoes WHERE versao=$1`,
      [versaoOperacional]
    )).rowCount > 0;
    const versaoProducaoComercial = '2026-09-producao-comercial-v1';
    const migracaoProducaoAplicada = operacional && (await client.query(
      `SELECT 1 FROM multiloja_migracoes WHERE versao=$1`,
      [versaoProducaoComercial]
    )).rowCount > 0;
    const versaoPessoas = '2026-09-pessoas-v1';
    const migracaoPessoasAplicada = operacional && (await client.query(
      `SELECT 1 FROM multiloja_migracoes WHERE versao=$1`,
      [versaoPessoas]
    )).rowCount > 0;

    if (operacional && !migracaoAplicada) {
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
      await client.query(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON ${tabela}`);
      await client.query(`
        CREATE POLICY bb_isolamento_loja ON ${tabela}
        USING (
          NULLIF(current_setting('app.loja_id', true),'') IS NULL
          OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
        WITH CHECK (
          NULLIF(current_setting('app.loja_id', true),'') IS NULL
          OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
      `);
    }

    const tabelasFinanceiro = [
      'boletos','boletos_importacoes','faturamento_periodos','faturamento_caixa',
      'faturamento_metas','metas','dre_sessoes','dre_lancamentos',
      'cartao_faturas','cartao_fatura_itens','cartao_apelido_mapa',
      'auditoria_dre_conflitos_resolvidos',
      'classificador_sessoes','classificador_transacoes'
    ];
    for (const tabela of tabelasFinanceiro) {
      const existe = await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`]);
      if (!existe.rows[0].tabela) continue;
      await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
      await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
      await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaId]);
      await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja ON ${tabela}(loja_id)`);
      await client.query(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON ${tabela}`);
      await client.query(`
        CREATE POLICY bb_isolamento_loja ON ${tabela}
        USING (
          NULLIF(current_setting('app.loja_id', true),'') IS NULL
          OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
        WITH CHECK (
          NULLIF(current_setting('app.loja_id', true),'') IS NULL
          OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
        )
      `);
    }

    // Chaves financeiras passam a aceitar o mesmo mês, fatura, fornecedor ou
    // cartão em unidades diferentes, mantendo a deduplicação dentro da loja.
    const ajustesFinanceiros = [
      `ALTER TABLE metas DROP CONSTRAINT IF EXISTS metas_mes_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_metas_loja_mes ON metas(loja_id,mes)`,
      `ALTER TABLE faturamento_metas DROP CONSTRAINT IF EXISTS faturamento_metas_mes_ref_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_faturamento_metas_loja_mes ON faturamento_metas(loja_id,mes_ref)`,
      `ALTER TABLE dre_sessoes DROP CONSTRAINT IF EXISTS dre_sessoes_mes_ref_usuario_id_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_dre_sessoes_loja_mes_usuario ON dre_sessoes(loja_id,mes_ref,usuario_id)`,
      `DROP INDEX IF EXISTS uq_faturamento_dia`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_faturamento_dia_loja ON faturamento_periodos(loja_id,data_inicio) WHERE tipo_periodo='dia'`,
      `DROP INDEX IF EXISTS idx_cf_hash`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_hash_loja ON cartao_faturas(loja_id,hash_fatura) WHERE hash_fatura IS NOT NULL`,
      `ALTER TABLE cartao_apelido_mapa DROP CONSTRAINT IF EXISTS cartao_apelido_mapa_pkey`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_cartao_apelido_loja_chave ON cartao_apelido_mapa(loja_id,chave)`,
      `ALTER TABLE auditoria_dre_conflitos_resolvidos DROP CONSTRAINT IF EXISTS auditoria_dre_conflitos_resolvidos_mes_ref_chave_fornecedor_categoria_atual_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_auditoria_conflito_loja ON auditoria_dre_conflitos_resolvidos(loja_id,mes_ref,chave_fornecedor,categoria_atual)`
    ];
    for (const sql of ajustesFinanceiros) {
      const tabela = sql.match(/(?:TABLE|ON)\s+([a-z_]+)/i)?.[1];
      if (!tabela || (await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`])).rows[0].tabela) {
        await client.query(sql);
      }
    }
    await client.query(`
      UPDATE multiloja_modulos
      SET isolado=true, atualizado_em=NOW()
      WHERE modulo IN ('estoque_compras','financeiro')
    `);

    // Identificadores comerciais podem se repetir entre lojas. A identidade
    // passa a ser composta por loja + código/CNPJ, sem alterar os IDs atuais.
    if ((await client.query(`SELECT to_regclass('public.produtos') AS t`)).rows[0].t) {
      await client.query(`ALTER TABLE produtos DROP CONSTRAINT IF EXISTS produtos_codigo_key`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_loja_codigo ON produtos(loja_id,codigo)`);
    }
    if ((await client.query(`SELECT to_regclass('public.fornecedores') AS t`)).rows[0].t) {
      // Bancos antigos usavam o CNPJ como chave primária. Converte para ID
      // interno para que o mesmo fornecedor possa existir em duas lojas.
      await client.query(`
        DO $$
        DECLARE pk_col TEXT;
        BEGIN
          SELECT a.attname INTO pk_col
          FROM pg_constraint c
          JOIN unnest(c.conkey) WITH ORDINALITY k(attnum,ord) ON true
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
          WHERE c.conrelid='fornecedores'::regclass AND c.contype='p'
          ORDER BY k.ord LIMIT 1;
          IF pk_col='cnpj_fornecedor' THEN
            ALTER TABLE fornecedores DROP CONSTRAINT fornecedores_pkey;
            ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS id BIGSERIAL;
            ALTER TABLE fornecedores ADD PRIMARY KEY(id);
          END IF;
        END $$
      `);
      await client.query(`ALTER TABLE fornecedores DROP CONSTRAINT IF EXISTS fornecedores_cnpj_fornecedor_key`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_loja_cnpj ON fornecedores(loja_id,cnpj_fornecedor)`);
    }
    if ((await client.query(`SELECT to_regclass('public.fornecedor_produtos') AS t`)).rows[0].t) {
      await client.query(`ALTER TABLE fornecedor_produtos DROP CONSTRAINT IF EXISTS fornecedor_produtos_cnpj_fornecedor_produto_codigo_key`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedor_produtos_loja ON fornecedor_produtos(loja_id,cnpj_fornecedor,produto_codigo)`);
    }
    if ((await client.query(`SELECT to_regclass('public.compras_produto') AS t`)).rows[0].t) {
      await client.query(`DROP INDEX IF EXISTS idx_cp_dedup`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_dedup_loja ON compras_produto(loja_id,numero_nfe,serie_nfe,fornecedor_cnpj,produto_codigo,cod_item_nfe) WHERE numero_nfe IS NOT NULL AND serie_nfe IS NOT NULL AND fornecedor_cnpj IS NOT NULL AND cod_item_nfe IS NOT NULL`);
    }

      await client.query(
        `INSERT INTO multiloja_migracoes(versao) VALUES($1) ON CONFLICT(versao) DO NOTHING`,
        [versaoOperacional]
      );
    }

    if (operacional && !migracaoProducaoAplicada) {
      const tabelasProducaoComercial = [
        'kits','kit_itens','kit_semanas','kit_precificacao_config','kit_campanhas','kit_campanha_slots',
        'kit_pedidos','kit_pedido_itens','kit_reservas','kit_estoque_interno',
        'kit_pdv_conciliacao','campanha_planejamento',
        'cortes_registros','cortes_insumos','cortes_fichas','cortes_vendas','cortes_config',
        'vendas_produto','vendas_importacoes',
        'retiradas','clientes_fiado','vendas_fiado','itens_venda_fiado',
        'pagamentos_fiado','pagamento_venda_fiado','historico_fiado'
      ];
      for (const tabela of tabelasProducaoComercial) {
        const existe = await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`]);
        if (!existe.rows[0].tabela) continue;
        await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
        await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
        await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaId]);
        await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja ON ${tabela}(loja_id)`);
        await client.query(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON ${tabela}`);
        await client.query(`
          CREATE POLICY bb_isolamento_loja ON ${tabela}
          USING (
            NULLIF(current_setting('app.loja_id', true),'') IS NULL
            OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
          )
          WITH CHECK (
            NULLIF(current_setting('app.loja_id', true),'') IS NULL
            OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
          )
        `);
      }

      const ajustesProducaoComercial = [
        `ALTER TABLE cortes_insumos DROP CONSTRAINT IF EXISTS cortes_insumos_nome_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_cortes_insumos_loja_nome ON cortes_insumos(loja_id,nome)`,
        `ALTER TABLE cortes_config DROP CONSTRAINT IF EXISTS cortes_config_pkey`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_cortes_config_loja_chave ON cortes_config(loja_id,chave)`,
        `ALTER TABLE kit_pedidos DROP CONSTRAINT IF EXISTS kit_pedidos_numero_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_kit_pedidos_loja_numero ON kit_pedidos(loja_id,numero)`,
        `ALTER TABLE kit_estoque_interno DROP CONSTRAINT IF EXISTS kit_estoque_interno_produto_id_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_kit_estoque_loja_produto ON kit_estoque_interno(loja_id,produto_id)`,
        `ALTER TABLE campanha_planejamento DROP CONSTRAINT IF EXISTS campanha_planejamento_campanha_id_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_campanha_planejamento_loja ON campanha_planejamento(loja_id,campanha_id)`,
        `DROP INDEX IF EXISTS idx_clientes_fiado_func`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_fiado_loja_func ON clientes_fiado(loja_id,funcionario_id) WHERE funcionario_id IS NOT NULL`
      ];
      for (const sql of ajustesProducaoComercial) {
        const tabela = sql.match(/(?:TABLE|ON)\s+([a-z_]+)/i)?.[1];
        if (!tabela || (await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`])).rows[0].tabela) {
          await client.query(sql);
        }
      }

      await client.query(`
        UPDATE multiloja_modulos
        SET isolado=true, atualizado_em=NOW()
        WHERE modulo='producao_comercial'
      `);
      await client.query(
        `INSERT INTO multiloja_migracoes(versao) VALUES($1) ON CONFLICT(versao) DO NOTHING`,
        [versaoProducaoComercial]
      );
    }

    if (operacional && !migracaoPessoasAplicada) {
      const tabelasPessoas = [
        'funcionarios','rh_fichas','rh_apontamentos','rh_pagamentos',
        'rh_meta_fds_config','rh_escalas','ponto_registros',
        'ponto_auditoria','ponto_jornada_dia','login_sessoes'
      ];
      for (const tabela of tabelasPessoas) {
        const existe = await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`]);
        if (!existe.rows[0].tabela) continue;
        await client.query(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
        await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
        await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaId]);
        await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja ON ${tabela}(loja_id)`);
        await client.query(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON ${tabela}`);
        await client.query(`
          CREATE POLICY bb_isolamento_loja ON ${tabela}
          USING (
            NULLIF(current_setting('app.loja_id', true),'') IS NULL
            OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
          )
          WITH CHECK (
            NULLIF(current_setting('app.loja_id', true),'') IS NULL
            OR loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
          )
        `);
      }

      const ajustesPessoas = [
        `ALTER TABLE rh_fichas DROP CONSTRAINT IF EXISTS rh_fichas_funcionario_id_mes_ref_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_rh_fichas_loja_func_mes ON rh_fichas(loja_id,funcionario_id,mes_ref)`,
        `ALTER TABLE rh_escalas DROP CONSTRAINT IF EXISTS rh_escalas_funcionario_id_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_rh_escalas_loja_func ON rh_escalas(loja_id,funcionario_id)`,
        `DROP INDEX IF EXISTS ponto_func_data_idx`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_ponto_loja_func_data ON ponto_registros(loja_id,funcionario_id,data_ref)`,
        `ALTER TABLE ponto_jornada_dia DROP CONSTRAINT IF EXISTS ponto_jornada_dia_funcionario_id_dia_semana_key`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_ponto_jornada_loja_func_dia ON ponto_jornada_dia(loja_id,funcionario_id,dia_semana)`,
        `ALTER TABLE rh_meta_fds_config DROP CONSTRAINT IF EXISTS rh_meta_fds_config_pkey`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_rh_meta_fds_loja ON rh_meta_fds_config(loja_id,id)`
      ];
      for (const sql of ajustesPessoas) {
        const tabela = sql.match(/(?:TABLE|ON)\s+([a-z_]+)/i)?.[1];
        if (!tabela || (await client.query(`SELECT to_regclass($1) AS tabela`, [`public.${tabela}`])).rows[0].tabela) {
          await client.query(sql);
        }
      }

      await client.query(`
        UPDATE multiloja_modulos
        SET isolado=true, atualizado_em=NOW()
        WHERE modulo='pessoas'
      `);
      await client.query(
        `INSERT INTO multiloja_migracoes(versao) VALUES($1) ON CONFLICT(versao) DO NOTHING`,
        [versaoPessoas]
      );
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

let migracaoOperacionalPromise = null;
function iniciarMigracaoOperacionalMultiloja(pool) {
  if (!migracaoOperacionalPromise) {
    migracaoOperacionalPromise = new Promise(resolve => setImmediate(resolve))
      .then(() => garantirEstruturaMultiloja(pool, { operacional: true }))
      .catch(erro => {
        migracaoOperacionalPromise = null;
        throw erro;
      });
  }
  return migracaoOperacionalPromise;
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
  iniciarMigracaoOperacionalMultiloja,
  listarLojasDoUsuario,
  resolverLojaDoUsuario,
  contextoLojaPublico,
  payloadComLoja,
};
