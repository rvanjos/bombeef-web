(function(root){
'use strict';

const st={
  view:localStorage.getItem('dre-main-view')||'demonstrativo',
  q:'',grupo:'nenhum',status:'todos',origem:'todas',
  sel:new Set(),detalhe:null,gruposFechados:new Set(),
  limite:300,
  ferramentas:localStorage.getItem('dre-ferramentas')==='1'
};

const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
const brl=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const txs=()=>{try{if(typeof root.getDreTransactions==='function'){const v=root.getDreTransactions();if(Array.isArray(v))return v;}}catch(_){}return Array.isArray(root.TXS)?root.TXS:[];};
const fornecedor=t=>t?.razaoSocial||t?.fornecedor||t?.portador||t?.boletoFornecedor||'';
const descricao=t=>t?.lancamento||t?.descricao||'Sem descrição';
const origem=t=>{
  const f=String(t?.fonte||'').toUpperCase();
  if(f==='CC')return'Cartão';
  if(f==='OFX'||f==='EXTRATO')return'Banco';
  if(f.startsWith('BOLETO'))return'Boleto';
  if(f==='MANUAL')return'Manual';
  return f||'Outro';
};
const status=t=>{
  if(t?.ignorar)return'IGNORADO';
  if(t?.needsReview)return'REVISAR';
  if(!t?.categoria)return'PENDENTE';
  if(t?.boletoId||t?.vinculadoFaturaCC||t?.faturaCC)return'VINCULADO';
  return'CLASSIFICADO';
};
const dataBr=v=>{
  const s=String(v||'');
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m)return `${m[3]}/${m[2]}/${m[1]}`;
  return s||'—';
};
const temVinculo=t=>!!(t?.boletoId||t?.vinculadoFaturaCC||t?.faturaCC||t?.cartao_fatura_id||t?.cartaoItemRef);

function css(){
  if(document.getElementById('dre-workspace-v3-style'))return;
  const s=document.createElement('style');
  s.id='dre-workspace-v3-style';
  s.textContent=`
  #dre-main-tabs{display:flex;align-items:center;gap:6px;padding:8px 14px;background:#fff;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:45;box-shadow:0 1px 6px rgba(0,0,0,.04)}
  .dre-main-tab{border:1px solid var(--border);background:#fff;border-radius:8px;padding:7px 12px;font-weight:700;font-size:12px;cursor:pointer;color:var(--text)}
  .dre-main-tab:hover{border-color:var(--red);color:var(--red)}
  .dre-main-tab.active{background:var(--red);color:#fff;border-color:var(--red)}
  .dre-ws-spacer{flex:1}
  .dre-ws-tools{border:1px solid var(--border);background:#fff;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:700;cursor:pointer;color:var(--muted)}
  .dre-ws-tools.on{background:#fff7ed;border-color:#fdba74;color:#9a3412}

  body.dre-clean:not(.dre-tools-open) .toolbar-top{display:none!important}
  body.dre-clean:not(.dre-tools-open) #painel-pendencias{display:none!important}
  body.dre-clean:not(.dre-tools-open) #dz-area{display:none!important}
  body.dre-clean:not(.dre-tools-open) .banner.show{display:none!important}
  body.dre-clean .ctrl{padding:7px 12px}
  body.dre-clean .stats-grid{padding-top:8px;padding-bottom:8px}
  body.dre-clean .totals-row{padding-bottom:8px}

  #dre-lanc-area{display:none;flex:1;overflow:auto;background:#f7f4f0;padding:14px}
  body.dre-view-lancamentos #dre-lanc-area{display:block!important}
  body.dre-view-lancamentos #tbl-area,
  body.dre-view-lancamentos #painel-pendencias,
  body.dre-view-lancamentos .dre-p,
  body.dre-view-lancamentos .ctrl,
  body.dre-view-lancamentos .stats-grid,
  body.dre-view-lancamentos .totals-row,
  body.dre-view-lancamentos .prog,
  body.dre-view-lancamentos .banner{display:none!important}
  body.dre-view-conciliacao #tbl-area,body.dre-view-conciliacao #painel-pendencias,body.dre-view-conciliacao .dre-p,body.dre-view-conciliacao .ctrl,body.dre-view-conciliacao .stats-grid,body.dre-view-conciliacao .totals-row,body.dre-view-conciliacao .prog,body.dre-view-conciliacao .banner{display:none!important}
  body.dre-view-planejamento #tbl-area,body.dre-view-planejamento #painel-pendencias,body.dre-view-planejamento .dre-p,body.dre-view-planejamento .ctrl,body.dre-view-planejamento .stats-grid,body.dre-view-planejamento .totals-row,body.dre-view-planejamento .prog,body.dre-view-planejamento .banner{display:none!important}

  .dla-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
  .dla-title{font-size:20px;font-weight:800;line-height:1.1}
  .dla-sub{font-size:11px;color:var(--muted);margin-top:4px;max-width:680px}
  .dla-top-actions{display:flex;gap:7px;flex-wrap:wrap}
  .dla-kpis{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px;margin-bottom:10px}
  .dla-kpi{background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.03)}
  .dla-kpi b{display:block;font-size:18px;line-height:1.1}
  .dla-kpi span{font-size:10px;color:var(--muted)}
  .dla-kpi.warn{border-left:4px solid #d97706}.dla-kpi.red{border-left:4px solid #b91c1c}.dla-kpi.green{border-left:4px solid #15803d}.dla-kpi.blue{border-left:4px solid #2563eb}
  .dla-filtros{display:grid;grid-template-columns:minmax(260px,2fr) repeat(3,minmax(140px,1fr));gap:8px;background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:10px}
  .dla-filtros input,.dla-filtros select{padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:12px;background:#fff}
  .dla-filtros input:focus,.dla-filtros select:focus{outline:none;border-color:var(--red)}
  .dla-bulk{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;padding:9px 10px;margin-bottom:10px}
  .dla-bulk select{padding:7px 9px;border:1px solid #fdba74;border-radius:7px;min-width:260px}
  .dla-group{background:#fff;border:1px solid var(--border);border-radius:10px;margin-bottom:9px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.025)}
  .dla-gh{padding:9px 11px;background:#f8f6f3;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:11px;cursor:pointer}
  .dla-gh-left{display:flex;align-items:center;gap:7px}.dla-gh strong{font-size:12px}
  .dla-gh-right{color:var(--muted);display:flex;gap:12px;white-space:nowrap}
  .dla-headrow,.dla-row{display:grid;grid-template-columns:30px 84px 86px minmax(230px,1.8fr) minmax(170px,1.2fr) 138px 108px 92px;gap:8px;align-items:center;padding:0 10px}
  .dla-headrow{min-height:32px;background:#fcfbfa;border-bottom:1px solid #eee;font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:800;letter-spacing:.4px}
  .dla-row{min-height:48px;border-bottom:1px solid #f1ede8;font-size:11px}
  .dla-row:last-child{border-bottom:none}
  .dla-row:hover{background:#fdfaf7}
  .dla-desc{min-width:0}.dla-desc strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dla-desc small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
  .dla-cat{width:100%;padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:11px;background:#fff}
  .dla-cat.pendente{border-color:#f59e0b;background:#fffbeb}
  .dla-status{font-size:9px;font-weight:800;padding:3px 6px;border-radius:999px;text-align:center;background:#eef2f7;color:#475569}
  .dla-status.PENDENTE{background:#fef3c7;color:#92400e}.dla-status.REVISAR{background:#fee2e2;color:#991b1b}.dla-status.CLASSIFICADO{background:#dcfce7;color:#166534}.dla-status.VINCULADO{background:#dbeafe;color:#1d4ed8}.dla-status.IGNORADO{background:#e5e7eb;color:#6b7280}
  .dla-val{text-align:right;font-weight:800;font-family:'DM Mono',monospace}.dla-val.neg{color:#c0392b}.dla-val.pos{color:#1a7a4a}
  .dla-act{display:flex;gap:4px;justify-content:flex-end}.dla-act button{border:1px solid var(--border);background:#fff;border-radius:6px;padding:4px 7px;cursor:pointer}.dla-act button:hover{border-color:var(--red);color:var(--red)}
  .dla-empty{padding:36px;text-align:center;color:var(--muted);background:#fff;border:1px dashed var(--border);border-radius:10px}
  .dla-note{font-size:10px;color:var(--muted);margin:6px 2px 10px}

  #dre-lanc-drawer{position:fixed;top:0;right:-440px;width:min(440px,100vw);height:100vh;background:#fff;z-index:500;box-shadow:-12px 0 30px rgba(0,0,0,.16);transition:right .2s;display:flex;flex-direction:column}
  #dre-lanc-drawer.open{right:0}
  #dre-lanc-drawer-bg{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:499;display:none}
  #dre-lanc-drawer-bg.open{display:block}
  .dld-head{padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
  .dld-title{font-size:15px;font-weight:800}.dld-close{border:0;background:none;font-size:22px;cursor:pointer;color:var(--muted)}
  .dld-body{padding:16px 18px;overflow:auto;flex:1}
  .dld-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
  .dld-field{background:#faf9f7;border:1px solid var(--border);border-radius:8px;padding:9px}.dld-field span{display:block;font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:800;margin-bottom:3px}.dld-field b{font-size:11px;word-break:break-word}
  .dld-section{font-size:10px;color:var(--muted);font-weight:800;text-transform:uppercase;margin:14px 0 6px}
  .dld-actions{display:flex;gap:7px;flex-wrap:wrap}
  .dld-warning{padding:9px 10px;border-radius:8px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;font-size:10px;margin-bottom:10px}

  @media(max-width:1050px){
    .dla-kpis{grid-template-columns:repeat(3,1fr)}
    .dla-filtros{grid-template-columns:1fr 1fr}
    .dla-headrow,.dla-row{grid-template-columns:28px 82px minmax(200px,1.8fr) 150px 105px 86px}
    .dla-headrow>*:nth-child(3),.dla-row>*:nth-child(3),
    .dla-headrow>*:nth-child(5),.dla-row>*:nth-child(5){display:none}
  }
  @media(max-width:700px){
    #dre-main-tabs{overflow-x:auto;padding:6px 8px}.dre-main-tab{white-space:nowrap;padding:6px 9px;font-size:11px}.dre-ws-tools{white-space:nowrap}
    #dre-lanc-area{padding:9px}.dla-top{flex-direction:column}.dla-kpis{grid-template-columns:1fr 1fr}.dla-filtros{grid-template-columns:1fr}
    .dla-headrow{display:none}.dla-row{grid-template-columns:28px minmax(0,1fr) auto;padding:9px}
    .dla-row>*{display:none!important}.dla-row>*:nth-child(1),.dla-row>*:nth-child(4),.dla-row>*:nth-child(7){display:block!important}
    .dla-row>*:nth-child(7){grid-column:3}.dla-desc strong{white-space:normal}.dla-desc small{white-space:normal}
    .dla-gh-right{display:none}.dld-grid{grid-template-columns:1fr}
  }`;
  document.head.appendChild(s);
}

function nav(){
  let n=document.getElementById('dre-main-tabs');
  if(!n){
    const ph=document.querySelector('.ph');
    if(!ph)return;
    n=document.createElement('div');n.id='dre-main-tabs';
    ph.insertAdjacentElement('afterend',n);
  }
  n.innerHTML=`
    <button class="dre-main-tab" data-v="demonstrativo">📊 Demonstrativo</button>
    <button class="dre-main-tab" data-v="lancamentos">🧾 Lançamentos</button>
    <button class="dre-main-tab" data-v="conferencia">🔎 Conferência</button>
    <button class="dre-main-tab" data-v="conciliacao">🔗 Conciliação</button>
    <button class="dre-main-tab" data-v="planejamento">📅 Planejamento</button>
    <span class="dre-ws-spacer"></span>
    <button class="dre-ws-tools ${st.ferramentas?'on':''}" id="dre-tools-btn">⚙️ ${st.ferramentas?'Ocultar ferramentas':'Ferramentas'}</button>`;
  n.querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>setView(b.dataset.v));
  n.querySelector('#dre-tools-btn').onclick=toggleFerramentas;
}

