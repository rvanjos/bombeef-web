-- ═══════════════════════════════════════════════════════════════════════
-- SCHEMA — SISTEMA BOM BEEF v2.0
-- PostgreSQL 14+  |  Railway-ready
-- Execute completo uma única vez antes do primeiro npm start
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ───────────────────────────────────────────────────────────────────────
-- USUARIOS
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id             SERIAL PRIMARY KEY,
  nome           TEXT        NOT NULL,
  email          TEXT        NOT NULL UNIQUE,
  senha_hash     TEXT        NOT NULL,
  perfil         TEXT        NOT NULL DEFAULT 'operacao'
                 CHECK (perfil IN ('admin','gerente','financeiro','estoque','operacao')),
  ativo          BOOLEAN     NOT NULL DEFAULT true,
  ultimo_acesso  TIMESTAMPTZ,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────
-- FORNECEDORES
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fornecedores (
  cnpj_fornecedor  TEXT        PRIMARY KEY,
  razao_social     TEXT        NOT NULL,
  nome_fantasia    TEXT,
  contato          TEXT,
  telefone         TEXT,
  email            TEXT,
  endereco         TEXT,
  categoria_padrao TEXT,
  observacao       TEXT,
  ativo            BOOLEAN     NOT NULL DEFAULT true,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────
-- IMPORTACOES_TOTVS
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS importacoes_totvs (
  id                    SERIAL PRIMARY KEY,
  data_importacao       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  nome_arquivo          TEXT        NOT NULL,
  tipo_relatorio        TEXT        NOT NULL DEFAULT 'produtos',
  total_registros       INTEGER     NOT NULL DEFAULT 0,
  registros_inseridos   INTEGER     NOT NULL DEFAULT 0,
  registros_atualizados INTEGER     NOT NULL DEFAULT 0,
  registros_erro        INTEGER     NOT NULL DEFAULT 0,
  status                TEXT        NOT NULL DEFAULT 'processando'
                        CHECK (status IN ('processando','concluido','erro')),
  log_importacao        JSONB,
  usuario_responsavel   INTEGER REFERENCES usuarios(id)
);

-- ───────────────────────────────────────────────────────────────────────
-- PRODUTOS_MESTRE
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS produtos_mestre (
  codigo_produto          TEXT        PRIMARY KEY,
  descricao_produto       TEXT        NOT NULL,
  descricao_reduzida      TEXT,
  categoria               TEXT,
  unidade                 TEXT        NOT NULL DEFAULT 'KG',
  preco_custo             NUMERIC(12,4),
  preco_venda             NUMERIC(12,4),
  perecivel               BOOLEAN     NOT NULL DEFAULT true,
  controla_validade       BOOLEAN     NOT NULL DEFAULT true,
  controla_lote           BOOLEAN     NOT NULL DEFAULT false,
  fornecedor_principal    TEXT        REFERENCES fornecedores(cnpj_fornecedor),
  origem_dados            TEXT        NOT NULL DEFAULT 'TOTVS',
  id_importacao_origem    INTEGER     REFERENCES importacoes_totvs(id),
  data_ultima_importacao  TIMESTAMPTZ,
  ativo                   BOOLEAN     NOT NULL DEFAULT true,
  criado_em               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_produtos_descricao  ON produtos_mestre USING gin(descricao_produto gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria  ON produtos_mestre(categoria);
CREATE INDEX IF NOT EXISTS idx_produtos_ativo      ON produtos_mestre(ativo);
CREATE INDEX IF NOT EXISTS idx_produtos_importacao ON produtos_mestre(data_ultima_importacao);

-- ───────────────────────────────────────────────────────────────────────
-- LOTES_ESTOQUE
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lotes_estoque (
  id                  SERIAL PRIMARY KEY,
  codigo_produto      TEXT          NOT NULL REFERENCES produtos_mestre(codigo_produto),
  lote                TEXT,
  data_entrada        DATE          NOT NULL DEFAULT CURRENT_DATE,
  data_validade       DATE,
  quantidade          NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  quantidade_atual    NUMERIC(12,3) NOT NULL CHECK (quantidade_atual >= 0),
  custo_unitario      NUMERIC(12,4),
  numero_nfe          TEXT,
  cnpj_fornecedor     TEXT          REFERENCES fornecedores(cnpj_fornecedor),
  local_armazenamento TEXT,
  usuario_lancamento  INTEGER       REFERENCES usuarios(id),
  observacao          TEXT,
  ativo               BOOLEAN       NOT NULL DEFAULT true,
  criado_em           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lotes_produto  ON lotes_estoque(codigo_produto);
CREATE INDEX IF NOT EXISTS idx_lotes_validade ON lotes_estoque(data_validade);
CREATE INDEX IF NOT EXISTS idx_lotes_ativo    ON lotes_estoque(ativo);

-- ───────────────────────────────────────────────────────────────────────
-- PERDAS
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS perdas (
  id                       SERIAL PRIMARY KEY,
  codigo_produto           TEXT          NOT NULL REFERENCES produtos_mestre(codigo_produto),
  lote_id                  INTEGER       REFERENCES lotes_estoque(id),
  data_perda               DATE          NOT NULL DEFAULT CURRENT_DATE,
  quantidade               NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  motivo                   TEXT,
  tipo_motivo              TEXT,
  valor_estimado           NUMERIC(12,2),
  preco_custo_referencia   NUMERIC(12,4),
  funcionario_responsavel  TEXT,
  usuario_lancamento       INTEGER       REFERENCES usuarios(id),
  observacao               TEXT,
  criado_em                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perdas_produto ON perdas(codigo_produto);
CREATE INDEX IF NOT EXISTS idx_perdas_data    ON perdas(data_perda);

-- ───────────────────────────────────────────────────────────────────────
-- KITS
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kits (
  id_kit          SERIAL PRIMARY KEY,
  nome_kit        TEXT          NOT NULL,
  tipo_kit        TEXT          NOT NULL DEFAULT 'Kit Churrasco',
  descricao       TEXT,
  preco_venda     NUMERIC(12,2),
  custo_total     NUMERIC(12,4),
  margem_percent  NUMERIC(8,2),
  ativo           BOOLEAN       NOT NULL DEFAULT true,
  usuario_criacao INTEGER       REFERENCES usuarios(id),
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────
-- KIT_ITENS
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kit_itens (
  id              SERIAL PRIMARY KEY,
  id_kit          INTEGER       NOT NULL REFERENCES kits(id_kit) ON DELETE CASCADE,
  codigo_produto  TEXT          NOT NULL REFERENCES produtos_mestre(codigo_produto),
  quantidade      NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  custo_unitario  NUMERIC(12,4),
  custo_total_item NUMERIC(12,4),
  UNIQUE (id_kit, codigo_produto)
);

CREATE INDEX IF NOT EXISTS idx_kit_itens_kit     ON kit_itens(id_kit);
CREATE INDEX IF NOT EXISTS idx_kit_itens_produto ON kit_itens(codigo_produto);

-- ───────────────────────────────────────────────────────────────────────
-- BOLETOS
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boletos (
  id                       SERIAL PRIMARY KEY,
  cnpj_fornecedor          TEXT          REFERENCES fornecedores(cnpj_fornecedor),
  razao_social_fornecedor  TEXT,
  numero_documento         TEXT,
  numero_nfe               TEXT,
  data_emissao             DATE,
  data_vencimento          DATE          NOT NULL,
  valor                    NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  status                   TEXT          NOT NULL DEFAULT 'pendente'
                           CHECK (status IN ('pendente','pago','vencido','cancelado')),
  data_pagamento           DATE,
  classificacao_contabil   TEXT,
  centro_custo             TEXT,
  forma_pagamento          TEXT,
  banco                    TEXT,
  observacao               TEXT,
  usuario_lancamento       INTEGER       REFERENCES usuarios(id),
  criado_em                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  atualizado_em            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_boletos_vencimento ON boletos(data_vencimento);
CREATE INDEX IF NOT EXISTS idx_boletos_status     ON boletos(status);
CREATE INDEX IF NOT EXISTS idx_boletos_fornecedor ON boletos(cnpj_fornecedor);

-- ═══════════════════════════════════════════════════════════════════════
-- TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.atualizado_em = NOW(); RETURN NEW; END; $$;

DO $$ BEGIN CREATE TRIGGER trg_usuarios_upd     BEFORE UPDATE ON usuarios       FOR EACH ROW EXECUTE FUNCTION set_atualizado_em(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_fornecedores_upd BEFORE UPDATE ON fornecedores   FOR EACH ROW EXECUTE FUNCTION set_atualizado_em(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_produtos_upd     BEFORE UPDATE ON produtos_mestre FOR EACH ROW EXECUTE FUNCTION set_atualizado_em(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_lotes_upd        BEFORE UPDATE ON lotes_estoque  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_kits_upd         BEFORE UPDATE ON kits           FOR EACH ROW EXECUTE FUNCTION set_atualizado_em(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_boletos_upd      BEFORE UPDATE ON boletos        FOR EACH ROW EXECUTE FUNCTION set_atualizado_em(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION calcular_valor_perda()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_custo NUMERIC;
BEGIN
  IF NEW.valor_estimado IS NULL THEN
    SELECT preco_custo INTO v_custo FROM produtos_mestre WHERE codigo_produto = NEW.codigo_produto;
    IF v_custo IS NOT NULL THEN
      NEW.valor_estimado          := ROUND(NEW.quantidade * v_custo, 2);
      NEW.preco_custo_referencia  := v_custo;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DO $$ BEGIN CREATE TRIGGER trg_perdas_custo BEFORE INSERT ON perdas FOR EACH ROW EXECUTE FUNCTION calcular_valor_perda(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION calcular_custo_item_kit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_custo NUMERIC;
BEGIN
  IF NEW.custo_unitario IS NULL THEN
    SELECT preco_custo INTO v_custo FROM produtos_mestre WHERE codigo_produto = NEW.codigo_produto;
    NEW.custo_unitario := v_custo;
  END IF;
  NEW.custo_total_item := ROUND(COALESCE(NEW.custo_unitario, 0) * NEW.quantidade, 4);
  RETURN NEW;
END; $$;
DO $$ BEGIN CREATE TRIGGER trg_kit_item_custo BEFORE INSERT OR UPDATE ON kit_itens FOR EACH ROW EXECUTE FUNCTION calcular_custo_item_kit(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION atualizar_custo_kit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_id INTEGER; v_custo NUMERIC; v_venda NUMERIC;
BEGIN
  v_id := COALESCE(NEW.id_kit, OLD.id_kit);
  SELECT ROUND(COALESCE(SUM(custo_total_item),0),4) INTO v_custo FROM kit_itens WHERE id_kit = v_id;
  SELECT preco_venda INTO v_venda FROM kits WHERE id_kit = v_id;
  UPDATE kits SET
    custo_total    = v_custo,
    margem_percent = CASE WHEN v_venda > 0 AND v_custo > 0
                          THEN ROUND((v_venda - v_custo) / v_venda * 100, 2)
                          ELSE NULL END
  WHERE id_kit = v_id;
  RETURN COALESCE(NEW, OLD);
END; $$;
DO $$ BEGIN CREATE TRIGGER trg_kit_custo_total AFTER INSERT OR UPDATE OR DELETE ON kit_itens FOR EACH ROW EXECUTE FUNCTION atualizar_custo_kit(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- VIEWS
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW vw_status_base AS
SELECT
  COUNT(*)                                                AS total_produtos,
  COUNT(*) FILTER (WHERE ativo)                          AS produtos_ativos,
  MAX(data_ultima_importacao)                            AS ultima_importacao,
  EXTRACT(EPOCH FROM (NOW() - MAX(data_ultima_importacao))) / 86400 AS dias_desde_importacao,
  CASE WHEN MAX(data_ultima_importacao) IS NULL THEN true
       WHEN (NOW() - MAX(data_ultima_importacao)) > INTERVAL '7 days' THEN true
       ELSE false END                                    AS base_desatualizada
FROM produtos_mestre;

CREATE OR REPLACE VIEW vw_produtos_validade AS
SELECT
  l.codigo_produto,
  pm.descricao_produto,
  pm.categoria,
  pm.unidade,
  SUM(l.quantidade_atual)                           AS estoque_total,
  MIN(l.data_validade)                              AS proxima_validade,
  MIN(l.data_validade) - CURRENT_DATE              AS dias_para_vencer,
  CASE
    WHEN MIN(l.data_validade) < CURRENT_DATE            THEN 'vencido'
    WHEN MIN(l.data_validade) <= CURRENT_DATE + 7       THEN 'critico'
    WHEN MIN(l.data_validade) <= CURRENT_DATE + 15      THEN 'urgente'
    WHEN MIN(l.data_validade) <= CURRENT_DATE + 30      THEN 'atencao'
    ELSE 'ok'
  END                                               AS status_validade
FROM lotes_estoque l
JOIN produtos_mestre pm ON pm.codigo_produto = l.codigo_produto
WHERE l.quantidade_atual > 0 AND l.ativo = true AND l.data_validade IS NOT NULL
GROUP BY l.codigo_produto, pm.descricao_produto, pm.categoria, pm.unidade;

CREATE OR REPLACE VIEW vw_perdas_mes_atual AS
SELECT
  p.codigo_produto,
  pm.descricao_produto,
  pm.categoria,
  COUNT(*)                        AS ocorrencias,
  SUM(p.quantidade)               AS quantidade_total,
  ROUND(SUM(p.valor_estimado),2)  AS valor_total_perdido
FROM perdas p
JOIN produtos_mestre pm ON pm.codigo_produto = p.codigo_produto
WHERE DATE_TRUNC('month', p.data_perda) = DATE_TRUNC('month', NOW())
GROUP BY p.codigo_produto, pm.descricao_produto, pm.categoria;

CREATE OR REPLACE VIEW vw_boletos_abertos AS
SELECT
  b.*,
  COALESCE(f.nome_fantasia, f.razao_social, b.razao_social_fornecedor) AS fornecedor_nome,
  CURRENT_DATE - b.data_vencimento                                      AS dias_atraso
FROM boletos b
LEFT JOIN fornecedores f ON f.cnpj_fornecedor = b.cnpj_fornecedor
WHERE b.status IN ('pendente','vencido')
ORDER BY b.data_vencimento ASC;

-- ═══════════════════════════════════════════════════════════════════════
-- FUNÇÃO UTILITÁRIA
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION atualizar_status_boletos_vencidos()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE boletos SET status = 'vencido', atualizado_em = NOW()
  WHERE status = 'pendente' AND data_vencimento < CURRENT_DATE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

-- ═══════════════════════════════════════════════════════════════════════
-- USUÁRIO ADMIN INICIAL
-- Execute o comando abaixo no terminal para gerar o hash e depois
-- substitua o valor no INSERT:
--
--   node -e "const b=require('bcryptjs');b.hash('gabriel1306',12).then(console.log)"
--
-- Ou rode: npm run seed  (após criar o arquivo seed.js abaixo)
-- ═══════════════════════════════════════════════════════════════════════
-- INSERT INTO usuarios (nome, email, senha_hash, perfil)
-- VALUES ('Administrador','admin@bombeef.com.br','COLOQUE_O_HASH_AQUI','admin')
-- ON CONFLICT (email) DO NOTHING;
