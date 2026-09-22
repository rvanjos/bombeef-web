(function(root){
'use strict';

const MONTHS=['01','02','03','04','05','06','07','08','09','10','11','12'];
const MONTH_LABEL={01:'Jan',02:'Fev',03:'Mar',04:'Abr',05:'Mai',06:'Jun',07:'Jul',08:'Ago',09:'Set',10:'Out',11:'Nov',12:'Dez'};
const st={ano:new Date().getFullYear(),plan:{},obs:'',loading:false};

const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const txs=()=>{try{if(typeof root.getDreTransactions==='function'){const v=root.getDreTransactions();if(Array.isArray(v))return v;}}catch(_){}return Array.isArray(root.TXS)?root.TXS:[];};
const grupo=cat=>{try{return typeof root.catGrupo==='function'?(root.catGrupo(cat)||'OUTROS'):'OUTROS';}catch(_){return'OUTROS';}};
const neutral=cat=>{try{return root.CATS_NAO_OPERACIONAIS instanceof Set&&root.CATS_NAO_OPERACIONAIS.has(cat);}catch(_){return /PAGAMENTO DE FATURA|TRANSFERENCIA INTERNA/i.test(String(cat||''));}};
const mesCompetencia=t=>String(t?.mes||'');
const anoDeMes=m=>{const x=String(m||'').match(/^(\d{2})\/(\d{4})$/);return x?Number(x[2]):null;};
const mmDeMes=m=>{const x=String(m||'').match(/^(\d{2})\/(\d{4})$/);return x?x[1]:null;};

function css(){
  if(document.getElementById('dre-finance-views-style'))return;
  const s=document.createElement('style');s.id='dre-finance-views-style';s.textContent=`
  #dre-conc-area,#dre-plan-area{display:none;flex:1;overflow:auto;background:#f7f4f0;padding:14px}
  body.dre-view-conciliacao #dre-conc-area{display:block!important}
  body.dre-view-planejamento #dre-plan-area{display:block!important}
  .dfv-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}.dfv-head h2{margin:0;font-size:20px}.dfv-head p{margin:4px 0 0;color:var(--muted);font-size:11px;max-width:720px}
  .dfv-actions{display:flex;gap:7px;flex-wrap:wrap}.dfv-card{background:#fff;border:1px solid var(--border);border-radius:11px;box-shadow:0 1px 5px rgba(0,0,0,.03);margin-bottom:10px;overflow:hidden}
  .dfv-card-h{padding:10px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;align-items:center}.dfv-card-h strong{font-size:13px}.dfv-card-b{padding:10px 12px}
  .dfv-kpis{display:grid;grid-template-columns:repeat(4,minmax(125px,1fr));gap:8px;margin-bottom:10px}.dfv-kpi{background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px 12px}.dfv-kpi b{display:block;font-size:18px}.dfv-kpi span{font-size:10px;color:var(--muted)}.dfv-kpi.ok{border-left:4px solid #15803d}.dfv-kpi.warn{border-left:4px solid #d97706}.dfv-kpi.bad{border-left:4px solid #b91c1c}.dfv-kpi.blue{border-left:4px solid #2563eb}
  .dfv-status{font-size:9px;font-weight:800;padding:4px 7px;border-radius:999px;white-space:nowrap}.dfv-status.ok{background:#dcfce7;color:#166534}.dfv-status.warn{background:#fef3c7;color:#92400e}.dfv-status.bad{background:#fee2e2;color:#991b1b}.dfv-status.blue{background:#dbeafe;color:#1d4ed8}
  .dfv-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.dfv-field{background:#faf9f7;border:1px solid var(--border);border-radius:8px;padding:8px}.dfv-field span{display:block;font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:800;margin-bottom:2px}.dfv-field b{font-size:11px}
  .dfv-list{display:grid;gap:7px}.dfv-row{display:grid;grid-template-columns:minmax(220px,1.5fr) 130px 130px 110px auto;gap:9px;align-items:center;padding:9px 10px;border:1px solid #eee;border-radius:8px;background:#fff;font-size:11px}.dfv-row strong{font-size:12px}.dfv-row small{display:block;color:var(--muted);margin-top:2px}
  .dfv-empty{padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--border);border-radius:9px;background:#fff}
  .plan-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.plan-toolbar select,.plan-toolbar textarea{border:1px solid var(--border);border-radius:7px;padding:7px 9px;background:#fff}
  .plan-table-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px;background:#fff}.plan-table{border-collapse:collapse;min-width:1500px;width:100%}.plan-table th,.plan-table td{border-bottom:1px solid #eee;border-right:1px solid #f0ece8;padding:6px 7px;font-size:10px;text-align:right}.plan-table th{position:sticky;top:0;background:#f8f6f3;z-index:2;text-transform:uppercase;color:var(--muted);font-size:9px}.plan-table th:first-child,.plan-table td:first-child{text-align:left;position:sticky;left:0;background:#fff;z-index:1;min-width:220px}.plan-table th:first-child{z-index:3;background:#f8f6f3}.plan-table input{width:82px;border:1px solid var(--border);border-radius:5px;padding:5px;text-align:right;font-size:10px}.plan-table .real{display:block;font-size:9px;color:var(--muted);margin-top:3px}.plan-cat-group{display:block;font-size:8px;color:#9a928b;text-transform:uppercase}.plan-var.pos{color:#15803d}.plan-var.neg{color:#b91c1c}
  .plan-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}.plan-sum{background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px 12px}.plan-sum span{font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:800}.plan-sum b{display:block;font-size:16px;margin-top:2px}
  @media(max-width:850px){.dfv-kpis,.plan-summary{grid-template-columns:1fr 1fr}.dfv-grid{grid-template-columns:1fr 1fr}.dfv-row{grid-template-columns:1fr auto}.dfv-row>*:nth-child(2),.dfv-row>*:nth-child(3),.dfv-row>*:nth-child(4){display:none}}
  `;document.head.appendChild(s);
}

function ensureAreas(){
  const main=document.querySelector('.main');if(!main)return;
  if(!document.getElementById('dre-conc-area')){const e=document.createElement('section');e.id='dre-conc-area';main.prepend(e);}
  if(!document.getElementById('dre-plan-area')){const e=document.createElement('section');e.id='dre-plan-area';main.prepend(e);}
}

function faturas(){
  const map=new Map();
  txs().forEach(t=>{
    if(String(t.fonte||'').toUpperCase()!=='CC'||!t.faturaCC)return;
    const id=String(t.faturaCC);
    if(!map.has(id))map.set(id,{id,itens:[],total:0,mes:t.mes||t.mesCaixa||'',bandeira:t.bandeira||''});
    const f=map.get(id);f.itens.push(t);f.total+=Number(t.valor||0);if(!f.bandeira&&t.bandeira)f.bandeira=t.bandeira;
  });
  const pagamentos=txs().filter(t=>['EXTRATO','OFX'].includes(String(t.fonte||'').toUpperCase())&&(t.faturaCC||/PAGAMENTO DE FATURA|PAGAMENTO DE CARTAO/i.test(String(t.categoria||''))));
  return [...map.values()].map(f=>{
    const pags=pagamentos.filter(p=>String(p.faturaCC||'')===f.id);
    const pago=pags.reduce((s,p)=>s+Math.abs(Number(p.valor||0)),0);
    const total=Math.abs(f.total);
    const diff=Math.abs(total-pago);
    return {...f,total,pagamentos:pags,pago,diff,pendCat:f.itens.filter(i=>!i.categoria).length};
  }).sort((a,b)=>String(b.mes).localeCompare(String(a.mes)));
}
function renderConc(){
  const el=document.getElementById('dre-conc-area');if(!el)return;
  const fs=faturas();
  const bancos=txs().filter(t=>['EXTRATO','OFX'].includes(String(t.fonte||'').toUpperCase()));
  const pagCartao=bancos.filter(t=>/PAGAMENTO DE FATURA|PAGAMENTO DE CARTAO/i.test(String(t.categoria||'')));
  const pendPag=pagCartao.filter(t=>!t.faturaCC||t.needsReview);
  const bolBancos=bancos.filter(t=>t.boletoId);
  const bolPrev=txs().filter(t=>String(t.fonte||'').toUpperCase().startsWith('BOLETO'));
  const semCat=txs().filter(t=>!t.ignorar&&!t.categoria&&!neutral(t.categoria)).length;
  const fechadas=fs.filter(f=>f.pago>0&&f.diff<=0.05&&f.pendCat===0).length;
  el.innerHTML=`
    <div class="dfv-head"><div><h2>Conciliação financeira</h2><p>Confirme se despesas e pagamentos estão ligados corretamente. O pagamento total do cartão é neutro no DRE; as despesas são os itens individuais da fatura.</p></div><div class="dfv-actions"><button class="btn bs" onclick="dreConcReprocessar()">↻ Reprocessar cartões</button><button class="btn bs" onclick="abrirConferenciaDRE()">Abrir Conferência</button></div></div>
    <div class="dfv-kpis">
      <div class="dfv-kpi blue"><b>${fs.length}</b><span>Faturas no DRE</span></div>
      <div class="dfv-kpi ok"><b>${fechadas}</b><span>Faturas conciliadas</span></div>
      <div class="dfv-kpi warn"><b>${pendPag.length}</b><span>Pagamentos aguardando vínculo</span></div>
      <div class="dfv-kpi ${semCat?'bad':'ok'}"><b>${semCat}</b><span>Lançamentos sem categoria</span></div>
    </div>
    <div class="dfv-card"><div class="dfv-card-h"><strong>💳 Faturas de cartão</strong><span style="font-size:10px;color:var(--muted)">Itens da fatura entram no DRE; pagamento bancário não</span></div><div class="dfv-card-b">
      ${fs.length?'<div class="dfv-list">'+fs.map(f=>{
        const ok=f.pago>0&&f.diff<=0.05&&f.pendCat===0;
        const stat=!f.pago?['warn','Aguardando pagamento']:f.diff>0.05?['bad','Valor divergente']:f.pendCat?['warn','Itens sem categoria']:['ok','Conciliada'];
        return `<div class="dfv-row"><div><strong>${esc(f.bandeira||f.id)}</strong><small>${esc(f.mes||'')} · ${f.itens.length} item(ns) · ${f.pendCat} sem categoria</small></div><span>Fatura <b>${brl(f.total)}</b></span><span>Pago <b>${f.pago?brl(f.pago):'—'}</b></span><span>Dif. <b>${brl(f.diff)}</b></span><span class="dfv-status ${stat[0]}">${stat[1]}</span></div>`;
      }).join('')+'</div>':'<div class="dfv-empty">Nenhuma fatura de cartão importada neste conjunto de lançamentos.</div>'}
    </div></div>
    <div class="dfv-card"><div class="dfv-card-h"><strong>🏦 Pagamentos de cartão no extrato</strong><span class="dfv-status ${pendPag.length?'warn':'ok'}">${pendPag.length?'Há pendências':'Sem pendências'}</span></div><div class="dfv-card-b">
      ${pendPag.length?'<div class="dfv-list">'+pendPag.map(t=>`<div class="dfv-row"><div><strong>${esc(t.lancamento||t.descricao||'Pagamento')}</strong><small>${esc(t.data||'')} · ${esc(t.razaoSocial||'')}</small></div><span>${brl(Math.abs(Number(t.valor||0)))}</span><span>${esc(t.mesCaixa||t.mes||'')}</span><span>${esc(t._pagamentoCartaoMotivo||'Aguardando fatura')}</span><span class="dfv-status warn">REVISAR</span></div>`).join('')+'</div>':'<div class="dfv-empty">Nenhum pagamento de cartão aguardando vínculo.</div>'}
    </div></div>
    <div class="dfv-card"><div class="dfv-card-h"><strong>📄 Boletos x extrato</strong></div><div class="dfv-card-b"><div class="dfv-grid">
      <div class="dfv-field"><span>Boletos no DRE</span><b>${bolPrev.length}</b></div>
      <div class="dfv-field"><span>Pagamentos vinculados</span><b>${bolBancos.length}</b></div>
      <div class="dfv-field"><span>Cartões identificados</span><b>${pagCartao.length}</b></div>
      <div class="dfv-field"><span>Movimentos bancários</span><b>${bancos.length}</b></div>
    </div></div></div>`;
}

function atualPorCategoria(){
  const out={};
  txs().forEach(t=>{
    if(t.ignorar||!t.categoria||neutral(t.categoria))return;
    const mes=mesCompetencia(t),a=anoDeMes(mes),mm=mmDeMes(mes);
    if(a!==st.ano||!mm)return;
    if(!out[t.categoria])out[t.categoria]={};
    out[t.categoria][mm]=(out[t.categoria][mm]||0)+Math.abs(Number(t.valor||0));
  });
  return out;
}
function categoriasPlano(real){
  const cats=new Set([...Object.keys(real),...Object.keys(st.plan||{})]);
  const dl=document.getElementById('cats-dl');
  if(dl)[...dl.querySelectorAll('option')].map(o=>o.value).filter(Boolean).forEach(c=>{if(!neutral(c))cats.add(c);});
  return [...cats].sort((a,b)=>{
    const ga=grupo(a),gb=grupo(b);
    return ga===gb?a.localeCompare(b,'pt-BR'):ga.localeCompare(gb,'pt-BR');
  });
}
function planVal(cat,mm){return Number(st.plan?.[cat]?.[mm]||0);}
function planTotalCat(cat){return MONTHS.reduce((s,m)=>s+planVal(cat,m),0);}
function realTotalCat(real,cat){return MONTHS.reduce((s,m)=>s+Number(real?.[cat]?.[m]||0),0);}
function planResumo(real){
  let recP=0,despP=0,recR=0,despR=0;
  categoriasPlano(real).forEach(cat=>{
    const g=grupo(cat),p=planTotalCat(cat),r=realTotalCat(real,cat);
    if(g==='RECEITAS'){recP+=p;recR+=r;}else{despP+=p;despR+=r;}
  });
  return {recP,despP,resP:recP-despP,recR,despR,resR:recR-despR};
}
async function carregarPlano(){
  st.loading=true;renderPlan();
  try{
    const r=await api.get('/api/dre/planejamento/'+st.ano);
    if(r?.ok){st.plan=r.data?.dados_json||{};st.obs=r.data?.observacoes||'';}
    else throw new Error(r?.erro||'Erro ao carregar planejamento');
  }catch(e){console.warn('[DRE Planejamento]',e);st.plan={};st.obs='';}
  finally{st.loading=false;renderPlan();}
}
function renderPlan(){
  const el=document.getElementById('dre-plan-area');if(!el)return;
  if(st.loading){el.innerHTML='<div class="dfv-empty">Carregando planejamento...</div>';return;}
  const real=atualPorCategoria(),cats=categoriasPlano(real),sum=planResumo(real);
  const anos=[st.ano-2,st.ano-1,st.ano,st.ano+1,st.ano+2].filter((v,i,a)=>a.indexOf(v)===i).sort();
  el.innerHTML=`
    <div class="dfv-head"><div><h2>Planejamento anual</h2><p>Defina orçamento mensal por categoria e acompanhe planejado x realizado. Os valores planejados são informados como valores positivos; o sistema separa receitas e despesas pelo grupo do DRE.</p></div>
      <div class="plan-toolbar"><select onchange="drePlanAno(this.value)">${anos.map(a=>`<option value="${a}" ${a===st.ano?'selected':''}>${a}</option>`).join('')}</select><button class="btn bs" onclick="drePlanMedia()">Preencher vazios pela média realizada</button><button class="btn bg" onclick="drePlanSalvar()">💾 Salvar planejamento</button></div>
    </div>
    <div class="plan-summary">
      <div class="plan-sum"><span>Receita planejada</span><b>${brl(sum.recP)}</b><small class="real">Realizado: ${brl(sum.recR)}</small></div>
      <div class="plan-sum"><span>Despesas planejadas</span><b>${brl(sum.despP)}</b><small class="real">Realizado: ${brl(sum.despR)}</small></div>
      <div class="plan-sum"><span>Resultado planejado</span><b>${brl(sum.resP)}</b><small class="real">Realizado: ${brl(sum.resR)}</small></div>
      <div class="plan-sum"><span>Desvio do resultado</span><b class="plan-var ${sum.resR-sum.resP>=0?'pos':'neg'}">${brl(sum.resR-sum.resP)}</b><small class="real">Realizado − planejado</small></div>
    </div>
    <div class="plan-table-wrap"><table class="plan-table"><thead><tr><th>Categoria</th>${MONTHS.map(m=>`<th>${MONTH_LABEL[m]}</th>`).join('')}<th>Planejado ano</th><th>Realizado ano</th><th>Desvio</th></tr></thead><tbody>
    ${cats.map(cat=>{
      const p=planTotalCat(cat),r=realTotalCat(real,cat),diff=r-p;
      return `<tr><td><strong>${esc(cat)}</strong><span class="plan-cat-group">${esc(grupo(cat))}</span></td>${MONTHS.map(m=>`<td><input type="number" min="0" step="0.01" value="${planVal(cat,m)||''}" placeholder="0,00" onchange="drePlanSet(${JSON.stringify(cat)},'${m}',this.value)"><span class="real">R: ${brl(real?.[cat]?.[m]||0)}</span></td>`).join('')}<td><strong>${brl(p)}</strong></td><td><strong>${brl(r)}</strong></td><td class="plan-var ${diff<=0&&grupo(cat)!=='RECEITAS'||diff>=0&&grupo(cat)==='RECEITAS'?'pos':'neg'}">${brl(diff)}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="dfv-card" style="margin-top:10px"><div class="dfv-card-h"><strong>Observações do planejamento</strong></div><div class="dfv-card-b"><textarea id="dre-plan-obs" style="width:100%;min-height:70px;border:1px solid var(--border);border-radius:7px;padding:8px" placeholder="Premissas, metas, reajustes previstos...">${esc(st.obs)}</textarea></div></div>`;
}

root.dreFinanceViewRender=function(v){ensureAreas();if(v==='conciliacao')renderConc();if(v==='planejamento'){if(!Object.keys(st.plan).length&&!st.loading)carregarPlano();else renderPlan();}};
root.dreConcReprocessar=function(){try{root.reprocessarPagamentosCartaoDRE?.();}catch(_){}setTimeout(renderConc,120);};
root.drePlanAno=v=>{st.ano=Number(v)||new Date().getFullYear();st.plan={};st.obs='';carregarPlano();};
root.drePlanSet=(cat,mm,v)=>{if(!st.plan[cat])st.plan[cat]={};const n=Number(v);st.plan[cat][mm]=Number.isFinite(n)?Math.max(0,n):0;renderPlan();};
root.drePlanMedia=function(){
  const real=atualPorCategoria();
  for(const cat of categoriasPlano(real)){
    const vals=MONTHS.map(m=>Number(real?.[cat]?.[m]||0)).filter(v=>v>0);
    if(!vals.length)continue;
    const avg=vals.reduce((s,v)=>s+v,0)/vals.length;
    if(!st.plan[cat])st.plan[cat]={};
    MONTHS.forEach(m=>{if(!(Number(st.plan[cat][m])>0))st.plan[cat][m]=Math.round(avg*100)/100;});
  }
  renderPlan();
};
root.drePlanSalvar=async function(){
  st.obs=document.getElementById('dre-plan-obs')?.value||'';
  const r=await api.put('/api/dre/planejamento/'+st.ano,{dados:st.plan,observacoes:st.obs});
  if(!r?.ok){root.toast?.('❌ '+(r?.erro||'Erro ao salvar planejamento'));return;}
  root.toast?.('✅ Planejamento anual salvo');
};

function init(){css();ensureAreas();if(['conciliacao','planejamento'].includes(localStorage.getItem('dre-main-view')))setTimeout(()=>root.dreSetView?.(localStorage.getItem('dre-main-view')),100);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,260));else setTimeout(init,260);
})(window);