function area(){
  if(!document.getElementById('dre-lanc-area')){
    const main=document.querySelector('.main');
    if(!main)return;
    const a=document.createElement('section');a.id='dre-lanc-area';main.prepend(a);
  }
  if(!document.getElementById('dre-lanc-drawer')){
    const bg=document.createElement('div');bg.id='dre-lanc-drawer-bg';bg.onclick=fecharDetalhes;document.body.appendChild(bg);
    const d=document.createElement('aside');d.id='dre-lanc-drawer';document.body.appendChild(d);
  }
}

function toggleFerramentas(){
  st.ferramentas=!st.ferramentas;
  localStorage.setItem('dre-ferramentas',st.ferramentas?'1':'0');
  document.body.classList.toggle('dre-tools-open',st.ferramentas);
  nav();marcarTab();
}

function marcarTab(){
  document.querySelectorAll('.dre-main-tab').forEach(b=>b.classList.toggle('active',b.dataset.v===st.view));
}

function setView(v){
  if(v==='conferencia'){
    if(typeof root.abrirConferenciaDRE==='function')root.abrirConferenciaDRE();
    return;
  }
  st.view=v;
  localStorage.setItem('dre-main-view',v);
  document.body.classList.toggle('dre-view-lancamentos',v==='lancamentos');
  document.body.classList.toggle('dre-view-demonstrativo',v==='demonstrativo');
  document.body.classList.toggle('dre-view-conciliacao',v==='conciliacao');
  document.body.classList.toggle('dre-view-planejamento',v==='planejamento');
  document.body.classList.add('dre-clean');
  document.body.classList.toggle('dre-tools-open',st.ferramentas);
  marcarTab();
  if(v==='lancamentos')render();
  if((v==='conciliacao'||v==='planejamento')&&typeof root.dreFinanceViewRender==='function') root.dreFinanceViewRender(v);
}
root.dreSetView=setView;

