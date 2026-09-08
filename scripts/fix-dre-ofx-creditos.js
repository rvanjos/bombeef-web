const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
const CNPJ_PROPRIO = '46237080000102';
const CNPJ_PROPRIO_FMT = '46.237.080/0001-02';
const NOME_PROPRIO = 'AR BOUTIQUE DE CARNES LTDA';
const CAT_CREDITO_EXTRATO = 'Transferência entre contas';

async function existeTabela(client, tabela) {
  const { rows } = await client.query('SELECT to_regclass($1) AS tabela', [`public.${tabela}`]);
  return !!rows[0]?.tabela;
}

function valorTx(t) {
  const raw = t?.valor ?? t?.value ?? t?.amount ?? t?.trnamt ?? 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fonteTx(t) {
  return String(t?.fonte ?? t?.source ?? t?.origem ?? '').trim().toUpperCase();
}

async function main() {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // O routes/dre.js ainda contém seeds legados com o CNPJ da própria empresa
    // associado a nomes incorretos (ARTMILL/B2B). Este trigger impede que qualquer
    // seed futuro volte a corromper o lookup, mesmo antes de removermos essas linhas.
    if (await existeTabela(client, 'fornecedores_lookup')) {
      await client.query(`
        CREATE OR REPLACE FUNCTION bb_fornecedor_lookup_proprio()
        RETURNS trigger AS $$
        BEGIN
          IF REGEXP_REPLACE(COALESCE(NEW.cnpj_num, NEW.cnpj, ''), '[^0-9]', '', 'g') = '${CNPJ_PROPRIO}' THEN
            NEW.cnpj_num := '${CNPJ_PROPRIO}';
            NEW.cnpj := '${CNPJ_PROPRIO_FMT}';
            NEW.nome := '${NOME_PROPRIO}';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query('DROP TRIGGER IF EXISTS trg_bb_fornecedor_lookup_proprio ON fornecedores_lookup');
      await client.query(`
        CREATE TRIGGER trg_bb_fornecedor_lookup_proprio
        BEFORE INSERT OR UPDATE ON fornecedores_lookup
        FOR EACH ROW EXECUTE FUNCTION bb_fornecedor_lookup_proprio()
      `);
      await client.query(`
        INSERT INTO fornecedores_lookup (cnpj_num, cnpj, nome)
        VALUES ($1, $2, $3)
        ON CONFLICT (cnpj_num) DO UPDATE
        SET cnpj=EXCLUDED.cnpj, nome=EXCLUDED.nome
      `, [CNPJ_PROPRIO, CNPJ_PROPRIO_FMT, NOME_PROPRIO]);
    }

    if (await existeTabela(client, 'dre_lancamentos')) {
      // No modo competência, as receitas oficiais vêm do XMenu. Portanto crédito
      // positivo do extrato é conferência/transferência bancária, não despesa a classificar.
      const { rowCount: creditos } = await client.query(`
        UPDATE dre_lancamentos
        SET ignorar = true,
            categoria = CASE
              WHEN COALESCE(TRIM(categoria),'') = '' THEN $1
              ELSE categoria
            END
        WHERE UPPER(COALESCE(fonte,''))='EXTRATO'
          AND valor > 0
          AND (
            COALESCE(ignorar,false)=false
            OR COALESCE(TRIM(categoria),'')=''
          )
      `, [CAT_CREDITO_EXTRATO]);

      const { rowCount: nomes } = await client.query(`
        UPDATE dre_lancamentos
        SET razao_social=$1
        WHERE UPPER(COALESCE(fonte,''))='EXTRATO'
          AND (
            REGEXP_REPLACE(COALESCE(cnpj_doc,''), '[^0-9]', '', 'g')=$2
            OR lancamento ILIKE 'PIX RECEBIDO AR BOUT%'
            OR UPPER(COALESCE(razao_social,'')) IN ('ARTMILL ACESSORIOS LTDA EPP','B2B - HOME23 COMERCIO')
          )
      `, [NOME_PROPRIO, CNPJ_PROPRIO]);

      await client.query(`
        CREATE OR REPLACE FUNCTION bb_dre_ignorar_credito_extrato()
        RETURNS trigger AS $$
        BEGIN
          IF UPPER(COALESCE(NEW.fonte,''))='EXTRATO' AND NEW.valor > 0 THEN
            NEW.ignorar := true;
            IF COALESCE(TRIM(NEW.categoria),'') = '' THEN
              NEW.categoria := '${CAT_CREDITO_EXTRATO}';
            END IF;
          END IF;
          IF REGEXP_REPLACE(COALESCE(NEW.cnpj_doc,''), '[^0-9]', '', 'g')='${CNPJ_PROPRIO}'
             OR UPPER(COALESCE(NEW.razao_social,'')) IN ('ARTMILL ACESSORIOS LTDA EPP','B2B - HOME23 COMERCIO') THEN
            NEW.razao_social := '${NOME_PROPRIO}';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query('DROP TRIGGER IF EXISTS trg_bb_dre_ignorar_credito_extrato ON dre_lancamentos');
      await client.query(`
        CREATE TRIGGER trg_bb_dre_ignorar_credito_extrato
        BEFORE INSERT OR UPDATE ON dre_lancamentos
        FOR EACH ROW EXECUTE FUNCTION bb_dre_ignorar_credito_extrato()
      `);

      console.log(`[dre/ofx-fix] créditos normalizados: ${creditos}; nomes corrigidos: ${nomes}`);
    }

    // Corrige as sessões já gravadas. Além de ignorar, preenche categoria não-operacional
    // para retirar o crédito de telas legadas que contam "sem categoria" sem olhar ignorar.
    if (await existeTabela(client, 'dre_sessoes')) {
      const { rows } = await client.query(`SELECT id, dados_json FROM dre_sessoes WHERE dados_json IS NOT NULL`);
      let sessoesAlteradas = 0;
      let transacoesAlteradas = 0;
      for (const s of rows) {
        const dados = typeof s.dados_json === 'string' ? JSON.parse(s.dados_json) : s.dados_json;
        const txs = Array.isArray(dados?.transactions) ? dados.transactions : [];
        let mudou = false;
        for (const t of txs) {
          const valor = valorTx(t);
          const fonte = fonteTx(t);
          let mudouTx = false;

          if (fonte === 'EXTRATO' && valor > 0) {
            if (t.ignorar !== true) { t.ignorar = true; mudouTx = true; }
            if (!String(t.categoria || '').trim()) { t.categoria = CAT_CREDITO_EXTRATO; mudouTx = true; }
          }

          const cnpj = String(t.cnpjDoc ?? t.cnpj_doc ?? t.cnpj ?? '').replace(/\D/g, '');
          const lanc = String(t.lancamento ?? t.memo ?? '').toUpperCase();
          const razao = String(t.razaoSocial ?? t.razao_social ?? '').toUpperCase();
          const ehProprio = cnpj === CNPJ_PROPRIO || lanc.startsWith('PIX RECEBIDO AR BOUT') || razao === 'ARTMILL ACESSORIOS LTDA EPP' || razao === 'B2B - HOME23 COMERCIO';
          if (ehProprio) {
            if ('razaoSocial' in t || !('razao_social' in t)) {
              if (t.razaoSocial !== NOME_PROPRIO) { t.razaoSocial = NOME_PROPRIO; mudouTx = true; }
            }
            if ('razao_social' in t && t.razao_social !== NOME_PROPRIO) { t.razao_social = NOME_PROPRIO; mudouTx = true; }
          }

          if (mudouTx) { mudou = true; transacoesAlteradas++; }
        }
        if (mudou) {
          await client.query('UPDATE dre_sessoes SET dados_json=$1::jsonb, atualizado_em=NOW() WHERE id=$2', [JSON.stringify(dados), s.id]);
          sessoesAlteradas++;
        }
      }
      console.log(`[dre/ofx-fix] sessões reparadas: ${sessoesAlteradas}; transações reparadas: ${transacoesAlteradas}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    try { if (client) await client.query('ROLLBACK'); } catch (_) {}
    console.error('[dre/ofx-fix] correção adiada:', err.message);
  } finally {
    try { if (client) client.release(); } catch (_) {}
    await pool.end().catch(()=>{});
  }
}

main().catch(err => console.error('[dre/ofx-fix] falha não bloqueante:', err.message));
