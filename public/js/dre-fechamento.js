(function(root){
'use strict';

const st={mes:null,dados:null,carregando:false,trocarBase:null,renderAreaBase:null};
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mesAtual=()=>{
  if(typeof root.mesRef==='string' && /^\d{2}\/\d{4}$/.test(root.mesRef)) return root.mesRef;
  const v=document.getElementById('f-mesref')?.value||'';
  if(/^\d{4}-\d{2}$/.test(v)){const[y,m]=v.split('-');return m+'/'+y;}
  return '';
};

function css(){
  if(document.getElementById('dre-fech-style'))return;
  const s=document.createElement('style');s.id='dre-fech-style';s.textContent=`
  .dre-fech-wrap{display:flex;align-items:center;gap:6px;margin-left:4px}
  .dre-fech-badge{padding:5px 8px;border-radius:999px;font-size:10px;font-weight:800;white-space:nowrap;border:1px solid}
  .dre-fech-badge.aberto{background:#f0fdf4;color:#166534;border-color:#bbf7d0}
  .dre-fech-badge.fechado{background:#eff6ff;color:#1e40af;border-color:#bfdbfe}
  .dre-fech-btn{border:1px solid var(--border);background:#fff;border-radius:8px;padding:7px 10px;font-size:11px;font-weight:700;cursor:pointer}
  .dre-fech-btn:hover{border-color:var(--red);color:var(--red)}
  body.dre-mes-fechado .dla-cat,
  body.dre-mes-fechado .dla-bulk,
  body.dre-mes-fechado .dla-row input[type=checkbox]{pointer-events:none!important;opacity:.55!important}
  body.dre-mes-fechado .dla-act button:first-child{pointer-events:none!important;opacity:.45!important}
  .dre-fech-readonly{display:none;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:9px;padding:9px 12px;font-size:11px;font-weight:600;margin:0 14px 10px}
  body.dre-mes-fechado .dre-fech-readonly{display:block}
  .dfm-bg{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:900;display:flex;align-items:center;justify-content:center;padding:16px}
  .dfm{width:min(680px,96vw);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.28)}
  .dfm-h{padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
  .dfm-h h3{margin:0;font-size:17px;color:var(--red)}.dfm-h p{margin:4px 0 0;font-size:11px;color:var(--muted)}
  .dfm-x{border:0;background:none;font-size:22px;cursor:pointer;color:var(--muted)}
  .dfm-b{padding:15px 18px}.dfm-item{display:grid;grid-template-columns:24px minmax(180px,1fr) auto;gap:8px;align-items:center;padding:9px 8px;border-bottom:1px solid #f0ece8;font-size:11px}
  .dfm-item:last-child{border-bottom:0}.dfm-item b{font-size:12px}.dfm-item small{display:block;color:var(--muted);margin-top:2px}
  .dfm-ok{color:#166534}.dfm-bad{color:#991b1b}.dfm-f{padding:13px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
  .dfm-hist{background:#fafafa;border:1px solid var(--border);border-radius:9px;padding:10px;margin-top:12px;font-size:10px;color:var(--muted)}
  `;document.head.appendChild(s);
}

function readonlyBanner(){
  if(document.getElementById('dre-fech-readonly'))return;
  const tabs=document.getElementById('dre-main-tabs');
  if(!tabs)return;
  const b=document.createElement('div');b.id='dre-fech-readonly';b.className='dre-fech-readonly';
  b.innerHTML='🔒 Este mês está fechado. O DRE está em modo somente leitura; reabra o mês para fazer alterações.';
  tabs.insertAdjacentElement('afterend',b);
}

function nav(){
  const tabs=document.getElementById('dre-main-tabs');if(!tabs)return;
  let w=document.getElementById('dre-fech-wrap');
  if(!w){w=document.createElement('div');w.id='dre-fech-wrap';w.className='dre-fech-wrap';const sp=tabs.querySelector('.dre-ws-spacer');if(sp)sp.insertAdjacentElement('afterend',w);else tabs.appendChild(w);}
  const fechado=String(st.dados?.status||'ABERTO').toUpperCase()==='FECHADO';
  w.innerHTML=`<span class="dre-fech-badge ${fechado?'fechado':'aberto'}">${fechado?'🔒 Fechado':'● Aberto'}</span><button class="dre-fech-btn" onclick="dreFechAbrir()">${fechado?'Ver fechamento':'Fechar mês'}</button>`;
  document.body.classList.toggle('dre-mes-fechado',fechado);
  readonlyBanner();
}

async function carregar(force=false){
  const mes=mesAtual();if(!mes||st.carregando)return;
  if(!force&&st.mes===mes&&st.dados){nav();return;}
  st.carregando=true;
  try{
    const d=await api.get('/api/dre/fechamento?mes='+encodeURIComponent(mes));
    if(d?.ok){st.mes=mes;st.dados=d.data||{};nav();}
  }catch(e){console.warn('[DRE fechamento]',e.message);}
  finally{st.carregando=false;}
}

function modal(html){
  fecharModal();
  const bg=document.createElement('div');bg.id='dre-fech-modal';bg.className='dfm-bg';bg.innerHTML=html;document.body.appendChild(bg);
}
function fecharModal(){document.getElementById('dre-fech-modal')?.remove();}
function itensHtml(itens){
  return (itens||[]).map(i=>`<div class="dfm-item"><span class="${i.ok?'dfm-ok':'dfm-bad'}">${i.ok?'✓':'!'}</span><div><b>${esc(i.label)}</b><small>${esc(i.valor||'')}</small></div><span class="${i.ok?'dfm-ok':'dfm-bad'}">${i.ok?'OK':(i.urgente?'PENDENTE':'REVISAR')}</span></div>`).join('');
}

async function abrir(){
  await carregar(true);
  const d=st.dados||{}, fechado=String(d.status||'ABERTO').toUpperCase()==='FECHADO';
  const check=d.checklist||{itens:[],pronto:false};
  const hist=(d.historico||[]).slice(0,8);
  modal(`<div class="dfm"><div class="dfm-h"><div><h3>${fechado?'🔒 Fechamento do DRE':'✅ Fechar DRE do mês'} — ${esc(st.mes)}</h3><p>${fechado?'Esta é a situação auditada do mês.':'O mês só pode ser fechado sem pendências obrigatórias.'}</p></div><button class="dfm-x" onclick="dreFechFecharModal()">×</button></div><div class="dfm-b">${itensHtml(check.itens)}${fechado?`<div class="dfm-hist"><strong>Fechado por:</strong> ${esc(d.fechado_por_nome||'—')} · ${d.fechado_em?new Date(d.fechado_em).toLocaleString('pt-BR'):'—'}${hist.length?'<br><br><strong>Histórico:</strong><br>'+hist.map(h=>esc(h.evento)+' · '+esc(h.usuario_nome||'')+' · '+new Date(h.criado_em).toLocaleString('pt-BR')+(h.justificativa?' — '+esc(h.justificativa):'')).join('<br>'):''}</div>`:''}</div><div class="dfm-f"><button class="btn bs" onclick="dreFechFecharModal()">Fechar</button>${fechado?'<button class="btn br" onclick="dreFechReabrir()">↩ Reabrir mês</button>':`<button class="btn bg" ${check.pronto?'':'disabled style="opacity:.45;cursor:not-allowed"'} onclick="dreFechConfirmar()">🔒 Confirmar fechamento</button>`}</div></div>`);
}

async function confirmar(){
  if(!st.mes)return;
  if(!confirm('Fechar o DRE de '+st.mes+'? Depois disso, o mês ficará bloqueado para alterações.'))return;
  const r=await api.post('/api/dre/fechamento/fechar',{mes_ref:st.mes});
  if(!r?.ok){
    const p=(r?.pendencias||[]).map(x=>x.label).join(', ');
    alert((r?.erro||'Não foi possível fechar o mês')+(p?'\n\nPendências: '+p:''));
    await carregar(true);abrir();return;
  }
  if(typeof toast==='function')toast('🔒 DRE fechado com sucesso');
  fecharModal();await carregar(true);
}
async function reabrir(){
  if(!st.mes)return;
  const motivo=prompt('Informe o motivo da reabertura do mês:','');
  if(!motivo)return;
  const r=await api.post('/api/dre/fechamento/reabrir',{mes_ref:st.mes,motivo});
  if(!r?.ok){alert(r?.erro||'Não foi possível reabrir o mês');return;}
  if(typeof toast==='function')toast('↩ DRE reaberto');
  fecharModal();await carregar(true);
}

function envolverTroca(){
  if(st.trocarBase||typeof root.trocarMes!=='function')return;
  st.trocarBase=root.trocarMes;
  root.trocarMes=async function(){const r=await st.trocarBase.apply(this,arguments);await carregar(true);return r;};
}
function observarTabs(){
  // O menu principal é criado por outro módulo alguns milissegundos depois.
  // Um MutationObserver sobre a página inteira não pode chamar nav(): nav()
  // altera o próprio menu e voltaria a disparar o observer indefinidamente,
  // congelando o DRE. A espera limitada abaixo encerra assim que o menu existe.
  let tentativas=0;
  const tentar=()=>{
    if(document.getElementById('dre-main-tabs')){nav();readonlyBanner();return;}
    tentativas++;
    if(tentativas<50)setTimeout(tentar,100);
  };
  tentar();
}

root.dreFechAbrir=abrir;
root.dreFechConfirmar=confirmar;
root.dreFechReabrir=reabrir;
root.dreFechFecharModal=fecharModal;
root.dreFechAtualizar=()=>carregar(true);

function init(){css();envolverTroca();observarTabs();setTimeout(()=>carregar(true),250);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
