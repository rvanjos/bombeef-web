(function(root){
'use strict';

const state={decisoes:[],carregado:false,mostrar:'pendentes',grupos:new Map(),renderBase:null,abrirBase:null,analisarBase:null};
const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl=v=>'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const dataBr=v=>{const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}/${m[2]}/${m[1]}`:(v||'—');};

function catsNorm(g){return (g.categorias||[]).map(norm).filter(Boolean).sort();}
function chaveMes(g){return `CAT|${g.mes||''}|${norm(g.fornecedor)}|${catsNorm(g).join('~')}`.slice(0,220);}
function chaveFornecedor(g){return `CATF|${norm(g.fornecedor)}|${catsNorm(g).join('~')}`.slice(0,220);}
function decisaoExata(g){
  const k=chaveMes(g);
  const f=norm(g.fornecedor); const cats=catsNorm(g);
  const ex=state.decisoes.find(d=>d.chave===k && ['VALIDADO','CORRIGIDO'].includes(String(d.status||'').toUpperCase()));
  if(ex) return ex;
  return state.decisoes.find(d=>String(d.escopo||'').toUpperCase()==='FORNECEDOR' && norm(d.fornecedor_norm)===f && (()=>{
    const permitidas=(d.categorias_json||[]).map(norm);
    return cats.length>0 && cats.every(c=>permitidas.includes(c));
  })()) || null;
}
function mesAtual(){
  const el=document.getElementById('f-mes');
  return el?.value || (typeof mesRef!=='undefined'?mesRef:'') || '';
}
async function carregar(force){
  if(state.carregado&&!force) return;
  try{
    const q=mesAtual()?`?mes_ref=${encodeURIComponent(mesAtual())}`:'';
    const r=await api.get('/api/dre/conferencia-v2/decisoes'+q);
    if(r?.ok){state.decisoes=Array.isArray(r.data)?r.data:[];state.carregado=true;}
  }catch(e){console.warn('[DRE Conferência v2] decisões indisponíveis:',e.message);}
}
function aplicarDecisoes(a){
  if(!a) return a;
  const todas=(a.categoriasInconsistentes||[]).map(g=>{
    const d=decisaoExata(g);
    return Object.assign({},g,{_confV2Chave:chaveMes(g),_confV2Fornecedor:chaveFornecedor(g),_confV2Decisao:d,_confV2Status:d?.status||'PENDENTE'});
  });
  a._categoriasTodas=todas;
  a.categoriasInconsistentes=todas.filter(g=>!g._confV2Decisao);
  a.totalAlertas=(a.reimportacoes?.length||0)+(a.pagamentosParecidos?.length||0)+(a.mesesInvalidos?.length||0)+a.categoriasInconsistentes.length;
  return a;
}
function instalarAnalise(){
  if(!root.DREConferencia||state.analisarBase) return;
  state.analisarBase=root.DREConferencia.analisar.bind(root.DREConferencia);
  root.DREConferencia.analisar=function(txs){return aplicarDecisoes(state.analisarBase(txs));};
}
function badge(status){
  const s=String(status||'PENDENTE').toUpperCase();
  const cfg=s==='CORRIGIDO'?['#dbeafe','#1d4ed8','CORRIGIDO']:s==='VALIDADO'?['#dcfce7','#166534','VALIDADO']:['#fef3c7','#92400e','PENDENTE'];
  return `<span style="background:${cfg[0]};color:${cfg[1]};padding:3px 8px;border-radius:999px;font-size:10px;font-weight:800">${cfg[2]}</span>`;
}
function editorGrupo(g){
  return `<div id="confv2-ed-${btoa(unescape(encodeURIComponent(g._confV2Chave))).replace(/=/g,'')}" style="display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Edite as categorias abaixo. Nenhuma correção é feita automaticamente.</div>
    <div style="overflow:auto"><table style="width:100%;font-size:11px"><thead><tr><th>Data</th><th>Lançamento</th><th>Origem</th><th>Valor</th><th>Categoria</th></tr></thead><tbody>
    ${(g.transacoes||[]).map(t=>`<tr><td>${esc(dataBr(t.data))}</td><td><strong>${esc(t.descricao||'—')}</strong><div style="color:var(--muted);font-size:10px">${esc(t.fornecedor||'')}</div></td><td>${esc(t.fonte||'—')}</td><td style="white-space:nowrap">${brl(Math.abs(Number(t.valor||0)))}</td><td><input list="cats-dl" value="${esc(t.categoria||'')}" style="width:220px;max-width:100%;padding:5px 7px;border:1px solid var(--border);border-radius:6px" onchange="setCat('${esc(t.id)}',this.value)"></td></tr>`).join('')}
    </tbody></table></div>
    <div style="display:flex;justify-content:flex-end;gap:7px;margin-top:9px"><button class="btn bs" onclick="confV2ToggleEditor('${esc(g._confV2Chave)}')">Cancelar</button><button class="btn bg" onclick="confV2ConcluirCorrecao('${esc(g._confV2Chave)}')">✅ Concluir correção</button></div>
  </div>`;
}
function cardGrupo(g){
  state.grupos.set(g._confV2Chave,g);
  const d=g._confV2Decisao;
  return `<div class="conf-card" style="border-left:4px solid ${d?'#16a34a':'#d97706'};margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
      <div><div style="font-weight:800;font-size:13px">${esc(g.fornecedor||'Fornecedor')} · ${esc(g.mes||'—')}</div><div style="font-size:10px;color:var(--muted);margin-top:3px">${(g.categorias||[]).map(esc).join(' · ')}</div></div>
      <div style="display:flex;gap:6px;align-items:center">${badge(d?.status||'PENDENTE')}<span class="conf-pill" style="background:#f3f4f6;color:#475569">${g.transacoes?.length||0} lançamentos</span></div>
    </div>
    <div style="margin-top:9px;display:grid;gap:5px">${(g.transacoes||[]).map(t=>`<div style="display:grid;grid-template-columns:85px minmax(180px,1fr) 120px 120px;gap:8px;align-items:center;padding:7px 8px;background:#fafafa;border:1px solid #eee;border-radius:7px;font-size:11px"><span>${esc(dataBr(t.data))}</span><span><strong>${esc(t.descricao||'—')}</strong><small style="display:block;color:var(--muted)">${esc(t.fonte||'—')}</small></span><span>${esc(t.categoria||'Sem categoria')}</span><strong style="text-align:right">${brl(Math.abs(Number(t.valor||0)))}</strong></div>`).join('')}</div>
    ${d?`<div style="font-size:10px;color:#166534;margin-top:8px">Decisão registrada por ${esc(d.usuario_nome||'usuário')} em ${esc(new Date(d.atualizado_em||d.criado_em).toLocaleString('pt-BR'))}${d.justificativa?` · ${esc(d.justificativa)}`:''}</div>`:`<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px"><button class="btn bg" onclick="confV2Salvar('${esc(g._confV2Chave)}','MES')">✓ Está correto neste mês</button><button class="btn bs" onclick="confV2Salvar('${esc(g._confV2Chave)}','FORNECEDOR')">✓ Fornecedor pode usar estas categorias</button><button class="btn bp" onclick="confV2ToggleEditor('${esc(g._confV2Chave)}')">✏️ Corrigir os lançamentos</button></div>${editorGrupo(g)}`}
  </div>`;
}
function historicoResolvido(){
  const hist=state.decisoes.filter(d=>['VALIDADO','CORRIGIDO'].includes(String(d.status||'').toUpperCase()));
  if(!hist.length) return '<div style="padding:28px;text-align:center;color:var(--muted)">Nenhuma decisão registrada ainda.</div>';
  return hist.map(d=>`<div class="conf-card" style="border-left:4px solid ${d.status==='CORRIGIDO'?'#2563eb':'#16a34a'}"><div style="display:flex;justify-content:space-between;gap:10px"><div><strong>${esc(d.fornecedor_norm||d.tipo||'Conferência')}</strong><div style="font-size:10px;color:var(--muted);margin-top:3px">${esc(d.mes_ref||'Regra permanente')} · ${esc((d.categorias_json||[]).join(' · '))}</div></div>${badge(d.status)}</div><div style="font-size:10px;color:var(--muted);margin-top:7px">${esc(d.decisao)} · ${esc(d.usuario_nome||'usuário')} · ${esc(new Date(d.atualizado_em||d.criado_em).toLocaleString('pt-BR'))}</div></div>`).join('');
}
function renderCategorias(){
  const el=document.getElementById('conf-conteudo');
  if(!el||typeof _confDreAnalise==='undefined'||!_confDreAnalise) return;
  const todas=_confDreAnalise._categoriasTodas||[];
  const pend=todas.filter(g=>!g._confV2Decisao);
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><div><strong>Conferência de categorias</strong><div style="font-size:10px;color:var(--muted);margin-top:2px">Só pendências não resolvidas entram no indicador. Decisões ficam registradas por loja e usuário.</div></div><div style="display:flex;gap:5px"><button class="btn ${state.mostrar==='pendentes'?'br':'bs'}" onclick="confV2Mostrar('pendentes')">Pendentes (${pend.length})</button><button class="btn ${state.mostrar==='resolvidos'?'bg':'bs'}" onclick="confV2Mostrar('resolvidos')">Resolvidos</button></div></div>`+
    (state.mostrar==='resolvidos'?historicoResolvido():(pend.length?pend.map(cardGrupo).join(''):'<div style="padding:34px 18px;text-align:center;background:#f8fafc;border:1px dashed var(--border);border-radius:10px;color:var(--muted);font-size:12px">✅ Nenhuma divergência de categoria pendente.</div>'));
}
async function salvar(chave,escopo,status='VALIDADO',decisao){
  const g=state.grupos.get(chave); if(!g) return;
  const body={chave:escopo==='FORNECEDOR'?chaveFornecedor(g):chaveMes(g),tipo:'CATEGORIA_INCONSISTENTE',status,decisao:decisao||(escopo==='FORNECEDOR'?'FORNECEDOR_CATEGORIAS_VALIDAS':'CORRETO_NO_MES'),escopo,mes_ref:escopo==='MES'?g.mes:null,fornecedor_norm:norm(g.fornecedor),categorias:g.categorias||[],metadados:{ids:(g.transacoes||[]).map(t=>String(t.id)),fornecedor:g.fornecedor}};
  if(status==='VALIDADO'){
    const msg=escopo==='FORNECEDOR'?'Confirmar que este fornecedor pode usar estas categorias também nos próximos meses?':'Confirmar que estes lançamentos estão corretos neste mês?';
    if(!confirm(msg)) return;
    const j=prompt('Justificativa (opcional):','')||''; body.justificativa=j;
  }
  const r=await api.post('/api/dre/conferencia-v2/decisoes',body);
  if(!r?.ok){toast('❌ '+(r?.erro||'Não foi possível salvar a decisão'));return;}
  toast(status==='CORRIGIDO'?'✅ Correção registrada':'✅ Conferência validada');
  await carregar(true);
  if(typeof _confDreAnalise!=='undefined') _confDreAnalise=root.DREConferencia.analisar(TXS);
  if(document.getElementById('conf-kpi-categorias')) document.getElementById('conf-kpi-categorias').textContent=_confDreAnalise.categoriasInconsistentes.length;
  if(typeof atualizarBadgeConferenciaDRE==='function') atualizarBadgeConferenciaDRE();
  renderCategorias();
}
function instalar(){
  instalarAnalise();
  carregar(true).then(()=>{if(typeof atualizarBadgeConferenciaDRE==='function') atualizarBadgeConferenciaDRE();});
  if(typeof root.confRenderConteudo==='function'&&!state.renderBase){
    state.renderBase=root.confRenderConteudo;
    root.confRenderConteudo=function(){if(typeof _confDreAba!=='undefined'&&_confDreAba==='categorias') return renderCategorias();return state.renderBase.apply(this,arguments);};
  }
  if(typeof root.abrirConferenciaDRE==='function'&&!state.abrirBase){
    state.abrirBase=root.abrirConferenciaDRE;
    root.abrirConferenciaDRE=async function(){await carregar(true);return state.abrirBase.apply(this,arguments);};
  }
}
root.confV2Mostrar=function(m){state.mostrar=m;renderCategorias();};
root.confV2Salvar=(chave,escopo)=>salvar(chave,escopo,'VALIDADO');
root.confV2ToggleEditor=function(chave){const g=state.grupos.get(chave);if(!g)return;const id='confv2-ed-'+btoa(unescape(encodeURIComponent(chave))).replace(/=/g,'');const el=document.getElementById(id);if(el)el.style.display=el.style.display==='none'?'block':'none';};
root.confV2ConcluirCorrecao=async function(chave){const g=state.grupos.get(chave);if(!g)return;if(!confirm('Concluir a correção deste grupo? As categorias editadas serão mantidas e a decisão ficará auditada.'))return;await salvar(chave,'MES','CORRIGIDO','LANCAMENTOS_CORRIGIDOS');};

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(instalar,100));else setTimeout(instalar,100);
})(window);
