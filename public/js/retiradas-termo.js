(function(){
  let termoAtual=null;
  let formaAtual='';

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
    const forma=document.getElementById('rel-forma'); if(forma) forma.value='';
    document.getElementById('rel-body').innerHTML='Selecione o funcionário, o período e a forma de pagamento para gerar o termo.';
  };

  window.gerarTermoRetiradas = async function(){
    const funcionarioId=document.getElementById('rel-func')?.value||'';
    const inicio=document.getElementById('rel-inicio')?.value||'';
    const fim=document.getElementById('rel-fim')?.value||'';
    const forma=document.getElementById('rel-forma')?.value||'';
    if(!funcionarioId){ window.BB?.toast?.('⚠️ Selecione o funcionário'); return; }
    if(!inicio||!fim){ window.BB?.toast?.('⚠️ Informe o período'); return; }
    if(fim<inicio){ window.BB?.toast?.('⚠️ A data final não pode ser anterior à inicial'); return; }
    if(!['vale','pix'].includes(forma)){ window.BB?.toast?.('⚠️ Selecione a forma de pagamento'); return; }

    const body=document.getElementById('rel-body');
    body.innerHTML='<div style="padding:20px;text-align:center">Carregando retiradas...</div>';
    const url='/api/retiradas/relatorio-periodo?funcionario_id='+encodeURIComponent(funcionarioId)+'&inicio='+encodeURIComponent(inicio)+'&fim='+encodeURIComponent(fim);
    const d=await window.BB.api.get(url);
    if(!d.ok){ body.innerHTML='<div class="alert danger">❌ '+safe(d.erro||'Erro ao gerar termo')+'</div>'; return; }

    const itensAbertos=(d.data.itens||[]).filter(x=>Number(x.saldo_restante||0)>0.004);
    termoAtual={...d.data,itens:itensAbertos,totais:{...d.data.totais,desconto:itensAbertos.reduce((s,x)=>s+Number(x.saldo_restante||0),0)}};
    formaAtual=forma;
    const r=termoAtual;
    const formaLabel=forma==='vale'?'Desconto no Vale Alimentação':'Pagamento via PIX';

    const linhas=(r.itens||[]).map(x=>'<tr>'+
      '<td>'+dataBR(x.dt_retirada)+'</td>'+
      '<td>'+safe(x.descricao||x.produto_descricao||'—')+'</td>'+
      '<td style="text-align:right">'+qtd(x.qtd)+'</td>'+
      '<td style="text-align:right;font-weight:700">'+brl(x.saldo_restante)+'</td>'+
    '</tr>').join('');

    body.innerHTML=
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px">'+
        '<div><div style="font-size:15px;font-weight:800">'+safe(r.funcionario.nome)+'</div>'+
        '<div style="font-size:11px;color:var(--muted)">Período: '+dataBR(r.inicio)+' a '+dataBR(r.fim)+'</div>'+
        '<div style="font-size:11px;color:var(--muted);margin-top:3px">Forma de pagamento: <b>'+safe(formaLabel)+'</b></div></div>'+
        '<button class="btn btn-p" onclick="imprimirTermoRetiradas()">🖨️ Imprimir termo</button>'+
      '</div>'+
      '<table class="rel-table"><thead><tr><th>Data</th><th>Produto</th><th>Qtd.</th><th>Valor a descontar</th></tr></thead><tbody>'+
        (linhas||'<tr><td colspan="4">Nenhum valor em aberto neste período.</td></tr>')+
      '</tbody></table>'+
      '<div style="margin-top:14px;background:#fff1f2;border:1px solid #fecdd3;border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center">'+
        '<b>TOTAL DO DESCONTO</b><span style="font-size:22px;font-weight:900;color:#b91c1c">'+brl(r.totais.desconto)+'</span>'+
      '</div>';
  };
  window.imprimirTermoRetiradas = function(){
    const r=termoAtual;
    if(!r){ window.BB?.toast?.('⚠️ Gere o termo primeiro'); return; }
    if(!(r.itens||[]).length){ window.BB?.toast?.('⚠️ Não há valores em aberto no período'); return; }

    const formaLabel=formaAtual==='vale'?'Desconto no Vale Alimentação':'Pagamento via PIX';
    const linhas=(r.itens||[]).map(x=>'<tr>'+
      '<td>'+dataBR(x.dt_retirada)+'</td>'+
      '<td>'+safe(x.descricao||x.produto_descricao||'—')+'</td>'+
      '<td class="n">'+qtd(x.qtd)+'</td>'+
      '<td class="n"><b>'+brl(x.saldo_restante)+'</b></td>'+
    '</tr>').join('');

    const html='<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Retiradas - '+safe(r.funcionario.nome)+'</title>'+
      '<style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:11px;margin:0}.head{border-bottom:3px solid #8B0000;padding-bottom:9px;margin-bottom:16px}h1{font-size:18px;color:#8B0000;margin:0 0 4px}.sub{font-size:10px;color:#555}.info{display:grid;grid-template-columns:1.7fr 1fr;gap:8px;margin-bottom:14px}.box{border:1px solid #ccc;border-radius:5px;padding:8px}table{width:100%;border-collapse:collapse;font-size:10.5px}th{background:#8B0000;color:#fff;padding:7px;text-align:left}td{padding:7px;border-bottom:1px solid #ddd}.n{text-align:right}.total{margin-top:14px;border:2px solid #8B0000;border-radius:6px;padding:12px;display:flex;justify-content:space-between;align-items:center;font-size:14px}.total strong:last-child{font-size:20px;color:#8B0000}.pagto{margin-top:16px;border:1px solid #aaa;border-radius:6px;padding:12px;font-size:12px}.decl{margin-top:16px;line-height:1.55;text-align:justify}.assinaturas{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:52px}.linha{border-top:1px solid #222;text-align:center;padding-top:6px;font-size:10px}.rodape{margin-top:22px;font-size:9px;color:#666}</style></head><body>'+
      '<div class="head"><h1>Bom Beef — Relatório de Retiradas</h1><div class="sub">Termo de conferência e autorização de pagamento</div></div>'+
      '<div class="info"><div class="box"><b>Funcionário:</b> '+safe(r.funcionario.nome)+'</div><div class="box"><b>Período:</b> '+dataBR(r.inicio)+' a '+dataBR(r.fim)+'</div></div>'+
      '<table><thead><tr><th>Data</th><th>Produto</th><th>Qtd.</th><th style="text-align:right">Valor</th></tr></thead><tbody>'+linhas+'</tbody></table>'+
      '<div class="total"><strong>TOTAL DO DESCONTO</strong><strong>'+brl(r.totais.desconto)+'</strong></div>'+
      '<div class="pagto"><b>Forma de pagamento escolhida:</b> '+safe(formaLabel)+'</div>'+
      '<div class="decl">Declaro que conferi os produtos, datas e valores relacionados acima, reconheço o total informado e estou de acordo com a forma de pagamento escolhida.</div>'+
      '<div style="margin-top:22px">Valinhos, ______ de __________________________ de __________.</div>'+
      '<div class="assinaturas"><div class="linha">'+safe(r.funcionario.nome)+'<br>Funcionário</div><div class="linha">Responsável Bom Beef</div></div>'+
      '<div class="rodape">Documento emitido pelo Sistema de Gestão Bom Beef.</div>'+
      '</body></html>';

    const w=window.open('','_blank','width=900,height=760');
    if(!w){ window.BB?.toast?.('⚠️ Permita pop-ups para imprimir o termo'); return; }
    w.document.open();w.document.write(html);w.document.close();
    w.onload=function(){w.focus();w.print();};
  };
})();