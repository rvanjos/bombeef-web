'use strict';

const TABELAS_POR_MODULO = {
  estoque_compras: [
    'produtos','fornecedores','fornecedor_produtos','compras_importacoes','compras_produto',
    'validade_items','validade_confirmacoes','validade_internos','validade_interno_anexos','validade_documentos','movimentos_estoque'
  ],
  financeiro: [
    'boletos','boletos_importacoes','faturamento_periodos','faturamento_caixa','faturamento_metas','metas',
    'dre_sessoes','dre_lancamentos','cartao_faturas','cartao_fatura_itens','cartao_apelido_mapa',
    'auditoria_dre_conflitos_resolvidos','classificador_sessoes','classificador_transacoes'
  ],
  producao_comercial: [
    'kits','kit_itens','kit_semanas','kit_precificacao_config','kit_campanhas','kit_campanha_slots',
    'kit_pedidos','kit_pedido_itens','kit_reservas','kit_estoque_interno','kit_pdv_conciliacao',
    'campanha_planejamento','cortes_registros','cortes_insumos','cortes_fichas','cortes_vendas','cortes_config',
    'vendas_produto','vendas_importacoes','retiradas','clientes_fiado','vendas_fiado','itens_venda_fiado',
    'pagamentos_fiado','pagamento_venda_fiado','historico_fiado'
  ],
  pessoas: [
    'funcionarios','rh_fichas','rh_apontamentos','rh_pagamentos','rh_meta_fds_config','rh_escalas',
    'ponto_registros','ponto_auditoria','ponto_jornada_dia'
  ],
  administracao: ['auditoria_eventos','config_sistema','validade_acoes','perdas']
};

const COMPARTILHADAS = new Set([
  'empresas','lojas','usuario_lojas','usuarios','login_sessoes','categorias_dre','fornecedores_lookup',
  'multiloja_modulos','multiloja_migracoes','multiloja_auditoria_status'
]);

function moduloDaTabela(tabela) {
  for (const [modulo, tabelas] of Object.entries(TABELAS_POR_MODULO)) {
    if (tabelas.includes(tabela)) return modulo;
  }
  return 'nao_catalogada';
}