let _catValsCache=null;
function catVals(){
  if(_catValsCache) return _catValsCache;
  const dl=document.getElementById('cats-dl');
  const vals=dl?[...dl.querySelectorAll('option')].map(o=>o.value).filter(Boolean):[];
  _catValsCache=[...new Set(vals)];
  return _catValsCache;
}
function catOptions(cur){
  const all=[...new Set([cur,...catVals()].filter(Boolean))];
  return '<option value="">— Sem categoria —</option>'+all.map(x=>`<option value="${esc(x)}" ${x===cur?'selected':''}>${esc(x)}</option>`).join('');
}

function passa(t){
  if(!t)return false;
  const blob=norm([descricao(t),fornecedor(t),t.categoria,t.fonte,t.valor,t.data,t.nf,t.parcela].join(' '));
  if(st.q&&!blob.includes(norm(st.q)))return false;
  if(st.status!=='todos'&&status(t)!==st.status)return false;
  if(st.origem!=='todas'&&origem(t)!==st.origem)return false;
  return true;
}
function listaFiltrada(){return txs().filter(passa);}
function chaveGrupo(t){
  if(st.grupo==='fornecedor')return fornecedor(t)||'Sem fornecedor';
  if(st.grupo==='categoria')return t.categoria||'Sem categoria';
  if(st.grupo==='origem')return origem(t);
  if(st.grupo==='data')return dataBr(t.data);
  if(st.grupo==='status')return status(t);
  return'';
}
function grupos(l=listaFiltrada()){
  if(st.grupo==='nenhum')return[['',l]];
  const m=new Map();
  l.forEach(t=>{const k=chaveGrupo(t);if(!m.has(k))m.set(k,[]);m.get(k).push(t);});
  return [...m.entries()].sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'pt-BR'));
}

