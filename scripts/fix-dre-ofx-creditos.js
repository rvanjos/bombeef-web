const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
const CNPJ_PROPRIO = '46237080000102';
const NOME_PROPRIO = 'AR BOUTIQUE DE CARNES LTDA';

async function existeTabela(client, tabela) {
  const { rows } = await client.query('SELECT to_regclass($1) AS tabela', [`public.${tabela}`]);
  return !!rows[0]?.tabela;
}

async function main() {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    if (await existeTabela(client, 'fornecedores_lookup')) {
      await client.query(`
        INSERT INTO fornecedores_lookup (cnpj_num, cnpj, nome)
        VALUES ($1, '46.237.080/0001-02', $2)
        ON CONFLICT (cnpj_num) DO UPDATE
        SET cnpj=EXCLUDED.cnpj, nome=EXCLUDED.nome
      `, [CNPJ_PROPRIO, NOME_PROPRIO]);
    }

    if (await existeTabela(client, 'dre_lancamentos')) {
      // No modo de competência atual, receitas vêm do XMenu. Créditos bancários
      // do OFX servem para conferência de caixa e não devem virar despesa pendente.
      const { rowCount: creditos } = await client.query(`
        UPDATE dre_lancamentos
        SET ignorar=true
        WHERE fonte='EXTRATO' AND valor > 0 AND COALESCE(ignorar,false)=false
      `);

      // Repara o nome incorreto já gravado para transferências da própria empresa.
      const { rowCount: nomes } = await client.query(`
        UPDATE dre_lancamentos
        SET razao_social=$1
        WHERE fonte='EXTRATO'
          AND valor > 0
          AND (
            lancamento ILIKE 'PIX RECEBIDO AR BOUT%'
            OR razao_social IN ('ARTMILL ACESSORIOS LTDA EPP','B2B - HOME23 COMERCIO')
          )
      `, [NOME_PROPRIO]);

      await client.query(`
        CREATE OR REPLACE FUNCTION bb_dre_ignorar_credito_extrato()
        RETURNS trigger AS $$
        BEGIN
          IF UPPER(COALESCE(NEW.fonte,''))='EXTRATO' AND NEW.valor > 0 THEN
            NEW.ignorar := true;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query('DROP TRIGGER IF EXISTS trg_bb_dre_ignorar_credito_extrato ON dre_lancamentos');
      await client.query(`
        CREATE TRIGGER trg_bb_dre_ignorar_credito_extrato
        BEFORE INSERT ON dre_lancamentos
        FOR EACH ROW EXECUTE FUNCTION bb_dre_ignorar_credito_extrato()
      `);

      console.log(`[dre/ofx-fix] créditos ignorados: ${creditos}; nomes corrigidos: ${nomes}`);
    }

    // Corrige também sessões JSON já salvas, para a tela atual refletir a correção
    // sem exigir apagar sessão ou reimportar o OFX.
    if (await existeTabela(client, 'dre_sessoes')) {
      const { rows } = await client.query(`SELECT id, dados_json FROM dre_sessoes WHERE dados_json IS NOT NULL`);
      let sessoesAlteradas = 0;
      for (const s of rows) {
        const dados = typeof s.dados_json === 'string' ? JSON.parse(s.dados_json) : s.dados_json;
        const txs = Array.isArray(dados?.transactions) ? dados.transactions : [];
        let mudou = false;
        for (const t of txs) {
          const valor = Number(t.valor || 0);
          if (String(t.fonte || '').toUpperCase() === 'EXTRATO' && valor > 0 && t.ignorar !== true) {
            t.ignorar = true;
            mudou = true;
          }
          const cnpj = String(t.cnpjDoc || '').replace(/\D/g, '');
          const lanc = String(t.lancamento || '').toUpperCase();
          const razao = String(t.razaoSocial || '').toUpperCase();
          if (valor > 0 && (cnpj === CNPJ_PROPRIO || lanc.startsWith('PIX RECEBIDO AR BOUT') || razao === 'ARTMILL ACESSORIOS LTDA EPP' || razao === 'B2B - HOME23 COMERCIO')) {
            if (t.razaoSocial !== NOME_PROPRIO) {
              t.razaoSocial = NOME_PROPRIO;
              mudou = true;
            }
          }
        }
        if (mudou) {
          await client.query('UPDATE dre_sessoes SET dados_json=$1::jsonb, atualizado_em=NOW() WHERE id=$2', [JSON.stringify(dados), s.id]);
          sessoesAlteradas++;
        }
      }
      console.log(`[dre/ofx-fix] sessões reparadas: ${sessoesAlteradas}`);
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