async function garantirTabelaAuditoria(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS multiloja_auditoria_status (
      tabela TEXT PRIMARY KEY,
      modulo TEXT NOT NULL,
      existe BOOLEAN NOT NULL DEFAULT true,
      tem_loja_id BOOLEAN NOT NULL DEFAULT false,
      loja_not_null BOOLEAN NOT NULL DEFAULT false,
      tem_indice BOOLEAN NOT NULL DEFAULT false,
      rls_ativo BOOLEAN NOT NULL DEFAULT false,
      rls_forcado BOOLEAN NOT NULL DEFAULT false,
      politica_fail_closed BOOLEAN NOT NULL DEFAULT false,
      problemas JSONB NOT NULL DEFAULT '[]'::jsonb,
      nivel TEXT NOT NULL DEFAULT 'ok',
      verificado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function lojaHistoricaId(client) {
  const { rows } = await client.query(`
    SELECT id FROM lojas
    ORDER BY CASE WHEN codigo='valinhos' THEN 0 ELSE 1 END, id
    LIMIT 1
  `);
  if (!rows.length) throw new Error('Nenhuma loja cadastrada para saneamento multi-loja');
  return Number(rows[0].id);
}

async function garantirLojaId(client, tabela, lojaPadraoId) {
  const { rows: cols } = await client.query(`
    SELECT column_name,is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [tabela]);
  let lojaCol = cols.find(c => c.column_name === 'loja_id');

  if (!lojaCol) {
    await client.query(`ALTER TABLE ${tabela} ADD COLUMN loja_id INTEGER REFERENCES lojas(id) ON DELETE RESTRICT`);
    await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`);
    await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaPadraoId]);
    await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
    return { criada: true, notNull: true };
  }

  await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET DEFAULT bb_loja_padrao()`).catch(() => {});
  const { rows: nulos } = await client.query(`SELECT COUNT(*)::int AS qtd FROM ${tabela} WHERE loja_id IS NULL`);
  if (Number(nulos[0]?.qtd || 0) > 0) {
    await client.query(`UPDATE ${tabela} SET loja_id=$1 WHERE loja_id IS NULL`, [lojaPadraoId]);
  }
  await client.query(`ALTER TABLE ${tabela} ALTER COLUMN loja_id SET NOT NULL`);
  return { criada: false, notNull: true };
}

async function aplicarPoliticaFailClosed(client, tabela) {
  await client.query(`ALTER TABLE ${tabela} ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE ${tabela} FORCE ROW LEVEL SECURITY`);
  await client.query(`DROP POLICY IF EXISTS bb_isolamento_loja ON ${tabela}`);
  await client.query(`
    CREATE POLICY bb_isolamento_loja ON ${tabela}
    USING (
      current_setting('app.bb_system', true) = '1'
      OR (
        NULLIF(current_setting('app.loja_id', true),'') IS NOT NULL
        AND loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
      )
    )
    WITH CHECK (
      current_setting('app.bb_system', true) = '1'
      OR (
        NULLIF(current_setting('app.loja_id', true),'') IS NOT NULL
        AND loja_id = NULLIF(current_setting('app.loja_id', true),'')::integer
      )
    )
  `);
}

async function auditarSegurancaMultiloja(pool, { aplicarPoliticas = false } = {}) {
  const client = await pool.connect();
  const resultado = { ok: true, criticos: [], avisos: [], tabelas: [], saneadas: [] };
  try {
    await client.query(`SELECT set_config('app.bb_system','1',false)`);
    await garantirTabelaAuditoria(client);
    const lojaPadraoId = await lojaHistoricaId(client);

    const esperadas = new Set(Object.values(TABELAS_POR_MODULO).flat());
    const { rows: publicas } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public'
      ORDER BY tablename
    `);
    const publicSet = new Set(publicas.map(r => r.tablename));

    const { rows: comLoja } = await client.query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema='public' AND column_name='loja_id'
    `);
    comLoja.forEach(r => {
      if (!COMPARTILHADAS.has(r.table_name)) esperadas.add(r.table_name);
    });

    for (const tabela of [...esperadas].sort()) {
      if (!publicSet.has(tabela) || COMPARTILHADAS.has(tabela)) continue;
      const modulo = moduloDaTabela(tabela);
      const problemas = [];

      let { rows: cols } = await client.query(`
        SELECT column_name,is_nullable
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
      `, [tabela]);
      let lojaCol = cols.find(c => c.column_name === 'loja_id');

      if (aplicarPoliticas && modulo !== 'nao_catalogada') {
        const antesTinha = !!lojaCol;
        await garantirLojaId(client, tabela, lojaPadraoId);
        if (!antesTinha) resultado.saneadas.push(tabela);
        ({ rows: cols } = await client.query(`
          SELECT column_name,is_nullable
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1
        `, [tabela]));
        lojaCol = cols.find(c => c.column_name === 'loja_id');
      }

      if (!lojaCol) problemas.push('sem_loja_id');
      const lojaNotNull = !!lojaCol && lojaCol.is_nullable === 'NO';
      if (lojaCol && !lojaNotNull) problemas.push('loja_id_nullable');

      const { rows: relRows } = await client.query(`
        SELECT c.relrowsecurity,c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1
      `, [tabela]);
      const rlsAtivoAntes = !!relRows[0]?.relrowsecurity;
      const rlsForcadoAntes = !!relRows[0]?.relforcerowsecurity;

      let { rows: idxRows } = lojaCol ? await client.query(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename=$1 AND indexdef ILIKE '%(loja_id%'
      `, [tabela]) : { rows: [] };
      let temIndice = idxRows.length > 0;
      if (lojaCol && !temIndice && aplicarPoliticas) {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_${tabela}_loja_audit ON ${tabela}(loja_id)`);
        temIndice = true;
      }
      if (lojaCol && !temIndice) problemas.push('sem_indice_loja');

      if (aplicarPoliticas && lojaCol && lojaNotNull) {
        await aplicarPoliticaFailClosed(client, tabela);
      }

      const { rows: policyRows } = lojaCol ? await client.query(`
        SELECT qual,with_check
        FROM pg_policies
        WHERE schemaname='public' AND tablename=$1 AND policyname='bb_isolamento_loja'
      `, [tabela]) : { rows: [] };
      const policyText = policyRows.map(p => `${p.qual || ''} ${p.with_check || ''}`).join(' ');
      const failClosed = policyText.includes('app.loja_id') && policyText.includes('app.bb_system') && !policyText.includes('IS NULL OR loja_id');
      if (lojaCol && !failClosed) problemas.push('politica_nao_fail_closed');

      const rlsAtivo = rlsAtivoAntes || (aplicarPoliticas && !!lojaCol && lojaNotNull);
      const rlsForcado = rlsForcadoAntes || (aplicarPoliticas && !!lojaCol && lojaNotNull);
      const nivel = problemas.some(p => p === 'sem_loja_id' || p === 'loja_id_nullable') ? 'critico'
        : problemas.length ? 'aviso' : 'ok';
      if (nivel === 'critico') resultado.criticos.push({ tabela, problemas });
      else if (nivel === 'aviso') resultado.avisos.push({ tabela, problemas });

      const item = {
        tabela, modulo, existe: true, tem_loja_id: !!lojaCol, loja_not_null: lojaNotNull,
        tem_indice: temIndice, rls_ativo: rlsAtivo, rls_forcado: rlsForcado,
        politica_fail_closed: failClosed, problemas, nivel
      };
      resultado.tabelas.push(item);

      await client.query(`
        INSERT INTO multiloja_auditoria_status
          (tabela,modulo,existe,tem_loja_id,loja_not_null,tem_indice,rls_ativo,rls_forcado,politica_fail_closed,problemas,nivel,verificado_em)
        VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,NOW())
        ON CONFLICT(tabela) DO UPDATE SET
          modulo=EXCLUDED.modulo,existe=true,tem_loja_id=EXCLUDED.tem_loja_id,
          loja_not_null=EXCLUDED.loja_not_null,tem_indice=EXCLUDED.tem_indice,
          rls_ativo=EXCLUDED.rls_ativo,rls_forcado=EXCLUDED.rls_forcado,
          politica_fail_closed=EXCLUDED.politica_fail_closed,problemas=EXCLUDED.problemas,
          nivel=EXCLUDED.nivel,verificado_em=NOW()
      `, [tabela,modulo,!!lojaCol,lojaNotNull,temIndice,rlsAtivo,rlsForcado,failClosed,JSON.stringify(problemas),nivel]);
    }

    const naoCatalogadas = publicas.map(r => r.tablename)
      .filter(t => !esperadas.has(t) && !COMPARTILHADAS.has(t) && !t.startsWith('pg_'));
    for (const tabela of naoCatalogadas) {
      resultado.avisos.push({ tabela, problemas: ['tabela_nao_catalogada_revisar_escopo'] });
    }

    resultado.ok = resultado.criticos.length === 0;
    await client.query(`
      INSERT INTO multiloja_modulos(modulo,nome,ordem,isolado,atualizado_em)
      VALUES ('seguranca','Segurança e Auditor Multi-loja',60,$1,NOW())
      ON CONFLICT(modulo) DO UPDATE SET nome=EXCLUDED.nome,ordem=EXCLUDED.ordem,isolado=EXCLUDED.isolado,atualizado_em=NOW()
    `, [resultado.ok]);

    return resultado;
  } finally {
    await client.query(`SELECT set_config('app.bb_system','',false)`).catch(() => {});
    client.release();
  }
}

module.exports = { TABELAS_POR_MODULO, COMPARTILHADAS, auditarSegurancaMultiloja, aplicarPoliticaFailClosed };