function row(t){
  const s=status(t),v=Number(t.valor||0),id=String(t.id);
  return `<div class="dla-row" data-id="${esc(id)}">
    <input type="checkbox" ${st.sel.has(id)?'checked':''} onchange="dreLancSel('${esc(id)}',this.checked)">
    <span>${esc(dataBr(t.data))}</span>
    <span>${esc(origem(t))}</span>
    <div class="dla-desc"><strong title="${esc(descricao(t))}">${esc(descricao(t))}</strong><small>${esc(fornecedor(t)||'Sem fornecedor')}</small></div>
    <input class="dla-cat ${!t.categoria?'pendente':''}" list="cats-dl" value="${esc(t.categoria||'')}" placeholder="— Sem categoria —" onchange="setCat('${esc(id)}',this.value);dreLancRefresh()">
    <span class="dla-status ${esc(s)}">${esc(s)}</span>
    <span class="dla-val ${v<0?'neg':'pos'}">${brl(v)}</span>
    <div class="dla-act">
      <button title="${t.ignorar?'Reativar':'Ignorar'}" onclick="togIgn('${esc(id)}');dreLancRefresh()">${t.ignorar?'↩️':'🚫'}</button>
      <button title="Abrir detalhes" onclick="dreLancDetalhes('${esc(id)}')">Ver</button>
    </div>
  </div>`;
}

