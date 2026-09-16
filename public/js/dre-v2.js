(function(){
'use strict';
let modo='simples';
let filtro='todos';
let renderOriginal=null;
let inicializado=false;

function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function txs(){
  if(typeof window.getDreTransactions==='function'){
    const lista=window.getDreTransactions();
    if(Array.isArray(lista))return lista;
  }
  return Array.isArray(window.TXS)?window.TXS:[];
}
function statusTx(t){
  if(t.ignorar) return {txt:'IGNORADO',cls:'muted'};
  if(t.needsReview) return {txt:'REVISAR',cls:'review'};
  if(!t.categoria) return {txt:'PENDENTE',cls:'warn'};
  if(t.boletoId||t.vinculadoFaturaCC||t.faturaCC) return {txt:'VINCULADO',cls:'ok'};
  return {txt:'CLASSIFICADO',cls:'ok'};
}
function origemGrupo(t){
  const f=String(t.fonte||'').toUpperCase();
  if(f==='CC') return 'cartao';
  if(f==='OFX'||f==='EXTRATO') return 'banco';
  if(f.startsWith('BOLETO')) return 'boleto';
  if(f==='MANUAL') return 'manual';
  return 'outro';
}
function passaFiltro(t){
  if(filtro==='todos') return !t.ignorar;
  if(filtro==='pendentes') return !t.ignorar && (!t.categoria||t.needsReview);
  if(filtro==='revisao') return !t.ignorar && !!t.needsReview;
  if(filtro==='banco') return !t.ignorar && origemGrupo(t)==='banco';
  if(filtro==='cartao') return !t.ignorar && origemGrupo(t)==='cartao';
  if(filtro==='boleto') return !t.ignorar && origemGrupo(t)==='boleto';
  if(filtro==='ignorados') return !!t.ignorar;
  return true;
}
function inserirEstrutura(){
  const toolbar=document.querySelector('#tbl-area .toolbar-top');
  if(!toolbar||document.getElementById('dre-v2-bar')) return;
  const bar=document.createElement('div');
  bar.id='dre-v2-bar';bar.className='dre-v2-bar';
  bar.innerHTML=`<div><div class="dre-v2-title">Lançamentos financeiros</div><div class="dre-v2-sub">Visão simplificada para conferir, classificar e corrigir lançamentos.</div></div><div class="dre-v2-toggle"><button id="dre-v2-simple" class="active">Simples</button><button id="dre-v2-detail">Detalhada</button></div>`;
  toolbar.insertAdjacentElement('afterend',bar);
  const k=document.createElement('div');k.id='dre-v2-kpis';k.className='dre-v2-kpis';bar.insertAdjacentElement('afterend',k);
  const f=document.createElement('div');f.id='dre-v2-filters';f.className='dre-v2-filters';
  f.innerHTML=`<span class="dre-v2-filters-label">Visão rápida:</span>${[['todos','Ativos'],['pendentes','Pendentes'],['revisao','Revisar'],['banco','Banco'],['cartao','Cartões'],['boleto','Boletos'],['ignorados','Ignorados']].map(([id,txt])=>`<button class="dre-v2-chip${id==='todos'?' active':''}" data-v2f="${id}">${txt}</button>`).join('')}`;
  k.insertAdjacentElement('afterend',f);
  document.getElementById('dre-v2-simple').onclick=()=>setModo('simples');
  document.getElementById('dre-v2-detail').onclick=()=>setModo('detalhado');
  f.querySelectorAll('[data-v2f]').forEach(b=>b.onclick=()=>{filtro=b.dataset.v2f;f.querySelectorAll('[data-v2f]').forEach(x=>x.classList.toggle('active',x===b));posRender();});
}
function setModo(m){modo=m;document.body.classList.toggle('dre-v2-simple',m==='simples');document.getElementById('dre-v2-simple')?.classList.toggle('active',m==='simples');document.getElementById('dre-v2-detail')?.classList.toggle('active',m!=='simples');posRender();}
function atualizarKpis(){
 const l=txs();const ativos=l.filter(t=>!t.ignorar);const pend=ativos.filter(t=>!t.categoria).length;const rev=ativos.filter(t=>t.needsReview).length;const classif=ativos.filter(t=>t.categoria&&!t.needsReview).length;const ign=l.filter(t=>t.ignorar).length;
 const el=document.getElementById('dre-v2-kpis');if(!el)return;
 el.innerHTML=`<div class="dre-v2-kpi"><b>${ativos.length}</b><span>Ativos</span></div><div class="dre-v2-kpi ${pend?'warn':'ok'}"><b>${pend}</b><span>Sem categoria</span></div><div class="dre-v2-kpi ${rev?'alert':'ok'}"><b>${rev}</b><span>Revisar</span></div><div class="dre-v2-kpi ${ign?'muted':''}"><b>${classif}</b><span>Classificados</span></div>`;
}
function encontrar(id){return txs().find(x=>String(x.id)===String(id));}
function enriquecerLinha(row,t){
  if(!row||!t||row.dataset.v2done==='1')return;
  row.dataset.v2done='1';
  const lanc=row.children[5];const ac=row.children[10];
  if(lanc){const st=statusTx(t);const titulo=esc(t.lancamento||t.descricao||'Sem descrição');const forn=esc(t.razaoSocial||t.fornecedor||t.portador||'');const fonte=esc(t.fonte||'—');const cat=esc(t.categoria||'Sem categoria');lanc.innerHTML=`<div class="dre-v2-mainline">${titulo}<span class="dre-v2-status ${st.cls}">${st.txt}</span></div><div class="dre-v2-meta"><span>${fonte}</span>${forn?`<span>• ${forn}</span>`:''}<span>• ${cat}</span></div>`;}
  if(ac){const b=document.createElement('button');b.className='dre-v2-detail-btn';b.type='button';b.title='Ver detalhes';b.textContent='Detalhes';b.onclick=e=>{e.stopPropagation();toggleDetalhe(row,t);};ac.appendChild(b);}
}
function toggleDetalhe(row,t){
 const next=row.nextElementSibling;if(next&&next.classList.contains('dre-v2-detail-row')){next.remove();return;}
 document.querySelectorAll('.dre-v2-detail-row').forEach(x=>x.remove());
 const vinc=!!(t.boletoId||t.vinculadoFaturaCC||t.faturaCC);const tr=document.createElement('tr');tr.className='dre-v2-detail-row';
 const mesD=esc(t.mes||'—'),mesC=esc(t.mesCaixa||'—'),fitid=esc(t.fitid||'—'),fonte=esc(t.fonte||'—'),forn=esc(t.razaoSocial||t.fornecedor||t.portador||'—'),cat=esc(t.categoria||'—'),ref=esc(t.boletoId||t.faturaCC||'—');
 tr.innerHTML=`<td colspan="11"><div class="dre-v2-detail"><div><span>Origem</span><strong>${fonte}</strong></div><div><span>Fornecedor / portador</span><strong>${forn}</strong></div><div><span>Categoria</span><strong>${cat}</strong></div><div><span>Referência bancária</span><strong>${fitid}</strong></div><div><span>Mês DRE</span><strong>${mesD}</strong></div><div><span>Mês Caixa</span><strong>${mesC}</strong></div><div><span>Vínculo</span><strong>${ref}</strong></div><div><span>ID interno</span><strong>${esc(t.id)}</strong></div><div class="dre-v2-detail-actions">${vinc?'<span class="dre-v2-disabled">🔗 Desvincule o boleto/fatura antes de excluir.</span>':`<button class="dre-v2-danger" type="button" data-v2del="${esc(t.id)}">🗑 Excluir lançamento</button>`}</div></div></td>`;
 row.insertAdjacentElement('afterend',tr);
 const del=tr.querySelector('[data-v2del]');if(del)del.onclick=()=>excluirSeguro(t);
}
function excluirSeguro(t){
 const origem=String(t.fonte||'lançamento');
 if(!confirm(`Excluir este lançamento do DRE?\n\n${t.lancamento||t.descricao||''}\nR$ ${Math.abs(Number(t.valor||0)).toLocaleString('pt-BR',{minimumFractionDigits:2})}\nOrigem: ${origem}\n\nO arquivo de origem não será apagado.`))return;
 if(typeof window.excluirLanc==='function') window.excluirLanc(t.id); else if(typeof window.delLanc==='function') window.delLanc(t.id);
 setTimeout(posRender,80);
}
function aplicarFiltroDom(){
 document.querySelectorAll('#tbody tr[id^="tr-"]').forEach(row=>{const id=row.id.slice(3);const t=encontrar(id);if(!t)return;row.style.display=passaFiltro(t)?'':'none';enriquecerLinha(row,t);});
}
function posRender(){document.querySelectorAll('.dre-v2-detail-row').forEach(x=>x.remove());atualizarKpis();aplicarFiltroDom();}
function envolverRender(){
 if(renderOriginal||typeof window.render!=='function')return;
 renderOriginal=window.render;
 window.render=function(){const r=renderOriginal.apply(this,arguments);setTimeout(posRender,0);return r;};
}
function init(){if(inicializado)return;inicializado=true;inserirEstrutura();setModo(localStorage.getItem('dre-v2-modo')||'simples');envolverRender();const old=setModo;window.setDreV2Modo=function(m){localStorage.setItem('dre-v2-modo',m);old(m);};posRender();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,50));else setTimeout(init,50);
})();
