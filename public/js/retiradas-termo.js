(function(){
  let termoAtual=null;

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

  window.abrirRelatorio = function(){
    const modal=document.getElementById('modal-rel');
    if(!modal) return;
    modal.classList.add('open');

    const sel=document.getElementById('rel-func');
    if(sel){
      while(sel.options.length>1) sel.remove(1);
      (window.funcionarios||[]).forEach(f=>{
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
    document.getElementById('rel-body').innerHTML='Selecione o funcionário e o período para gerar o termo.';
  };

  window.gerarTermoRetiradas = async function(){
    const funcionarioId=document.getElementById('rel-func')?.value||'';
    const inicio=document.getElementById('rel-inicio')?.value||'';
    const fim=document.getElementById('rel-fim')?.value||'';
    if(!funcionarioId){ window.toast?.('⚠️ Selecione o funcionário'); return; }
    if(!inicio||!fim){ window.toast?.('⚠️ Informe o período'); return; }
    if(fim<inicio){ window.toast?.('⚠️ A data final não pode ser anterior à inicial'); return; }

    const body=document.getElementById('rel-body');
    body.innerHTML='<div style="padding:20px;text-align:center">Carregando retiradas...</div>';
    const url='/api/retiradas/relatorio-periodo?funcionario_id='+encodeURIComponent(funcionarioId)+'&inicio='+encodeURIComponent(inicio)+'&fim='+encodeURIComponent(fim);
    const d=await window.BB.api.get(url);
    if(!d.ok){ body.innerHTML='<div class="alert danger">❌ '+safe(d.erro||'Erro ao gerar termo')+'</div>'; return; }
    termoAtual=d.data;

    const r=d.data;
    const linhas=(r.itens||[]).map(x=>'<tr>'+
      '<td>'+dataBR(x.dt_retirada)+'</td>'+
      '<td>'+safe(x.descricao||x.produto_descricao||'—')+'</td>'+
      '<td style="text-align:right">'+qtd(x.qtd)+'</td>'+
      '<td style="text-align:right">'+brl(x.preco_unitario)+'</td>'+
      '<td style="text-align:right;font-weight:700">'+brl(x.valor_total)+'</td>'+
      '<td style="text-align:right">'+brl(x.saldo_restante)+'</td>'+
    '</tr>').join('');

    body.innerHTML=
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px">'+
        '<div><div style="font-size:15px;font-weight:800">'+safe(r.funcionario.nome)+'</div><div style="font-size:11px;color:var(--muted)">Período: '+dataBR(r.inicio)+' a '+dataBR(r.fim)+'</div></div>'+
        '<button class="btn btn-p" onclick="imprimirTermoRetiradas()">🖨️ Imprimir termo para assinatura</button>'+
      '</div>'+
      '<table class="rel-table"><thead><tr><th>Data</th><th>Produto / descrição</th><th>Qtd</th><th>Preço</th><th>Total</th><th>Saldo</th></tr></thead><tbody>'+
        (linhas||'<tr><td colspan="6">Nenhuma retirada encontrada no período.</td></tr>')+
      '</tbody></table>'+
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px">'+
        '<div style="background:#f7f4f0;border-radius:8px;padding:10px"><small>Total retirado</small><div style="font-weight:800">'+brl(r.totais.total)+'</div></div>'+
        '<div style="background:#ecfdf5;border-radius:8px;padding:10px"><small>Já pago</small><div style="font-weight:800;color:#15803d">'+brl(r.totais.pago)+'</div></div>'+
        '<div style="background:#fff1f2;border-radius:8px;padding:10px"><small>Saldo para quitação</small><div style="font-weight:800;color:#b91c1c">'+brl(r.totais.aberto)+'</div></div>'+
      '</div>'+
      '<div style="margin-top:14px;padding:12px;border:1px dashed var(--border);border-radius:8px;font-size:12px"><b>Forma de pagamento para o funcionário assinalar:</b><br>☐ Desconto no Vale Alimentação &nbsp;&nbsp;&nbsp; ☐ Pagamento via PIX</div>';
  };

  window.imprimirTermoRetiradas = function(){
    const r=termoAtual;
    if(!r){ window.toast?.('⚠️ Gere o termo primeiro'); return; }

    const linhas=(r.itens||[]).map(x=>'<tr>'+
      '<td>'+dataBR(x.dt_retirada)+'</td>'+
      '<td>'+safe(x.descricao||x.produto_descricao||'—')+'</td>'+
      '<td class="n">'+qtd(x.qtd)+'</td>'+
      '<td class="n">'+brl(x.preco_unitario)+'</td>'+
      '<td class="n"><b>'+brl(x.valor_total)+'</b></td>'+
      '<td class="n">'+brl(x.saldo_restante)+'</td>'+
    '</tr>').join('');

    const html='<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Termo de Retiradas - '+safe(r.funcionario.nome)+'</title>'+
      '<style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:11px;margin:0}.head{border-bottom:3px solid #8B0000;padding-bottom:9px;margin-bottom:14px}h1{font-size:17px;color:#8B0000;margin:0 0 4px}.sub{font-size:10px;color:#555}.info{display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-bottom:12px}.box{border:1px solid #ccc;border-radius:5px;padding:8px}table{width:100%;border-collapse:collapse;font-size:10px}th{background:#8B0000;color:#fff;padding:6px;text-align:left}td{padding:5px 6px;border-bottom:1px solid #ddd}.n{text-align:right}.totais{margin-top:10px;margin-left:auto;width:55%;border-collapse:collapse}.totais td{border:1px solid #ccc;padding:6px}.decl{margin-top:16px;line-height:1.5;text-align:justify}.pagto{border:1px solid #999;padding:12px;margin-top:14px;font-size:12px}.opt{margin:9px 0;font-size:13px}.check{font-size:18px;vertical-align:-2px;margin-right:6px}.assinaturas{display:grid;grid-template-columns:1fr 1fr;gap:35px;margin-top:48px}.linha{border-top:1px solid #222;text-align:center;padding-top:5px;font-size:10px}.rodape{margin-top:20px;font-size:9px;color:#666}</style></head><body>'+
      '<div class="head"><h1>Bom Beef — Termo de Conferência de Retiradas</h1><div class="sub">Conferência de valores para quitação pelo funcionário</div></div>'+
      '<div class="info"><div class="box"><b>Funcionário:</b> '+safe(r.funcionario.nome)+'</div><div class="box"><b>Período:</b> '+dataBR(r.inicio)+' a '+dataBR(r.fim)+'</div></div>'+
      '<table><thead><tr><th>Data</th><th>Produto / descrição</th><th>Qtd</th><th>Preço unit.</th><th>Total</th><th>Saldo</th></tr></thead><tbody>'+(linhas||'<tr><td colspan="6">Nenhuma retirada encontrada.</td></tr>')+'</tbody></table>'+
      '<table class="totais"><tr><td>Total retirado</td><td class="n"><b>'+brl(r.totais.total)+'</b></td></tr><tr><td>Já pago</td><td class="n">'+brl(r.totais.pago)+'</td></tr><tr><td><b>Saldo para quitação</b></td><td class="n"><b>'+brl(r.totais.aberto)+'</b></td></tr></table>'+
      '<div class="decl">Declaro que conferi as retiradas e os valores acima relacionados e estou de acordo com o saldo indicado para quitação.</div>'+
      '<div class="pagto"><b>Forma de pagamento escolhida pelo funcionário:</b><div class="opt"><span class="check">☐</span> Desconto no Vale Alimentação</div><div class="opt"><span class="check">☐</span> Pagamento via PIX</div><div style="margin-top:10px">Observação: __________________________________________________________________________________</div></div>'+
      '<div style="margin-top:22px">Valinhos, ______ de __________________________ de __________.</div>'+
      '<div class="assinaturas"><div class="linha">'+safe(r.funcionario.nome)+'<br>Funcionário</div><div class="linha">Responsável Bom Beef</div></div>'+
      '<div class="rodape">Documento emitido pelo Sistema de Gestão Bom Beef. A opção assinalada neste termo não registra automaticamente a baixa financeira no sistema.</div>'+
      '</body></html>';

    const w=window.open('','_blank','width=1000,height=760');
    if(!w){ window.toast?.('⚠️ Permita pop-ups para imprimir o termo'); return; }
    w.document.open();w.document.write(html);w.document.close();
    w.onload=function(){w.focus();w.print();};
  };
})();