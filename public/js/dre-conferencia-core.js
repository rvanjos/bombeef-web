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

  function chaveDuplicidade(transacoes) {
    const lista = (Array.isArray(transacoes) ? transacoes : []).filter(Boolean);
    const mes = lista.map(t => t.mes || t.mesCaixa || '').find(Boolean) || '';
    const ids = lista.map(t => String(t.id == null ? '' : t.id)).filter(Boolean).sort();
    return ('DUP|' + mes + '|' + ids.join('~')).slice(0,220);
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
      const resumo = unicos.map(resumoTransacao);
      exatas.push({
        tipo: 'REIMPORTACAO',
        chave: chaveDuplicidade(resumo),
        motivo,
        confianca,
        quantidade: unicos.length,
        impactoPotencial: ativos.length > 1 ? valorUnitario * (ativos.length - 1) : 0,
        transacoes: resumo
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

          const resumo = [resumoTransacao(a), resumoTransacao(b)];
          pagamentosParecidos.push({
            tipo: 'PAGAMENTO_PARECIDO',
            chave: chaveDuplicidade(resumo),
            motivo: fornecedorCompativel
              ? `Mesmo valor e fornecedor em ${diferencaDias} dia(s)`
              : `Mesmo valor e descrição semelhante em ${diferencaDias} dia(s)`,
            diferencaDias,
            transacoes: resumo
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

    // Um mesmo fornecedor lançado em categorias diferentes no mesmo mês é um
    // forte indício de classificação inconsistente (não uma correção automática).
    const porFornecedorMes = new Map();
    lista.filter(t => !t.ignorar && t.categoria).forEach(t => {
      const nome = fornecedor(t);
      const nomeNormalizado = normalizarTexto(nome);
      const mes = t.mes || t.mesCaixa || '';
      if (!nomeNormalizado || !mes) return;
      const chave = `${mes}|${nomeNormalizado}`;
      if (!porFornecedorMes.has(chave)) porFornecedorMes.set(chave, {fornecedor:nome, mes, itens:[]});
      porFornecedorMes.get(chave).itens.push(t);
    });
    const categoriasInconsistentes = [];
    porFornecedorMes.forEach(grupo => {
      const categorias = [...new Set(grupo.itens.map(t => t.categoria).filter(Boolean))].sort();
      if (categorias.length < 2) return;
      categoriasInconsistentes.push({
        tipo: 'CATEGORIA_INCONSISTENTE',
        fornecedor: grupo.fornecedor,
        mes: grupo.mes,
        categorias,
        transacoes: grupo.itens.map(resumoTransacao)
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
      categoriasInconsistentes,
      impactoPotencial,
      totalAlertas: exatas.length + pagamentosParecidos.length + mesesInvalidos.length + categoriasInconsistentes.length
    };
  }

  return {
    analisar,
    normalizarTexto,
    dataCanonica,
    instanteEntrada,
    similaridadeTexto,
    chaveDuplicidade
  };
});

// Melhorias de UX da Central de Conferência do DRE.
// Mantidas neste arquivo para não alterar o motor financeiro nem a persistência.
if (typeof window !== 'undefined') {
  (function () {
    'use strict';

    function escHtml(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    function brl(v) {
      return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
    }

    function dataBr(v) {
      const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : (v || '—');
    }

    function entradaBr(v) {
      if (!v) return 'Horário não identificado';
      try { return new Date(v).toLocaleString('pt-BR'); } catch (_) { return 'Horário não identificado'; }
    }

    function temVinculo(t) {
      return Boolean(t && (t.boletoId || t.faturaCC || t.vinculadoFaturaCC));
    }

    function botaoAcao(t) {
      const analisar = t && t.categoria
        ? `<button class="confx-open" onclick="abrirCategoriaConferencia('${escHtml(t.id)}')">📊 Analisar categoria</button>`
        : `<button class="confx-open" onclick="localizarConferencia('${escHtml(t.id)}')">✏️ Classificar</button>`;
      if (temVinculo(t)) {
        return `${analisar}<span class="confx-vinc">🔗 Vinculado — desvincule antes de excluir</span>`;
      }
      return `${analisar}<button class="confx-del" onclick="confExcluirDre('${escHtml(t.id)}')">🗑️ Excluir lançamento</button>`;
    }

    function cardTx(t, rotulo) {
      const val = Number(t.valor || 0);
      return `<div class="confx-tx">
        <div class="confx-top">
          <div>
            <div class="confx-rotulo">${escHtml(rotulo || 'Lançamento')}</div>
            <div class="confx-desc">${escHtml(t.descricao || 'Sem descrição')}</div>
          </div>
          <div class="confx-valor ${val < 0 ? 'neg' : 'pos'}">${val < 0 ? '- ' : ''}${brl(Math.abs(val))}</div>
        </div>
        <div class="confx-grid">
          <div><span>Data</span><strong>${escHtml(dataBr(t.data))}</strong></div>
          <div><span>Origem</span><strong>${escHtml(t.fonte || '—')}</strong></div>
          <div><span>Fornecedor</span><strong>${escHtml(t.fornecedor || '—')}</strong></div>
          <div><span>Categoria</span><strong>${escHtml(t.categoria || 'Sem categoria')}</strong></div>
          <div><span>Entrada no sistema</span><strong>${escHtml(entradaBr(t.entradaEm))}</strong></div>
          <div><span>Situação</span><strong>${t.ignorado ? 'Ignorado' : (temVinculo(t) ? 'Vinculado' : 'Ativo')}</strong></div>
        </div>
        <div class="confx-actions">${botaoAcao(t)}</div>
      </div>`;
    }

    function instalarEstilo() {
      if (document.getElementById('confx-style')) return;
      const st = document.createElement('style');
      st.id = 'confx-style';
      st.textContent = `
        .confx-grupo{background:#fff;border:1px solid #e8e0d8;border-radius:12px;padding:13px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.03)}
        .confx-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:10px}
        .confx-title{font-weight:800;font-size:13px}.confx-motivo{font-size:10px;color:#7a7068;margin-top:3px}
        .confx-badge{font-size:9px;font-weight:800;border-radius:12px;padding:4px 8px;background:#fef3c7;color:#92400e;white-space:nowrap}
        .confx-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
        .confx-tx{border:1px solid #e5e7eb;border-radius:10px;padding:11px;background:#fafafa}
        .confx-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;border-bottom:1px solid #ece7e1;padding-bottom:8px;margin-bottom:8px}
        .confx-rotulo{font-size:9px;color:#7a7068;text-transform:uppercase;font-weight:800;letter-spacing:.45px}.confx-desc{font-weight:700;font-size:12px;margin-top:2px;word-break:break-word}
        .confx-valor{font:700 13px 'DM Mono',monospace;white-space:nowrap}.confx-valor.neg{color:#dc2626}.confx-valor.pos{color:#16a34a}
        .confx-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.confx-grid div{min-width:0}.confx-grid span{display:block;font-size:8px;text-transform:uppercase;color:#9a928b;font-weight:800}.confx-grid strong{display:block;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
        .confx-actions{display:flex;justify-content:flex-end;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid #ece7e1}.confx-open{border:1px solid #c7d2fe;background:#fff;color:#3730a3;border-radius:7px;padding:6px 9px;font-size:10px;font-weight:800;cursor:pointer}.confx-open:hover{background:#eef2ff}.confx-del{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:7px;padding:6px 9px;font-size:10px;font-weight:800;cursor:pointer}.confx-del:hover{background:#fef2f2}.confx-vinc{font-size:9px;color:#92400e;background:#fef3c7;border-radius:6px;padding:5px 8px}
        .confx-aviso{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:9px;padding:9px 10px;font-size:10px;margin-bottom:10px}
        .confx-ok{border:1px solid #bbf7d0;background:#fff;color:#166534;border-radius:7px;padding:6px 9px;font-size:10px;font-weight:800;cursor:pointer}.confx-ok:hover{background:#f0fdf4}.confx-resolvido{background:#dcfce7;color:#166534;border-radius:999px;padding:4px 8px;font-size:9px;font-weight:800}
        @media(max-width:700px){.confx-list{grid-template-columns:1fr}.confx-grid{grid-template-columns:1fr}.confx-grid strong{white-space:normal}}
      `;
      document.head.appendChild(st);
    }

    window.confExcluirDre = function (id) {
      if (typeof window.excluirLanc !== 'function') {
        alert('Não foi possível acessar a exclusão do DRE. Atualize a página e tente novamente.');
        return;
      }
      window.excluirLanc(String(id));
      setTimeout(function () {
        try { if (typeof window.abrirConferenciaDRE === 'function') window.abrirConferenciaDRE(); } catch (_) {}
      }, 180);
    };

    function grupoResolvido(g) {
      try { return !!window.DREConfV2Decisao?.(g && g.chave); } catch (_) { return false; }
    }

    window.confValidarDuplicidade = async function (chave, tipo, mes, ids) {
      if (!chave) return;
      if (!confirm(tipo === 'PAGAMENTO_PARECIDO'
        ? 'Confirmar que estes pagamentos são legítimos e não representam duplicidade?'
        : 'Confirmar que estes lançamentos estão corretos e não devem ser tratados como duplicidade?')) return;
      const justificativa = prompt('Justificativa (opcional):','') || '';
      try {
        const r = await api.post('/api/dre/conferencia-v2/decisoes', {
          chave, tipo:'DUPLICIDADE', status:'VALIDADO', decisao:'NAO_DUPLICADO',
          escopo:'MES', mes_ref:mes || null, justificativa,
          metadados:{ subtipo:tipo, ids:Array.isArray(ids)?ids:[] }
        });
        if (!r?.ok) { alert(r?.erro || 'Não foi possível registrar a decisão'); return; }
        if (window.DREConfV2Recarregar) await window.DREConfV2Recarregar();
        if (typeof window.dreFechAtualizar === 'function') window.dreFechAtualizar();
        if (typeof window.abrirConferenciaDRE === 'function') {
          window.abrirConferenciaDRE();
          setTimeout(() => { try { window.confRenderConteudo?.(); } catch (_) {} }, 80);
        }
      } catch (e) { alert('Não foi possível registrar a decisão: ' + e.message); }
    };

    function instalarRender() {
      instalarEstilo();
      if (typeof window.confRenderConteudo !== 'function' || window.confRenderConteudo.__confMelhorada) return;
      const original = window.confRenderConteudo;

      function melhorada() {
        let aba, analise, el;
        try {
          aba = _confDreAba;
          analise = _confDreAnalise;
          el = document.getElementById('conf-conteudo');
        } catch (_) { return original(); }
        if (!el || !analise) return original();

        if (aba === 'reimportacoes') {
          const pendentes = analise.reimportacoes.filter(g => !grupoResolvido(g));
          if (!pendentes.length) {
            el.innerHTML = '<div style="padding:34px 18px;text-align:center;background:#f8fafc;border:1px dashed #e8e0d8;border-radius:10px;color:#7a7068;font-size:12px">✅ Nenhuma reimportação pendente.</div>';
            return;
          }
          el.innerHTML = '<div class="confx-aviso"><strong>Como usar:</strong> compare os lançamentos do mesmo grupo. Se forem lançamentos legítimos, marque como correto. Se houver duplicidade real, exclua somente o registro duplicado.</div>' +
            pendentes.map((g, i) => {
              const mes = g.transacoes.map(t=>t.mes||t.mesCaixa||'').find(Boolean)||'';
              const ids = g.transacoes.map(t=>String(t.id||''));
              return `<div class="confx-grupo" style="border-left:4px solid #dc2626">
                <div class="confx-head"><div><div class="confx-title">Possível reimportação ${i + 1}</div><div class="confx-motivo">${escHtml(g.motivo)} · impacto potencial ${brl(g.impactoPotencial)}</div></div><span class="confx-badge">Confiança ${escHtml(g.confianca)}</span></div>
                <div class="confx-list">${g.transacoes.map((t, idx) => cardTx(t, idx === 0 ? 'Registro A' : `Registro ${String.fromCharCode(65 + idx)}`)).join('')}</div>
                <div class="confx-actions"><button class="confx-ok" onclick='confValidarDuplicidade(${JSON.stringify(g.chave)}, "REIMPORTACAO", ${JSON.stringify(mes)}, ${JSON.stringify(ids)})'>✓ Está correto / não é duplicidade</button></div>
              </div>`;
            }).join('');
          return;
        }

        if (aba === 'parecidos') {
          const pendentes = analise.pagamentosParecidos.filter(g => !grupoResolvido(g));
          if (!pendentes.length) {
            el.innerHTML = '<div style="padding:34px 18px;text-align:center;background:#f8fafc;border:1px dashed #e8e0d8;border-radius:10px;color:#7a7068;font-size:12px">✅ Nenhum pagamento parecido pendente.</div>';
            return;
          }
          el.innerHTML = '<div class="confx-aviso"><strong>Atenção:</strong> pagamentos parecidos são apenas uma suspeita e não bloqueiam o fechamento. Confira e marque como correto quando forem legítimos.</div>' +
            pendentes.map((g, i) => {
              const mes=g.transacoes.map(t=>t.mes||t.mesCaixa||'').find(Boolean)||'';
              const ids=g.transacoes.map(t=>String(t.id||''));
              return `<div class="confx-grupo" style="border-left:4px solid #d97706">
                <div class="confx-head"><div><div class="confx-title">Pagamentos parecidos ${i + 1}</div><div class="confx-motivo">${escHtml(g.motivo)}</div></div><span class="confx-badge">Revisão manual</span></div>
                <div class="confx-list">${g.transacoes.map((t, idx) => cardTx(t, idx === 0 ? 'Pagamento A' : 'Pagamento B')).join('')}</div>
                <div class="confx-actions"><button class="confx-ok" onclick='confValidarDuplicidade(${JSON.stringify(g.chave)}, "PAGAMENTO_PARECIDO", ${JSON.stringify(mes)}, ${JSON.stringify(ids)})'>✓ Está correto</button></div>
              </div>`;
            }).join('');
          return;
        }

        return original();
      }

      melhorada.__confMelhorada = true;
      window.confRenderConteudo = melhorada;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(instalarRender, 0); });
    } else {
      setTimeout(instalarRender, 0);
    }
  })();
}
