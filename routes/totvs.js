const express    = require('express');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const XLSX       = require('xlsx');
const autenticar = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function limparPreco(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[R$\s]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function encontrarCol(obj, candidatos) {
  const chaves    = Object.keys(obj);
  const chavesLow = chaves.map(k => k.toLowerCase().trim().replace(/[^a-z0-9]/g, ''));
  for (const c of candidatos) {
    const norm = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idx  = chavesLow.findIndex(k => k.includes(norm));
    if (idx >= 0) return chaves[idx];
  }
  return null;
}

// Detecta encoding do buffer e retorna string
function bufferToString(buf) {
  // UTF-16 LE tem BOM FF FE
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le');
  // UTF-16 BE tem BOM FE FF
  if (buf[0] === 0xFE && buf[1] === 0xFF) {
    // Troca bytes e converte
    const swapped = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length - 1; i += 2) { swapped[i] = buf[i+1]; swapped[i+1] = buf[i]; }
    return swapped.toString('utf16le');
  }
  // UTF-8 BOM
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf-8');
  // Tenta UTF-8, fallback para latin1
  try {
    const s = buf.toString('utf-8');
    // Verifica se tem replacement characters (sinal de encoding errado)
    if (!s.includes('\uFFFD')) return s;
  } catch(e) {}
  return buf.toString('latin1');
}