function render(){
  const a=document.getElementById('dre-lanc-area');if(!a)return;
  const l=listaFiltrada();
  const ativos=l.filter(t=>!t.ignorar);
  const pend=ativos.filter(t=>!t.categoria).length;
  const rev=ativos.filter(t=>t.needsReview).length;
  const vinc=ativos.filter(temVinculo).length;
  const ign=l.filter(t=>t.ignorar).length;
  const visiveis=l.slice(0,st.limite);
  const gs=grupos(visiveis);

  a.innerHTML=`
    <div class="dla-top">
      <div><div class="dla-title">Lançamentos</div><div class="dla-sub">Aqui você corrige e organiza os dados. O Demonstrativo fica apenas para leitura do resultado e a Conferência somente para inconsistências.</div></div>
      <div class="dla-top-actions">
        <button class="btn bs" onclick="dreLancSelecionarVisiveis()">Selecionar visíveis</button>
        <button class="btn bs" onclick="setTimeout(()=>{if(typeof abrirConferenciaDRE==='function')abrirConferenciaDRE()},0)">Abrir Conferência</button>
      </div>
    </div>
    <div class="dla-kpis">
      <div class="dla-kpi blue"><b>${ativos.length}</b><span>Lançamentos ativos</span></div>
      <div class="dla-kpi warn"><b>${pend}</b><span>Sem categoria</span></div>
      <div class="dla-kpi red"><b>${rev}</b><span>Precisam revisão</span></div>
      <div class="dla-kpi green"><b>${vinc}</b><span>Vinculados</span></div>
      <div class="dla-kpi"><b>${ign}</b><span>Ignorados</span></div>
    </div>
    <div class="dla-filtros">
      <input placeholder="Buscar fornecedor, descrição, categoria, NF, valor..." value="${esc(st.q)}" oninput="dreLancBusca(this.value)">
      <select onchange="dreLancGrupo(this.value)">
        <option value="nenhum">Sem agrupamento</option>
        <option value="fornecedor">Agrupar por fornecedor</option>
        <option value="categoria">Agrupar por categoria</option>
        <option value="origem">Agrupar por origem</option>
        <option value="data">Agrupar por data</option>
        <option value="status">Agrupar por status</option>
      </select>
      <select onchange="dreLancStatus(this.value)">
        <option value="todos">Todos os status</option>
        ${['PENDENTE','REVISAR','CLASSIFICADO','VINCULADO','IGNORADO'].map(x=>`<option value="${x}" ${st.status===x?'selected':''}>${x}</option>`).join('')}
      </select>
      <select onchange="dreLancOrigem(this.value)">
        <option value="todas">Todas as origens</option>
        ${['Banco','Cartão','Boleto','Manual','Outro'].map(x=>`<option value="${x}" ${st.origem===x?'selected':''}>${x}</option>`).join('')}
      </select>
    </div>
    <div class="dla-note">Dica: agrupe por fornecedor para corrigir categorias repetidas com mais segurança. Use a Conferência quando o sistema detectar inconsistência.</div>
    ${st.sel.size?`<div class="dla-bulk"><strong>${st.sel.size} selecionado(s)</strong><select id="dla-bulk-cat"><option value="">Escolha a categoria...</option>${catOptions('').replace('<option value="">— Sem categoria —</option>','')}</select><button class="btn bg" onclick="dreLancAplicarLote()">Aplicar categoria</button><button class="btn bs" onclick="dreLancLimparSel()">Limpar seleção</button></div>`:''}
    ${visiveis.length?gs.map(([k,it])=>{
      const key=encodeURIComponent(k||'_todos_'),fechado=st.gruposFechados.has(key);
      return `<div class="dla-group">
        ${st.grupo!=='nenhum'?`<div class="dla-gh" onclick="dreLancToggleGrupo('${key}')"><div class="dla-gh-left"><span>${fechado?'▸':'▾'}</span><strong>${esc(k)}</strong></div><div class="dla-gh-right"><span>${it.length} lançamento(s)</span><span>${brl(it.reduce((s,t)=>s+Number(t.valor||0),0))}</span></div></div>`:''}
        ${fechado?'':`<div class="dla-headrow"><span></span><span>Data</span><span>Origem</span><span>Lançamento / fornecedor</span><span>Categoria</span><span>Status</span><span style="text-align:right">Valor</span><span style="text-align:right">Ações</span></div>${it.map(row).join('')}`}
      </div>`;
    }).join(''):'<div class="dla-empty">Nenhum lançamento encontrado com estes filtros.</div>'}
    ${l.length>visiveis.length?`<div style="display:flex;justify-content:center;padding:14px"><button class="btn bs" onclick="dreLancMais()">Mostrar mais ${Math.min(300,l.length-visiveis.length)} de ${l.length-visiveis.length} restantes</button></div>`:''}
  `;
  const sels=a.querySelectorAll('.dla-filtros select');
  if(sels[0])sels[0].value=st.grupo;
}

