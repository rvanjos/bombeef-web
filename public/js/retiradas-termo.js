(function(){
  let termoAtual=null;
  let formaAtual='';
  let validacaoBaixaAtual=null;

  function dataBR(v){
    const s=String(v||'').slice(0,10);
    const p=s.split('-');
    return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : '—';
  }
  function brl(v){
    return 'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  function qtd(v){
    return Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:3,maximumFractionDigits:3});
  }
  function safe(v){
    return String(v==null?'':v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  }

  function payloadRelatorio(){
    if(!termoAtual) return null;
    return {
      funcionarioId:Number(termoAtual.funcionario.id),
      formaPagamento:(document.getElementById('rel-baixa-forma')?.value||formaAtual||''),
      itens:(termoAtual.itens||[]).map(x=>({id:Number(x.id),saldoEsperado:Number(x.saldo_restante||0)}))
    };
  }

  async function validarBaixaRelatorio(renderizar=true){
    const payload=payloadRelatorio();
    if(!payload || !payload.itens.length) return {ok:false,apto:false,problemas:['Sem itens em aberto.']};
    const d=await window.BB.api.post('/api/retiradas/relatorio-periodo/validar-baixa',payload);
    validacaoBaixaAtual=d;
    if(renderizar){
      const el=document.getElementById('rel-baixa-status');
      if(el){
        if(!d.ok) el.innerHTML='<div class="alert danger">❌ '+safe(d.erro||'Não foi possível validar a baixa')+'</div>';
        else if(d.apto) el.innerHTML='<div class="alert success">✅ Pronto para baixa: '+d.quantidade+' item(ns) · '+brl(d.total)+'. Todos continuam pendentes com os mesmos valores.</div>';
        else el.innerHTML='<div class="alert warning">⚠️ Não é seguro dar baixa agora.<br>'+safe((d.problemas||[]).join(' | '))+'</div>';
      }
      window.atualizarBotaoBaixaRelatorio?.();
    }
    return d;
  }


  window.abrirRelatorio = function(){
    const modal=document.getElementById('modal-rel');
    if(!modal) return;
    modal.classList.add('open');

    const sel=document.getElementById('rel-func');
    if(sel){
      while(sel.options.length>1) sel.remove(1);
      ((typeof funcionarios!=='undefined'&&Array.isArray(funcionarios))?funcionarios:[]).forEach(f=>{
        const o=document.createElement('option');
        o.value=f.id; o.textContent=f.nome; sel.appendChild(o);
      });
      const flt=document.getElementById('flt-func');
      if(flt&&flt.value) sel.value=flt.value;
    }

    const mesVal=document.getElementById('flt-mes')?.value||'';
    const hoje=new Date();
    let inicio='',fim='';
    if(mesVal){
      const p=mesVal.split('-');
      const ano=Number(p[0]),mes=Number(p[1]);
      inicio=ano+'-'+String(mes).padStart(2,'0')+'-01';
      fim=ano+'-'+String(mes).padStart(2,'0')+'-'+String(new Date(ano,mes,0).getDate()).padStart(2,'0');
    }else{
      inicio=hoje.getFullYear()+'-'+String(hoje.getMonth()+1).padStart(2,'0')+'-01';
      fim=hoje.toISOString().slice(0,10);
    }
    document.getElementById('rel-inicio').value=inicio;
    document.getElementById('rel-fim').value=fim;
    termoAtual=null; formaAtual=''; validacaoBaixaAtual=null;
    document.getElementById('rel-body').innerHTML='Selecione o funcionário e o período para gerar o relatório de baixa.';
  };

  window.gerarTermoRetiradas = async function(){
    const funcionarioId=document.getElementById('rel-func')?.value||'';
    const inicio=document.getElementById('rel-inicio')?.value||'';
    const fim=document.getElementById('rel-fim')?.value||'';
    if(!funcionarioId){ window.BB?.toast?.('⚠️ Selecione o funcionário'); return; }
    if(!inicio||!fim){ window.BB?.toast?.('⚠️ Informe o período'); return; }
    if(fim<inicio){ window.BB?.toast?.('⚠️ A data final não pode ser anterior à inicial'); return; }

    const body=document.getElementById('rel-body');
    body.innerHTML='<div style="padding:20px;text-align:center">Carregando retiradas...</div>';
    const url='/api/retiradas/relatorio-periodo?funcionario_id='+encodeURIComponent(funcionarioId)+'&inicio='+encodeURIComponent(inicio)+'&fim='+encodeURIComponent(fim);
    const d=await window.BB.api.get(url);
    if(!d.ok){ body.innerHTML='<div class="alert danger">❌ '+safe(d.erro||'Erro ao gerar termo')+'</div>'; return; }

    const itensAbertos=(d.data.itens||[]).filter(x=>Number(x.saldo_restante||0)>0.004);
    termoAtual={...d.data,itens:itensAbertos,totais:{...d.data.totais,desconto:itensAbertos.reduce((s,x)=>s+Number(x.saldo_restante||0),0)}};
    formaAtual='';
    const r=termoAtual;

    const linhas=(r.itens||[]).map(x=>'<tr>'+
      '<td>'+dataBR(x.dt_retirada)+'</td>'+
      '<td>'+safe(x.descricao||x.produto_descricao||'—')+'</td>'+
      '<td style="text-align:right">'+qtd(x.qtd)+'</td>'+
      '<td style="text-align:right;font-weight:700">'+brl(x.saldo_restante)+'</td>'+
    '</tr>').join('');

    body.innerHTML=
      '<div style="background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden">'+
        '<div style="padding:14px 16px;background:#faf7f4;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;align-items:center">'+
          '<div><div style="font-size:16px;font-weight:800;color:var(--text)">'+safe(r.funcionario.nome)+'</div>'+
          '<div style="font-size:11px;color:var(--muted);margin-top:3px">Período: '+dataBR(r.inicio)+' a '+dataBR(r.fim)+' · '+(r.itens||[]).length+' item(ns) em aberto</div></div>'+
          '<button class="btn btn-p" onclick="imprimirTermoRetiradas()">🖨️ Abrir documento para impressão</button>'+
        '</div>'+
        '<div style="padding:14px 16px">'+
          '<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#9a3412">'+
            '✍️ No documento impresso, o funcionário deve marcar a forma de pagamento desejada e assinar antes da baixa.'+
          '</div>'+
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">'+
            '<div style="border:1px solid var(--border);border-radius:9px;padding:10px;background:#fafafa"><div style="font-size:10px;color:var(--muted);font-weight:800">RETIRADO NO PERÍODO</div><div style="font-size:18px;font-weight:900;margin-top:3px">'+brl(r.totais.total)+'</div></div>'+
            '<div style="border:1px solid #bbf7d0;border-radius:9px;padding:10px;background:#f0fdf4"><div style="font-size:10px;color:#166534;font-weight:800">JÁ PAGO NO PERÍODO</div><div style="font-size:18px;font-weight:900;color:#166534;margin-top:3px">'+brl(r.totais.pago)+'</div></div>'+
            '<div style="border:2px solid #b91c1c;border-radius:9px;padding:10px;background:#fff1f2"><div style="font-size:10px;color:#9f1239;font-weight:900">VALOR A PAGAR DESTE PERÍODO</div><div style="font-size:22px;font-weight:900;color:#b91c1c;margin-top:3px">'+brl(r.totais.aberto)+'</div></div>'+
          '</div>'+
          '<table class="rel-table"><thead><tr><th>Data</th><th>Produto</th><th>Qtd.</th><th>Valor em aberto</th></tr></thead><tbody>'+
            (linhas||'<tr><td colspan="4">Nenhum valor em aberto neste período.</td></tr>')+
          '</tbody></table>'+
          ((r.pendencias_anteriores?.valor||0)>0 ? '<div style="margin-top:12px;border:1px solid #d1d5db;border-radius:9px;padding:10px;background:#f9fafb;color:#4b5563"><b>Pendências de períodos anteriores:</b> '+brl(r.pendencias_anteriores.valor)+' · '+Number(r.pendencias_anteriores.quantidade||0)+' item(ns). <b>Não incluído</b> no valor a pagar deste período.</div>' : '')+
          '<div style="margin-top:12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;padding:11px;font-size:12px;color:#9a3412"><b>Na impressão:</b> o funcionário escolherá ☐ Vale Alimentação ou ☐ PIX e assinará o documento.</div>'+
          '<div id="rel-baixa-status" style="margin-top:12px"></div>'+
          '<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">'+
            '<div style="font-size:12px;font-weight:800;margin-bottom:8px">Após receber o relatório assinado</div>'+
            '<div style="display:grid;grid-template-columns:minmax(220px,1fr) 160px auto;gap:8px;align-items:end">'+
              '<div><label style="font-size:10px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px">FORMA ESCOLHIDA PELO FUNCIONÁRIO</label>'+
                '<select id="rel-baixa-forma" class="flt" style="width:100%" onchange="formaAtual=this.value;atualizarBotaoBaixaRelatorio()">'+
                  '<option value="">— Selecione após a assinatura —</option>'+
                  '<option value="vale">Desconto no Vale Alimentação</option>'+
                  '<option value="pix">Pagamento via PIX</option>'+
                '</select></div>'+
              '<div><label style="font-size:10px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px">DATA DA BAIXA</label>'+
                '<input id="rel-baixa-data" type="date" class="flt" style="width:100%" value="'+new Date().toISOString().slice(0,10)+'"></div>'+
              '<button class="btn btn-green" id="btn-confirmar-baixa-rel" onclick="confirmarBaixaRelatorio()" disabled>✅ Confirmar baixa de todos</button>'+
            '</div>'+
          '</div>'+
        '</div>'+
      '</div>';
    validarBaixaRelatorio(true);
  };

  window.atualizarBotaoBaixaRelatorio = function(){
    const forma=document.getElementById('rel-baixa-forma')?.value||'';
    formaAtual=forma;
    const btn=document.getElementById('btn-confirmar-baixa-rel');
    if(btn) btn.disabled=!(validacaoBaixaAtual?.ok && validacaoBaixaAtual?.apto && ['vale','pix'].includes(forma));
  };

  window.validarBaixaRelatorioUI = async function(){
    await validarBaixaRelatorio(true);
  };

  window.confirmarBaixaRelatorio = async function(){
    const payload=payloadRelatorio();
    if(!payload || !payload.itens.length){ window.BB?.toast?.('⚠️ Gere um relatório com itens em aberto'); return; }

    const conf=await validarBaixaRelatorio(true);
    if(!conf.ok || !conf.apto){
      window.BB?.toast?.('⚠️ O relatório não está apto para baixa. Gere novamente.');
      return;
    }

    formaAtual=document.getElementById('rel-baixa-forma')?.value||'';
    if(!['vale','pix'].includes(formaAtual)){ window.BB?.toast?.('⚠️ Selecione a forma de pagamento marcada pelo funcionário'); return; }
    const formaLabel=formaAtual==='vale'?'Desconto no Vale Alimentação':'Pagamento via PIX';
    const msg='Confirmar pagamento de TODOS os '+conf.quantidade+' itens deste relatório?\n\nTotal: '+brl(conf.total)+'\nForma: '+formaLabel+'\n\nEsta ação registrará a baixa financeira dos itens.';
    if(!window.confirm(msg)) return;

    const hoje=document.getElementById('rel-baixa-data')?.value||new Date().toISOString().slice(0,10);
    const d=await window.BB.api.post('/api/retiradas/relatorio-periodo/confirmar-baixa',{
      ...payload,
      formaPagamento:formaAtual,
      dataPagamento:hoje,
      observacao:'Baixa integral confirmada pelo relatório de '+dataBR(termoAtual.inicio)+' a '+dataBR(termoAtual.fim)
    });
    if(!d.ok){
      window.BB?.toast?.('❌ '+(d.erro||'Não foi possível confirmar a baixa'));
      if(d.problemas?.length) {
        const el=document.getElementById('rel-baixa-status');
        if(el) el.innerHTML='<div class="alert danger">❌ '+safe(d.erro)+'<br>'+safe(d.problemas.join(' | '))+'</div>';
      }
      return;
    }

    window.BB?.toast?.('✅ Baixa confirmada: '+d.quantidade+' item(ns) · '+brl(d.total));
    validacaoBaixaAtual={ok:true,apto:false,baixado:true};
    const el=document.getElementById('rel-baixa-status');
    if(el) el.innerHTML='<div class="alert success">✅ Pagamento confirmado. '+d.quantidade+' item(ns) quitados · '+brl(d.total)+'.</div>';
    const btn=document.getElementById('btn-confirmar-baixa-rel');
    if(btn){ btn.disabled=true; btn.textContent='✅ Pagamento confirmado'; }
    try{
      if(typeof carregar==='function') await carregar();
      if(typeof carregarKPIs==='function') await carregarKPIs();
    }catch(_){}
  };

  window.imprimirTermoRetiradas = function(){
    const r=termoAtual;
    if(!r){ window.BB?.toast?.('⚠️ Gere o termo primeiro'); return; }
    if(!(r.itens||[]).length){ window.BB?.toast?.('⚠️ Não há valores em aberto no período'); return; }

    const linhas=(r.itens||[]).map(x=>'<tr>'+
      '<td>'+dataBR(x.dt_retirada)+'</td>'+
      '<td>'+safe(x.descricao||x.produto_descricao||'—')+'</td>'+
      '<td class="n">'+qtd(x.qtd)+'</td>'+
      '<td class="n"><b>'+brl(x.saldo_restante)+'</b></td>'+
    '</tr>').join('');

    const html='<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Retiradas - '+safe(r.funcionario.nome)+'</title>'+
      '<style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:10.5px;margin:0}.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #8B0000;padding-bottom:10px;margin-bottom:14px}.brand{font-size:20px;font-weight:900;color:#8B0000}.doc{font-size:13px;font-weight:800;text-align:right}.muted{color:#6b7280;font-size:9.5px}.info{display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-bottom:12px}.box{border:1px solid #d1d5db;border-radius:6px;padding:8px;background:#fafafa}.box b{display:block;font-size:9px;text-transform:uppercase;color:#6b7280;margin-bottom:3px}table{width:100%;border-collapse:collapse;font-size:10px}thead{display:table-header-group}th{background:#8B0000;color:#fff;padding:7px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.3px}td{padding:7px;border-bottom:1px solid #e5e7eb}.n{text-align:right}.total{margin-top:12px;border:2px solid #8B0000;border-radius:7px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center}.total .lbl{font-size:11px;font-weight:800}.total .val{font-size:21px;font-weight:900;color:#8B0000}.escolha{margin-top:16px;border:1.5px solid #9ca3af;border-radius:7px;padding:12px}.escolha h2{font-size:11px;margin:0 0 9px;text-transform:uppercase}.opcoes{display:grid;grid-template-columns:1fr 1fr;gap:12px}.opcao{border:1px solid #d1d5db;border-radius:6px;padding:11px;font-size:12px;font-weight:700}.check{display:inline-block;width:17px;height:17px;border:2px solid #111;margin-right:8px;vertical-align:-4px}.decl{margin-top:14px;line-height:1.45;text-align:justify}.data{margin-top:18px}.assinaturas{display:grid;grid-template-columns:1fr 1fr;gap:42px;margin-top:52px}.assinatura{border-top:1px solid #111;text-align:center;padding-top:6px;font-size:9.5px}.obs{margin-top:18px;border-top:1px solid #d1d5db;padding-top:8px;font-size:9px;color:#6b7280}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>'+
      '<div class="top"><div><div class="brand">BOM BEEF</div><div class="muted">Gestão de Retiradas de Funcionários</div></div><div><div class="doc">RELATÓRIO PARA BAIXA</div><div class="muted">Conferência e autorização do funcionário</div></div></div>'+
      '<div class="info"><div class="box"><b>Funcionário</b>'+safe(r.funcionario.nome)+'</div><div class="box"><b>Período solicitado</b>'+dataBR(r.inicio)+' a '+dataBR(r.fim)+'</div></div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr 1.15fr;gap:8px;margin-bottom:12px">'+
        '<div class="box"><b>Retirado no período</b><strong style="font-size:14px">'+brl(r.totais.total)+'</strong></div>'+
        '<div class="box"><b>Já pago no período</b><strong style="font-size:14px">'+brl(r.totais.pago)+'</strong></div>'+
        '<div class="box" style="border:2px solid #8B0000;background:#fff5f5"><b style="color:#8B0000">Valor a pagar deste período</b><strong style="font-size:18px;color:#8B0000">'+brl(r.totais.aberto)+'</strong></div>'+
      '</div>'+
      '<table><thead><tr><th>Data</th><th>Produto</th><th style="text-align:right">Qtd.</th><th style="text-align:right">Valor em aberto</th></tr></thead><tbody>'+linhas+'</tbody></table>'+
      '<div class="total"><div><div class="lbl">VALOR A PAGAR DESTE PERÍODO</div><div class="muted">'+(r.itens||[]).length+' item(ns) pendente(s) do período solicitado</div></div><div class="val">'+brl(r.totais.aberto)+'</div></div>'+
      (((r.pendencias_anteriores?.valor||0)>0) ? '<div style="margin-top:10px;border:1px solid #d1d5db;border-radius:6px;padding:8px;background:#f9fafb;color:#4b5563"><b>Pendências anteriores:</b> '+brl(r.pendencias_anteriores.valor)+' em '+Number(r.pendencias_anteriores.quantidade||0)+' item(ns). <b>Este valor NÃO está incluído no total acima.</b></div>' : '')+
      '<div class="escolha"><h2>FORMA DE PAGAMENTO — FUNCIONÁRIO DEVE ASSINALAR UMA OPÇÃO</h2><div class="opcoes">'+
        '<div class="opcao"><span class="check"></span> Desconto no Vale Alimentação</div>'+
        '<div class="opcao"><span class="check"></span> Pagamento via PIX</div>'+
      '</div></div>'+
      '<div class="decl">Declaro que conferi os produtos, datas, quantidades e valores relacionados neste relatório, reconheço o total acima e autorizo a quitação pela forma de pagamento que assinalei.</div>'+
      '<div class="data">Valinhos, ______ de ______________________________ de __________.</div>'+
      '<div class="assinaturas"><div class="assinatura">'+safe(r.funcionario.nome)+'<br><b>Assinatura do funcionário</b></div><div class="assinatura">Responsável Bom Beef<br><b>Conferência</b></div></div>'+
      '<div class="obs">Observação: a baixa no sistema deve ser confirmada somente após o recebimento deste relatório assinado.</div>'+
      '</body></html>';

    const w=window.open('','_blank','width=900,height=760');
    if(!w){ window.BB?.toast?.('⚠️ Permita pop-ups para imprimir o termo'); return; }
    w.document.open();w.document.write(html);w.document.close();
    w.onload=function(){w.focus();w.print();};
  };

  // Compatibilidade: qualquer botão/atalho legado de "Imprimir" abre o relatório de baixa.
  window.imprimirRetiradas = window.abrirRelatorio;
  window.abrirModoImpressaoRetiradas = window.imprimirTermoRetiradas;
})();