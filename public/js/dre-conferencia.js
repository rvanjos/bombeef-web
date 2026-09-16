(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DREConferencia = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const FONTES_BANCO = new Set(['EXTRATO', 'OFX']);
  const DESCRICOES_GENERICAS = new Set([
    'BOLETO', 'PIX', 'PAGAMENTO', 'PAGAMENTOS', 'RECEBIMENTO', 'RECEBIMENTOS',
    'TED', 'DOC', 'DEBITO', 'CREDITO'
  ]);

  function normalizarTexto(valor) {
    return String(valor || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function dataCanonica(valor) {
    const texto = String(valor || '').trim();
    const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    return texto;
  }

  function centavos(valor) {
    const numero = Number.parseFloat(valor || 0);
    return Number.isFinite(numero) ? Math.round(numero * 100) : 0;
  }

  function fonteBanco(transacao) {
    return FONTES_BANCO.has(normalizarTexto(transacao && transacao.fonte));
  }

  function fornecedor(transacao) {
    return transacao.razaoSocial || transacao.fornecedor || transacao.portador || transacao.boletoFornecedor || '';
  }

  function descricao(transacao) {
    return transacao.lancamento || transacao.descricao || transacao.desc || '';
  }

  function instanteEntrada(id) {
    const achou = String(id || '').match(/(\d{13})/);
    if (!achou) return null;
    const numero = Number(achou[1]);
    const data = new Date(numero);
    if (!Number.isFinite(numero) || Number.isNaN(data.getTime())) return null;
    if (data.getUTCFullYear() < 2020 || data.getUTCFullYear() > 2100) return null;
    return data.toISOString();
  }

  function diasEntre(dataA, dataB) {
    const a = Date.parse(dataCanonica(dataA));
    const b = Date.parse(dataCanonica(dataB));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round(Math.abs(a - b) / 86400000);
  }

  function similaridadeTexto(a, b) {
    const ta = new Set(normalizarTexto(a).split(/[^A-Z0-9]+/).filter(x => x.length > 2));
    const tb = new Set(normalizarTexto(b).split(/[^A-Z0-9]+/).filter(x => x.length > 2));
    if (!ta.size || !tb.size) return 0;
    let intersecao = 0;
    ta.forEach(token => { if (tb.has(token)) intersecao += 1; });
    const uniao = new Set([...ta, ...tb]).size;
    return uniao ? intersecao / uniao : 0;
  }

  function resumoTransacao(t) {
    return {
      id: String(t.id == null ? '' : t.id),
      data: dataCanonica(t.data),
      mes: t.mes || '',
      mesCaixa: t.mesCaixa || '',
      fonte: t.fonte || '',
      descricao: descricao(t),
      fornecedor: fornecedor(t),
      categoria: t.categoria || '',
      valor: Number.parseFloat(t.valor || 0) || 0,
      fitid: t.fitid || '',
      boletoId: t.boletoId || null,
      faturaCC: t.faturaCC || null,
      vinculadoFaturaCC: Boolean(t.vinculadoFaturaCC),
      ignorado: Boolean(t.ignorar),
      entradaEm: instanteEntrada(t.id)
    };
  }

  function chaveExata(t) {
    return [
      dataCanonica(t.data),
      centavos(t.valor),
      normalizarTexto(descricao(t)),
      normalizarTexto(fornecedor(t))
    ].join('|');
  }

  function analisar(transacoes) {
    const lista = Array.isArray(transacoes) ? transacoes.filter(Boolean) : [];
    const banco = lista.filter(fonteBanco);
    const exatas = [];
    const idsEmDuplicidade = new Set();
    const assinaturas = new Set();

    function registrarGrupo(grupo, motivo, confianca) {
      const unicos = Array.from(new Map(grupo.map(t => [String(t.id), t])).values());
      if (unicos.length < 2) return;
      if (unicos.every(t => idsEmDuplicidade.has(String(t.id)))) return;
      const assinatura = unicos.map(t => String(t.id)).sort().join('|');
      if (assinaturas.has(assinatura)) return;
      assinaturas.add(assinatura);
      unicos.forEach(t => idsEmDuplicidade.add(String(t.id)));
      const ativos = unicos.filter(t => !t.ignorar);
      const valorUnitario = Math.abs(Number.parseFloat(unicos[0].valor || 0));
      exatas.push({
        tipo: 'REIMPORTACAO',
        motivo,
        confianca,
        quantidade: unicos.length,
        impactoPotencial: ativos.length > 1 ? valorUnitario * (ativos.length - 1) : 0,
        transacoes: unicos.map(resumoTransacao)
      });
    }

    const porFitid = new Map();
    banco.forEach(t => {
      const fitid = normalizarTexto(t.fitid);
      if (!fitid) return;
      if (!porFitid.has(fitid)) porFitid.set(fitid, []);
      porFitid.get(fitid).push(t);
    });
    porFitid.forEach(grupo => registrarGrupo(grupo, 'Mesmo identificador bancário (FITID)', 'confirmada'));

    const porChave = new Map();
    banco.forEach(t => {
      const chave = chaveExata(t);
      if (!porChave.has(chave)) porChave.set(chave, []);
      porChave.get(chave).push(t);
    });
    porChave.forEach(grupo => registrarGrupo(
      grupo,
      'Mesma data, valor, descrição e fornecedor após normalização',
      grupo.some(t => t.fitid) ? 'alta' : 'provável'
    ));

    const pagamentosParecidos = [];
    const porValor = new Map();
    banco.filter(t => centavos(t.valor) < 0).forEach(t => {
      const chave = centavos(t.valor);
      if (!porValor.has(chave)) porValor.set(chave, []);
      porValor.get(chave).push(t);
    });

    porValor.forEach(grupo => {
      const ordenado = grupo.slice().sort((a, b) => dataCanonica(a.data).localeCompare(dataCanonica(b.data)));
      for (let i = 0; i < ordenado.length; i += 1) {
        for (let j = i + 1; j < ordenado.length; j += 1) {
          const a = ordenado[i];
          const b = ordenado[j];
          if (idsEmDuplicidade.has(String(a.id)) && idsEmDuplicidade.has(String(b.id))) continue;
          const diferencaDias = diasEntre(a.data, b.data);
          if (diferencaDias == null) continue;
          if (diferencaDias > 3) break;

          const fornA = normalizarTexto(fornecedor(a));
          const fornB = normalizarTexto(fornecedor(b));
          const descA = normalizarTexto(descricao(a));
          const descB = normalizarTexto(descricao(b));
          const fornecedorCompativel = fornA && fornB && (fornA === fornB || similaridadeTexto(fornA, fornB) >= 0.8);
          const descricaoUtil = descA.length >= 8 && descB.length >= 8 && !DESCRICOES_GENERICAS.has(descA) && !DESCRICOES_GENERICAS.has(descB);
          const descricaoCompativel = descricaoUtil && similaridadeTexto(descA, descB) >= 0.72;
          if (!fornecedorCompativel && !descricaoCompativel) continue;

          pagamentosParecidos.push({
            tipo: 'PAGAMENTO_PARECIDO',
            motivo: fornecedorCompativel
              ? `Mesmo valor e fornecedor em ${diferencaDias} dia(s)`
              : `Mesmo valor e descrição semelhante em ${diferencaDias} dia(s)`,
            diferencaDias,
            transacoes: [resumoTransacao(a), resumoTransacao(b)]
          });
        }
      }
    });

    const conciliacoes = banco
      .filter(t => t.boletoId || t.vinculadoFaturaCC || t.faturaCC)
      .map(t => ({
        tipo: t.boletoId ? 'BOLETO' : 'CARTAO',
        transacao: resumoTransacao(t),
        referencia: t.boletoId || t.faturaCC || ''
      }));

    const mesValido = /^(0[1-9]|1[0-2])\/\d{4}$/;
    const mesesInvalidos = [];
    lista.forEach(t => {
      [['mes', t.mes], ['mesCaixa', t.mesCaixa]].forEach(([campo, valor]) => {
        if (valor && !mesValido.test(String(valor))) {
          mesesInvalidos.push({ campo, valor: String(valor), transacao: resumoTransacao(t) });
        }
      });
    });

    const impactoPotencial = exatas.reduce((soma, grupo) => soma + grupo.impactoPotencial, 0);
    return {
      totalTransacoes: lista.length,
      totalBanco: banco.length,
      reimportacoes: exatas,
      pagamentosParecidos,
      conciliacoes,
      mesesInvalidos,
      impactoPotencial,
      totalAlertas: exatas.length + pagamentosParecidos.length + mesesInvalidos.length
    };
  }

  return {
    analisar,
    normalizarTexto,
    dataCanonica,
    instanteEntrada,
    similaridadeTexto
  };
});