function detalheHtml(t){
  const id=String(t.id);
  const v=Number(t.valor||0);
  const vinculacao=temVinculo(t);
  return `
    <div class="dld-head"><div><div class="dld-title">${esc(descricao(t))}</div><div style="font-size:10px;color:var(--muted);margin-top:3px">${esc(fornecedor(t)||'Sem fornecedor')}</div></div><button class="dld-close" onclick="dreLancFecharDetalhes()">×</button></div>
    <div class="dld-body">
      ${vinculacao?'<div class="dld-warning">🔗 Este lançamento possui vínculo financeiro. Revise o vínculo antes de excluir para não quebrar a conciliação.</div>':''}
      <div class="dld-grid">
        <div class="dld-field"><span>Data</span><b>${esc(dataBr(t.data))}</b></div>
        <div class="dld-field"><span>Valor</span><b>${esc(brl(v))}</b></div>
        <div class="dld-field"><span>Origem</span><b>${esc(origem(t))}</b></div>
        <div class="dld-field"><span>Status</span><b>${esc(status(t))}</b></div>
        <div class="dld-field"><span>Mês DRE</span><b>${esc(t.mes||'—')}</b></div>
        <div class="dld-field"><span>Mês Caixa</span><b>${esc(t.mesCaixa||'—')}</b></div>
        <div class="dld-field"><span>NF / referência</span><b>${esc(t.nf||t.fitid||t.referencia||'—')}</b></div>
        <div class="dld-field"><span>ID</span><b>${esc(id)}</b></div>
      </div>
      <div class="dld-section">Categoria</div>
      <select class="dla-cat ${!t.categoria?'pendente':''}" style="width:100%;margin-bottom:12px" onchange="setCat('${esc(id)}',this.value);dreLancRefresh();dreLancDetalhes('${esc(id)}')">${catOptions(t.categoria||'')}</select>
      <div class="dld-section">Ações</div>
      <div class="dld-actions">
        <button class="btn bs" onclick="togIgn('${esc(id)}');dreLancRefresh();dreLancDetalhes('${esc(id)}')">${t.ignorar?'↩️ Reativar':'🚫 Ignorar'}</button>
        ${!vinculacao && typeof root.excluirLanc==='function'? `<button class="btn br" onclick="dreLancExcluir('${esc(id)}')">🗑️ Excluir lançamento</button>`:''}
      </div>
    </div>`;
}
function abrirDetalhes(id){
  const t=txs().find(x=>String(x.id)===String(id));if(!t)return;
  st.detalhe=id;
  const d=document.getElementById('dre-lanc-drawer'),bg=document.getElementById('dre-lanc-drawer-bg');
  d.innerHTML=detalheHtml(t);d.classList.add('open');bg.classList.add('open');
}
function fecharDetalhes(){st.detalhe=null;document.getElementById('dre-lanc-drawer')?.classList.remove('open');document.getElementById('dre-lanc-drawer-bg')?.classList.remove('open');}
function refresh(){_catValsCache=null;if(st.view==='lancamentos')setTimeout(render,20);}
function wrapRender(){
  if(root.__dreWsWrapped||typeof root.render!=='function')return;
  root.__dreWsWrapped=true;
  const base=root.render;
  root.render=function(){const r=base.apply(this,arguments);refresh();return r;};
}