// Remove linhas de cabeçalho extras antes dos dados reais
// O TOTVS Chef Web exporta filtros nas primeiras linhas antes do cabeçalho de colunas
function removerLinhasExtra(texto, delimitador) {
  const linhas = texto.split('\n').map(l => l.replace(/\r/g, ''));
  // Procura a primeira linha que contém o delimitador mais de 2 vezes (é o cabeçalho real)
  let inicio = 0;
  for (let i = 0; i < linhas.length; i++) {
    const ocorrencias = (linhas[i].match(new RegExp('\\' + delimitador, 'g')) || []).length;
    if (ocorrencias >= 3) { inicio = i; break; }
  }
  return linhas.slice(inicio).join('\n');
}

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /api/totvs/status ────────────────────────────────
  router.get('/status', autenticar(), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM vw_status_base');
      res.json(rows[0] || {});
    } catch (err) {
      console.error('[totvs/status]', err.message);
      res.status(500).json({ erro: 'Erro ao verificar status.' });
    }
  });

  // ── GET /api/totvs/historico ─────────────────────────────
  router.get('/historico', autenticar(['admin','gerente']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT i.id, i.data_importacao, i.nome_arquivo, i.total_registros,
                i.registros_inseridos, i.registros_atualizados, i.registros_erro,
                i.status, u.nome AS usuario_nome
         FROM importacoes_totvs i
         LEFT JOIN usuarios u ON u.id = i.usuario_responsavel
         ORDER BY i.data_importacao DESC LIMIT 30`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
  });

  // ── GET /api/totvs/log/:id ───────────────────────────────
  router.get('/log/:id', autenticar(['admin','gerente']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT log_importacao FROM importacoes_totvs WHERE id = $1',
        [req.params.id]
      );
      res.json(rows[0]?.log_importacao || []);
    } catch (err) {
      res.status(500).json({ erro: 'Erro ao buscar log.' });
    }
  });

  // ── POST /api/totvs/importar ─────────────────────────────
  router.post('/importar', autenticar(['admin','gerente']), upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado.' });

    const client = await pool.connect();
    const log    = [];
    let inseridos = 0, atualizados = 0, erros = 0, importacaoId;

    try {
      const { rows: [imp] } = await client.query(
        `INSERT INTO importacoes_totvs (nome_arquivo, tipo_relatorio, status, usuario_responsavel)
         VALUES ($1, 'produtos', 'processando', $2) RETURNING id`,
        [req.file.originalname, req.usuario.id]
      );
      importacaoId = imp.id;

      // ── Ler arquivo ──────────────────────────────────────
      let registros = [];
      const ext = req.file.originalname.split('.').pop().toLowerCase();

      if (['csv', 'txt'].includes(ext)) {
        // Detecta encoding automaticamente (suporta UTF-16 do TOTVS Chef Web)
        const texto = bufferToString(req.file.buffer);
        const delim = texto.includes(';') ? ';' : ',';
        // Remove linhas de cabeçalho extras (filtros exportados pelo TOTVS)
        const textoLimpo = removerLinhasExtra(texto, delim);
        registros = parse(textoLimpo, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          delimiter: delim,
          relax_column_count: true,
        });
      } else if (['xlsx', 'xls'].includes(ext)) {
        const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        registros = XLSX.utils.sheet_to_json(ws, { defval: '' });
      } else {
        throw new Error('Formato não suportado. Use CSV, TXT ou XLSX.');
      }

      if (!registros.length) throw new Error('Arquivo vazio ou sem dados válidos.');

      // ── Mapear colunas ───────────────────────────────────
      const primeira = registros[0];
      const mapa = {
        codigo:    encontrarCol(primeira, ['codigoproduto','codigo','cod','code','id produto','item']),
        descricao: encontrarCol(primeira, ['nomeproduto','descricao produto','descricao','nome produto','produto','desc']),
        desc_red:  encontrarCol(primeira, ['reduzida','abrev','abreviada','desc reduz']),
        custo:     encontrarCol(primeira, ['precocompra','preco custo','precusto','custo unit','custo','pc']),
        venda:     encontrarCol(primeira, ['precovenda','preco venda','pvenda','venda','pv']),
        categoria: encontrarCol(primeira, ['categoria','grupo','classe','tipo produto']),
        unidade:   encontrarCol(primeira, ['unidade','un','und','medida']),
        ativo:     encontrarCol(primeira, ['situacao','ativo','status']),
      };

      if (!mapa.codigo)
        throw new Error(`Coluna de código não encontrada. Colunas disponíveis: ${Object.keys(primeira).join(', ')}`);
      if (!mapa.descricao)
        throw new Error(`Coluna de descrição não encontrada. Colunas disponíveis: ${Object.keys(primeira).join(', ')}`);

      // ── Processar em transação ───────────────────────────
      await client.query('BEGIN');

      for (let i = 0; i < registros.length; i++) {
        const linha = registros[i];
        const codigoBruto = String(linha[mapa.codigo] || '').trim();
        if (!codigoBruto || codigoBruto.toLowerCase() === 'codigo') continue;

        const codigo    = codigoBruto;
        const descricao = String(linha[mapa.descricao] || '').trim();
        if (!descricao) { erros++; continue; }

        // Filtra produtos desativados (situacao = DESATIVADO)
        if (mapa.ativo) {
          const sit = String(linha[mapa.ativo] || '').toUpperCase().trim();
          if (sit === 'DESATIVADO' || sit === 'INATIVO' || sit === 'FALSE' || sit === '0') continue;
        }

        const descRed    = mapa.desc_red  ? String(linha[mapa.desc_red]  || '').trim()   : null;
        const categoria  = mapa.categoria ? String(linha[mapa.categoria] || '').trim()   : null;
        const unidade    = mapa.unidade   ? String(linha[mapa.unidade]   || 'KG').trim() : 'KG';
        const precoCusto = mapa.custo     ? limparPreco(linha[mapa.custo])  : null;
        const precoVenda = mapa.venda     ? limparPreco(linha[mapa.venda])  : null;

        try {
          const result = await client.query(
            `INSERT INTO produtos_mestre
               (codigo_produto, descricao_produto, descricao_reduzida, categoria, unidade,
                preco_custo, preco_venda, origem_dados, id_importacao_origem, data_ultima_importacao)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'TOTVS',$8,NOW())
             ON CONFLICT (codigo_produto) DO UPDATE SET
               descricao_produto      = EXCLUDED.descricao_produto,
               descricao_reduzida     = COALESCE(EXCLUDED.descricao_reduzida, produtos_mestre.descricao_reduzida),
               categoria              = COALESCE(EXCLUDED.categoria, produtos_mestre.categoria),
               unidade                = CASE WHEN EXCLUDED.unidade <> '' THEN EXCLUDED.unidade ELSE produtos_mestre.unidade END,
               preco_custo            = COALESCE(EXCLUDED.preco_custo, produtos_mestre.preco_custo),
               preco_venda            = COALESCE(EXCLUDED.preco_venda, produtos_mestre.preco_venda),
               data_ultima_importacao = NOW(),
               atualizado_em          = NOW()
             RETURNING (xmax = 0) AS foi_insert`,
            [codigo, descricao, descRed || null, categoria || null, unidade,
             precoCusto, precoVenda, importacaoId]
          );
          if (result.rows[0].foi_insert) { inseridos++; log.push({ linha: i+2, codigo, acao: 'inserido' }); }
          else                           { atualizados++; log.push({ linha: i+2, codigo, acao: 'atualizado' }); }
        } catch (erroLinha) {
          erros++;
          log.push({ linha: i+2, codigo, acao: 'erro', erro: erroLinha.message });
        }
      }

      await client.query(
        `UPDATE importacoes_totvs SET
           total_registros=$1, registros_inseridos=$2, registros_atualizados=$3,
           registros_erro=$4, status='concluido', log_importacao=$5
         WHERE id=$6`,
        [registros.length, inseridos, atualizados, erros, JSON.stringify(log), importacaoId]
      );
      await client.query('COMMIT');

      res.json({
        sucesso: true, importacao_id: importacaoId,
        total: registros.length, inseridos, atualizados, erros,
        mensagem: `Importação concluída: ${inseridos} inseridos, ${atualizados} atualizados, ${erros} erros.`,
      });

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (importacaoId) {
        await pool.query(
          `UPDATE importacoes_totvs SET status='erro', log_importacao=$1 WHERE id=$2`,
          [JSON.stringify([{ erro: err.message }]), importacaoId]
        ).catch(() => {});
      }
      console.error('[totvs/importar]', err.message);
      res.status(500).json({ erro: err.message || 'Erro ao processar arquivo.' });
    } finally {
      client.release();
    }
  });

  return router;
};
