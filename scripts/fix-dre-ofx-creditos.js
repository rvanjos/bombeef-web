const { Pool } = require('pg');

const ssl = process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
const CNPJ_PROPRIO = '46237080000102';
const CNPJ_PROPRIO_FMT = '46.237.080/0001-02';
const NOME_PROPRIO = 'AR BOUTIQUE DE CARNES LTDA';
const CAT_CREDITO_EXTRATO = 'Transferência entre contas';
const CAT_RECEITA = 'VENDAS DE MERCADORIAS';

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

function norm(v) {
  return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
}
function dataTx(t) {
  const s=String(t?.data ?? t?.date ?? t?.data_lanc ?? '').slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function diffDias(a,b) {
  if(!a||!b) return 999;
  return Math.abs((new Date(a+'T12:00:00Z')-new Date(b+'T12:00:00Z'))/86400000);
}
function ehUuidFitid(t) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(t?.fitid||''));
}
function setContaPagBank(t) {
  let mudou=false;
  if(t.bankId!=='290'){t.bankId='290';mudou=true;}
  if(t.banco!=='PagBank'){t.banco='PagBank';mudou=true;}
  if(t.contaBancaria!=='PagBank · 43333819-1'){t.contaBancaria='PagBank · 43333819-1';mudou=true;}
  if(!t.acctId){t.acctId='43333819-1';mudou=true;}
  return mudou;
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
      // Hotfix: versões anteriores marcaram TODO crédito positivo de extrato como
      // ignorado para evitar duplicidade com o XMenu. Isso estava errado: o motor
      // de Competência já substitui a receita pelo faturamento oficial, enquanto
      // o modo Caixa precisa manter os recebimentos bancários ativos.
      //
      // Reativa apenas créditos já classificados explicitamente como receita,
      // preservando transferências e demais créditos neutros/ignorados.
      const { rowCount: receitasReativadas } = await client.query(`
        UPDATE dre_lancamentos
        SET ignorar = false
        WHERE UPPER(COALESCE(fonte,''))='EXTRATO'
          AND valor > 0
          AND categoria = $1
          AND COALESCE(ignorar,false)=true
      `, [CAT_RECEITA]);

      const { rowCount: nomes } = await client.query(`
        UPDATE dre_lancamentos
        SET razao_social=$1
        WHERE UPPER(COALESCE(fonte,''))='EXTRATO'
          AND (
            lancamento ILIKE 'PIX RECEBIDO AR BOUT%'
            OR UPPER(COALESCE(razao_social,'')) IN ('ARTMILL ACESSORIOS LTDA EPP','B2B - HOME23 COMERCIO')
          )
      `, [NOME_PROPRIO]);

      // Remove a regra antiga que forçava ignorar=true em todo crédito positivo.
      await client.query('DROP TRIGGER IF EXISTS trg_bb_dre_ignorar_credito_extrato ON dre_lancamentos');
      await client.query('DROP FUNCTION IF EXISTS bb_dre_ignorar_credito_extrato()');

      console.log(`[dre/ofx-fix] receitas reativadas: ${receitasReativadas}; nomes corrigidos: ${nomes}`);
    }

    // Corrige as sessões já gravadas e migra o OFX PagBank que já foi importado.
    // Regra financeira:
    // - Vendas - Disponível = entrada real da venda no PagBank.
    // - Pix enviado - O Acougue Bom Beef Valinhos = transferência interna.
    // - crédito correspondente no Itaú = mesma transferência interna, não nova receita.
    if (await existeTabela(client, 'dre_sessoes')) {
      const { rows } = await client.query(`SELECT id, dados_json FROM dre_sessoes WHERE dados_json IS NOT NULL`);
      const sessoes = rows.map(s=>({
        id:s.id,
        dados:typeof s.dados_json === 'string' ? JSON.parse(s.dados_json) : s.dados_json
      }));
      const refs=[];
      for(const s of sessoes){
        const txs=Array.isArray(s.dados?.transactions)?s.dados.transactions:[];
        for(const t of txs) refs.push({sessaoId:s.id,s,t});
      }

      // Identifica transações PagBank legadas pelo FITID UUID e pelos padrões exclusivos do arquivo.
      for(const r of refs){
        const t=r.t, lanc=norm(t.lancamento ?? t.memo ?? '');
        if(ehUuidFitid(t) || /^VENDAS - DISPONIVEL\b/.test(lanc) || /^PIX ENVIADO - /.test(lanc)){
          if(setContaPagBank(t)) r.s._mudou=true;
          if(/^VENDAS - DISPONIVEL\b/.test(lanc) && !String(t.categoria||'').trim()){
            t.categoria=CAT_RECEITA; r.s._mudou=true;
          }
        }
      }

      const saidasProprias=refs.filter(r=>{
        const t=r.t;
        const texto=norm([t.lancamento,t.memo,t.razaoSocial,t.razao_social].filter(Boolean).join(' '));
        return valorTx(t)<0
          && norm(t.banco)==='PAGBANK'
          && /PIX ENVIADO.*O ACOUGUE BOM BEEF VALINHOS/.test(texto);
      });
      const entradasItau=refs.filter(r=>{
        const t=r.t;
        const texto=norm([t.lancamento,t.memo,t.razaoSocial,t.razao_social].filter(Boolean).join(' '));
        return valorTx(t)>0
          && !ehUuidFitid(t)
          && (
            /PIX RECEBIDO.*AR BOUT/.test(texto)
            || texto.includes(norm(NOME_PROPRIO))
          );
      });

      let paresTransferencia=0;
      const chaveRef=r=>String(r?.t?.fitid||'') || [dataTx(r?.t),Math.round(Math.abs(valorTx(r?.t))*100),norm(r?.t?.lancamento||'')].join('|');
      const uniqPorFitid=lista=>{
        const m=new Map();
        for(const r of lista){const k=chaveRef(r);if(!m.has(k))m.set(k,r);}
        return [...m.values()];
      };
      const saidasUnicas=uniqPorFitid(saidasProprias);
      const entradasUnicas=uniqPorFitid(entradasItau);
      const usados=new Set();
      for(const s of saidasUnicas){
        const val=Math.round(Math.abs(valorTx(s.t))*100);
        const dt=dataTx(s.t);
        const candidatos=entradasUnicas
          .filter(e=>!usados.has(chaveRef(e)))
          .filter(e=>Math.round(Math.abs(valorTx(e.t))*100)===val && diffDias(dt,dataTx(e.t))<=3)
          .sort((a,b)=>diffDias(dt,dataTx(a.t))-diffDias(dt,dataTx(b.t)));
        if(candidatos.length!==1) continue;
        const e=candidatos[0]; usados.add(chaveRef(e));
        const sKey=chaveRef(s),eKey=chaveRef(e);
        const refsPar=refs.filter(r=>chaveRef(r)===sKey || chaveRef(r)===eKey);
        for(const r of refsPar){
          const parFitid=chaveRef(r)===sKey ? String(e.t.fitid||'') : String(s.t.fitid||'');
          if(r.t.categoria!==CAT_CREDITO_EXTRATO){r.t.categoria=CAT_CREDITO_EXTRATO;r.s._mudou=true;}
          if(r.t.ignorar===true){r.t.ignorar=false;r.s._mudou=true;}
          if(r.t.transferenciaInterna!==true){r.t.transferenciaInterna=true;r.s._mudou=true;}
          if(r.t.transferenciaParFitid!==parFitid){r.t.transferenciaParFitid=parFitid;r.s._mudou=true;}
        }
        paresTransferencia++;
      }

      let sessoesAlteradas=0,transacoesAlteradas=0;
      for(const s of sessoes){
        const txs=Array.isArray(s.dados?.transactions)?s.dados.transactions:[];
        let mudou=!!s._mudou;
        for(const t of txs){
          const valor=valorTx(t),fonte=fonteTx(t);
          if(fonte==='EXTRATO' && valor>0 && String(t.categoria||'').trim()===CAT_RECEITA && t.ignorar===true){
            t.ignorar=false; mudou=true; transacoesAlteradas++;
          }
          const cnpj=String(t.cnpjDoc ?? t.cnpj_doc ?? t.cnpj ?? '').replace(/\D/g,'');
          const lanc=norm(t.lancamento ?? t.memo ?? '');
          const razao=norm(t.razaoSocial ?? t.razao_social ?? '');
          const ehProprio=cnpj===CNPJ_PROPRIO || lanc.startsWith('PIX RECEBIDO AR BOUT') || razao==='ARTMILL ACESSORIOS LTDA EPP' || razao==='B2B - HOME23 COMERCIO';
          if(ehProprio){
            if('razaoSocial' in t || !('razao_social' in t)){
              if(t.razaoSocial!==NOME_PROPRIO){t.razaoSocial=NOME_PROPRIO;mudou=true;transacoesAlteradas++;}
            }
            if('razao_social' in t && t.razao_social!==NOME_PROPRIO){t.razao_social=NOME_PROPRIO;mudou=true;transacoesAlteradas++;}
          }
        }
        if(mudou){
          delete s.dados._mudou;
          await client.query('UPDATE dre_sessoes SET dados_json=$1::jsonb, atualizado_em=NOW() WHERE id=$2',[JSON.stringify(s.dados),s.id]);
          sessoesAlteradas++;
        }
      }

      // Espelho relacional: usa descrições inequívocas. A fonte canônica continua
      // sendo dados_json; esta atualização mantém telas auxiliares coerentes.
      if (await existeTabela(client, 'dre_lancamentos')) {
        await client.query(`
          UPDATE dre_lancamentos
          SET categoria=$1, ignorar=false
          WHERE valor<0
            AND UPPER(COALESCE(fonte,''))='EXTRATO'
            AND UPPER(COALESCE(lancamento,'')) LIKE 'PIX ENVIADO - O ACOUGUE BOM BEEF VALINHOS%'
        `,[CAT_CREDITO_EXTRATO]).catch(()=>{});
        await client.query(`
          UPDATE dre_lancamentos
          SET categoria=$1, ignorar=false
          WHERE valor>0
            AND UPPER(COALESCE(fonte,''))='EXTRATO'
            AND UPPER(COALESCE(lancamento,'')) LIKE 'PIX RECEBIDO AR BOUT%'
        `,[CAT_CREDITO_EXTRATO]).catch(()=>{});
      }

      console.log(`[dre/ofx-fix] sessões reparadas: ${sessoesAlteradas}; ajustes: ${transacoesAlteradas}; saídas próprias PagBank: ${saidasProprias.length}/${saidasUnicas.length} únicas; entradas Itaú candidatas: ${entradasItau.length}/${entradasUnicas.length} únicas; transferências PagBank↔Itaú conciliadas: ${paresTransferencia}`);
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