root.dreLancRefresh=refresh;
root.dreLancBusca=v=>{st.q=v;st.limite=300;render();};
root.dreLancGrupo=v=>{st.grupo=v;st.limite=300;render();};
root.dreLancMais=()=>{st.limite+=300;render();};
root.dreLancStatus=v=>{st.status=v;render();};
root.dreLancOrigem=v=>{st.origem=v;render();};
root.dreLancSel=(id,on)=>{on?st.sel.add(String(id)):st.sel.delete(String(id));render();};
root.dreLancLimparSel=()=>{st.sel.clear();render();};
root.dreLancSelecionarVisiveis=()=>{listaFiltrada().forEach(t=>st.sel.add(String(t.id)));render();};
root.dreLancToggleGrupo=k=>{st.gruposFechados.has(k)?st.gruposFechados.delete(k):st.gruposFechados.add(k);render();};
root.dreLancAplicarLote=()=>{
  const cat=document.getElementById('dla-bulk-cat')?.value;
  if(!cat)return alert('Escolha uma categoria.');
  if(!confirm(`Aplicar "${cat}" em ${st.sel.size} lançamento(s)?`))return;
  [...st.sel].forEach(id=>{if(typeof root.setCat==='function')root.setCat(id,cat);});
  st.sel.clear();render();
};
root.dreLancDetalhes=abrirDetalhes;
root.dreLancFecharDetalhes=fecharDetalhes;
root.dreLancExcluir=id=>{
  const t=txs().find(x=>String(x.id)===String(id));if(!t)return;
  if(temVinculo(t)){alert('Este lançamento possui vínculo financeiro. Desvincule antes de excluir.');return;}
  fecharDetalhes();
  root.excluirLanc(id);
  setTimeout(refresh,80);
};

function init(){
  css();nav();area();wrapRender();
  document.body.classList.add('dre-clean');
  document.body.classList.toggle('dre-tools-open',st.ferramentas);
  setView(['lancamentos','conciliacao','planejamento'].includes(st.view)?st.view:'demonstrativo');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,180));else setTimeout(init,180);
})(window);
