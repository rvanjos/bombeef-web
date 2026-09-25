(function(root){
'use strict';

const MONTHS=['01','02','03','04','05','06','07','08','09','10','11','12'];
const MONTH_LABEL={'01':'Jan','02':'Fev','03':'Mar','04':'Abr','05':'Mai','06':'Jun','07':'Jul','08':'Ago','09':'Set','10':'Out','11':'Nov','12':'Dez'};
const st={ano:new Date().getFullYear(),plan:{},obs:'',loading:false,fluxo:null,fluxoCalc:null,fluxoConfs:[],fluxoSuspeitas:{},fluxoLoading:false,fluxoCarregado:false};

const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const txs=()=>{try{if(typeof root.getDreTransactions==='function'){const v=root.getDreTransactions();if(Array.isArray(v))return v;}}catch(_){}return Array.isArray(root.TXS)?root.TXS:[];};
const grupo=cat=>{try{return typeof root.catGrupo==='function'?(root.catGrupo(cat)||'OUTROS'):'OUTROS';}catch(_){return'OUTROS';}};
const neutral=cat=>{try{if(root.CATS_NAO_OPERACIONAIS instanceof Set&&root.CATS_NAO_OPERACIONAIS.has(cat))return true;}catch(_){}return /PAGAMENTO DE FATURA|PAGAMENTO DE CARTAO|TRANSFERENCIA INTERNA|TRANSFERÊNCIA INTERNA/i.test(String(cat||''));};
const mesCompetencia=t=>String(t?.mes||'');
const anoDeMes=m=>{const x=String(m||'').match(/^(\d{2})\/(\d{4})$/);return x?Number(x[2]):null;};
const mmDeMes=m=>{const x=String(m||'').match(/^(\d{2})\/(\d{4})$/);return x?x[1]:null;};

function isoHoje(){return new Date().toISOString().slice(0,10);}
function isoData(v){
  const s=String(v||'');
  const m=s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?m[1]:'';
}
function dataBr(v){
  const s=isoData(v);if(!s)return'—';
  const [y,m,d]=s.split('-');return `${d}/${m}/${y}`;
}
function setFluxoPacote(r){
  st.fluxo=r?.config||r?.data||null;
  st.fluxoCalc=r?.resumo||r?.calculo||null;
  st.fluxoConfs=Array.isArray(r?.conferencias)?r.conferencias:[];
  st.fluxoSuspeitas=r?.suspeitas||{};
  st.fluxoCarregado=true;
}
async function carregarFluxo(){
  if(st.fluxoLoading)return;
  st.fluxoLoading=true;
  try{
    const r=await api.get('/api/dre/fluxo-conciliacao');
    if(r?.ok)setFluxoPacote(r);
    else throw new Error(r?.erro||'Erro ao carregar conciliação do fluxo');
  }catch(e){console.warn('[DRE Fluxo]',e);st.fluxo=null;st.fluxoCalc=null;st.fluxoConfs=[];st.fluxoSuspeitas={};}
  finally{st.fluxoLoading=false;st.fluxoCarregado=true;renderConc();}
}
function fluxoDiagnostico(){
  const s=st.fluxoSuspeitas||{};
  const dups=Array.isArray(s.duplicidades)?s.duplicidades:[];
  const invalidos=Array.isArray(s.invalidos)?s.invalidos:[];
  const ignorados=Array.isArray(s.ignorados)?s.ignorados:[];
  const semCat=Array.isArray(s.sem_categoria)?s.sem_categoria:[];
  const ult=st.fluxoConfs[st.fluxoConfs.length-1]||null;
  const problema=ult&&Math.abs(Number(ult.diferenca||0))>0.05;
  const destaque=problema
    ? `A divergência acumulada é ${brl(ult.diferenca)}. No último intervalo (${dataBr(ult.intervalo_inicio)} a ${dataBr(ult.data_ref)}), ela variou ${brl(ult.variacao_divergencia)}.`
    : ult?'O último saldo informado está conciliado com os movimentos bancários cadastrados.':'Registre um saldo real para começar a localizar divergências.';
  return `
    <div class="dfv-card">
      <div class="dfv-card-h"><div><strong>🔎 Diagnóstico de divergências</strong><div style="font-size:10px;color:var(--muted);margin-top:2px">${esc(destaque)}</div></div><span class="dfv-status ${problema?'bad':ult?'ok':'blue'}">${problema?'Investigar intervalo':ult?'Conciliado':'Sem conferência'}</span></div>
      <div class="dfv-card-b">
        <div class="dfv-grid" style="margin-bottom:10px">
          <div class="dfv-field"><span>Duplicidades suspeitas</span><b>${dups.length}</b></div>
          <div class="dfv-field"><span>Movimentos sem data válida</span><b>${invalidos.length}</b></div>
          <div class="dfv-field"><span>Movimentos bancários ignorados no DRE</span><b>${ignorados.length}</b></div>
          <div class="dfv-field"><span>Movimentos sem categoria</span><b>${semCat.length}</b></div>
        </div>
        ${dups.length?`<div style="font-size:10px;font-weight:800;margin-bottom:6px">Possíveis duplicidades bancárias</div><div class="dfv-list">${dups.slice(0,6).map(g=>{
          const a=g.itens?.[0]||{};
          return `<div class="dfv-row"><div><strong>${esc(a.descricao||g.tipo)}</strong><small>${esc(g.tipo)} · ${g.itens?.length||0} ocorrência(s) · ${dataBr(a.data)}</small></div><span>${brl(a.valor)}</span><span>${esc(a.fornecedor||'')}</span><span>${esc(g.confianca||'')}</span><span></span></div>`;
        }).join('')}</div>`:''}
      </div>
    </div>`;
}
function fluxoHistorico(){
  if(!st.fluxoConfs.length)return '<div class="dfv-empty">Nenhum saldo real conferido ainda. Registre o primeiro saldo do banco abaixo.</div>';
  return `
    <div class="fluxo-table-wrap"><table class="fluxo-table">
      <thead><tr><th>Data</th><th>Entradas no intervalo</th><th>Saídas no intervalo</th><th>Saldo esperado</th><th>Saldo real</th><th>Diferença</th><th>Variação da diferença</th><th>Alertas</th><th></th></tr></thead>
      <tbody>${[...st.fluxoConfs].reverse().map(x=>{
        const ok=Math.abs(Number(x.diferenca||0))<=0.05;
        return `<tr>
          <td><strong>${dataBr(x.data_ref)}</strong><small>${dataBr(x.intervalo_inicio)} → ${dataBr(x.data_ref)}</small></td>
          <td>${brl(x.entradas_periodo)}</td><td>${brl(x.saidas_periodo)}</td>
          <td>${brl(x.saldo_esperado)}</td><td><strong>${brl(x.saldo_real)}</strong></td>
          <td class="${ok?'fluxo-ok':'fluxo-bad'}">${brl(x.diferenca)}</td>
          <td class="${Math.abs(Number(x.variacao_divergencia||0))<=0.05?'fluxo-ok':'fluxo-bad'}">${brl(x.variacao_divergencia)}</td>
          <td>${x.duplicidades_periodo?'<span class="dfv-status warn">'+x.duplicidades_periodo+' dup.</span>':ok?'<span class="dfv-status ok">OK</span>':'<span class="dfv-status bad">Revisar</span>'}</td>
          <td><button class="btn bs" onclick="dreFluxoExcluirConf(${Number(x.id)})">Excluir</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}
function fluxoCard(){
  const f=st.fluxo||{},x=st.fluxoCalc||{};
  const tem=!!f.data_inicio;
  const diff=x?.diferenca;
  const cls=diff==null?'blue':Math.abs(Number(diff))<=0.05?'ok':'bad';
  return `
    <div class="dfv-card">
      <div class="dfv-card-h">
        <div><strong>🏦 Conciliação do saldo bancário</strong><div style="font-size:10px;color:var(--muted);margin-top:2px">Use saldos reais do banco como pontos de controle. O sistema mostra em qual intervalo o saldo esperado deixou de bater.</div></div>
        <span class="dfv-status ${cls}">${diff==null?'Aguardando saldo real':Math.abs(Number(diff))<=0.05?'Saldo conciliado':'Diferença '+brl(diff)}</span>
      </div>
      <div class="dfv-card-b">
        <div class="dfv-grid" style="margin-bottom:10px">
          <div class="dfv-field"><span>Saldo inicial</span><b>${tem?brl(f.saldo_inicial):'—'}</b></div>
          <div class="dfv-field"><span>Entradas acumuladas</span><b>${tem?brl(x?.entradas):'—'}</b></div>
          <div class="dfv-field"><span>Saídas acumuladas</span><b>${tem?brl(x?.saidas):'—'}</b></div>
          <div class="dfv-field"><span>Saldo esperado</span><b>${tem?brl(x?.saldo_esperado):'—'}</b></div>
        </div>
        <div class="dfv-grid" style="margin-bottom:12px">
          <div class="dfv-field"><span>Último saldo real</span><b>${x?.saldo_real==null?'—':brl(x.saldo_real)}</b></div>
          <div class="dfv-field"><span>Diferença atual</span><b class="${diff==null?'':Math.abs(Number(diff))<=0.05?'fluxo-ok':'fluxo-bad'}">${diff==null?'—':brl(diff)}</b></div>
          <div class="dfv-field"><span>Data inicial</span><b>${dataBr(f.data_inicio)}</b></div>
          <div class="dfv-field"><span>Última conferência</span><b>${dataBr(x?.ultima_conferencia)}</b></div>
        </div>

        <div style="font-size:11px;font-weight:800;margin-bottom:6px">1. Base do controle</div>
        <div class="plan-toolbar" style="margin-bottom:12px">
          <label class="fluxo-label">Data inicial <input id="dre-fluxo-data" type="date" value="${esc(isoData(f.data_inicio))}"></label>
          <label class="fluxo-label">Saldo inicial <input id="dre-fluxo-inicial" type="number" step="0.01" value="${f.saldo_inicial==null?'':Number(f.saldo_inicial)}" placeholder="0,00"></label>
          <button class="btn bs" onclick="dreFluxoSalvarBase()">💾 Salvar base</button>
          <span style="font-size:10px;color:var(--muted)">É o saldo existente antes dos movimentos da data inicial. Não entra como receita no DRE.</span>
        </div>

        <div style="font-size:11px;font-weight:800;margin-bottom:6px">2. Registrar uma conferência real do banco</div>
        <div class="plan-toolbar">
          <label class="fluxo-label">Data da conferência <input id="dre-fluxo-data-real" type="date" value="${isoHoje()}"></label>
          <label class="fluxo-label">Saldo real <input id="dre-fluxo-real" type="number" step="0.01" placeholder="Ex.: -27152,43"></label>
          <input id="dre-fluxo-obs" type="text" maxlength="200" placeholder="Observação opcional" style="min-width:220px;border:1px solid var(--border);border-radius:7px;padding:7px 9px">
          <button class="btn bg" onclick="dreFluxoRegistrarConf()">✓ Registrar saldo e conciliar</button>
        </div>
      </div>
    </div>
    <div class="dfv-card">
      <div class="dfv-card-h"><div><strong>📅 Histórico de conferências</strong><div style="font-size:10px;color:var(--muted);margin-top:2px">A variação da diferença mostra em qual período nasceu um lançamento faltante, duplicado ou incorreto.</div></div></div>
      <div class="dfv-card-b">${fluxoHistorico()}</div>
    </div>
    ${fluxoDiagnostico()}`;
}

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
  .fluxo-label{font-size:10px;color:var(--muted);display:flex;align-items:center;gap:5px}.fluxo-label input{border:1px solid var(--border);border-radius:7px;padding:7px 9px;background:#fff}
  .fluxo-table-wrap{overflow:auto;border:1px solid var(--border);border-radius:9px}.fluxo-table{width:100%;min-width:1100px;border-collapse:collapse}.fluxo-table th,.fluxo-table td{padding:8px 9px;border-bottom:1px solid #eee;font-size:10px;text-align:right}.fluxo-table th{text-transform:uppercase;color:var(--muted);font-size:9px;background:#faf9f7}.fluxo-table th:first-child,.fluxo-table td:first-child{text-align:left}.fluxo-table td small{display:block;color:var(--muted);margin-top:2px}.fluxo-ok{color:#15803d!important}.fluxo-bad{color:#b91c1c!important;font-weight:800}
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
    ${fluxoCard()}
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
      ${pendPag.length?'<div class="dfv-list">'+pendPag.map(t=>`<div class="dfv-row"><div><strong>${esc(t.lancamento||t.descricao||'Pagamento')}</strong><small>${esc(t.data||'')} · ${esc(t.razaoSocial||'')}</small></div><span>${brl(Math.abs(Number(t.valor||0)))}</span><span>${esc(t.mesCaixa||t.mes||'')}</span><span>${esc(t._pagamentoCartaoMotivo||'Aguardando fatura')}</span><span style="display:flex;gap:5px;align-items:center"><span class="dfv-status warn">REVISAR</span>${typeof root.abrirVinculoFatura==='function'?`<button class="btn bs" style="padding:4px 7px;font-size:9px" onclick="abrirVinculoFatura('${esc(t.id)}')">Vincular</button>`:''}</span></div>`).join('')+'</div>':'<div class="dfv-empty">Nenhum pagamento de cartão aguardando vínculo.</div>'}
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
  return [...cats].sort((a,b)=>{
    const ga=grupo(a),gb=grupo(b);
    return ga===gb?a.localeCompare(b,'pt-BR'):ga.localeCompare(gb,'pt-BR');
  });
}
function categoriasDisponiveis(real){
  const usadas=new Set(categoriasPlano(real));
  const dl=document.getElementById('cats-dl');
  const vals=dl?[...dl.querySelectorAll('option')].map(o=>o.value).filter(Boolean):[];
  return [...new Set(vals)].filter(c=>!neutral(c)&&!usadas.has(c)).sort((a,b)=>a.localeCompare(b,'pt-BR'));
}
function planVal(cat,mm){return Number(st.plan?.[cat]?.[mm]||0);}
function planTotalCat(cat){return MONTHS.reduce((s,m)=>s+planVal(cat,m),0);}
function realTotalCat(real,cat){return MONTHS.reduce((s,m)=>s+Number(real?.[cat]?.[m]||0),0);}
function planResumo(real){
  let recP=0,despP=0,recR=0,despR=0,resR=0;
  categoriasPlano(real).forEach(cat=>{
    const g=grupo(cat),p=planTotalCat(cat);
    if(g==='RECEITAS')recP+=p;else despP+=p;
  });
  // O consolidado realizado usa o mesmo motor do Demonstrativo/Excel.
  if(typeof root.calcularMotorDRE==='function'){
    MONTHS.forEach(mm=>{
      const r=root.calcularMotorDRE(mm+'/'+st.ano,'comp')||{};
      recR+=Number(r.receitas||0);
      despR+=Number(r.despesas||0);
      resR+=Number(r.final||0);
    });
  }else{
    categoriasPlano(real).forEach(cat=>{
      const g=grupo(cat),r=realTotalCat(real,cat);
      if(g==='RECEITAS')recR+=r;else despR+=r;
    });
    resR=recR-despR;
  }
  return {recP,despP,resP:recP-despP,recR,despR,resR};
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
      <div class="plan-toolbar"><select onchange="drePlanAno(this.value)">${anos.map(a=>`<option value="${a}" ${a===st.ano?'selected':''}>${a}</option>`).join('')}</select><select id="dre-plan-add-cat"><option value="">Adicionar categoria...</option>${categoriasDisponiveis(real).map(cat=>`<option value="${esc(cat)}">${esc(cat)}</option>`).join('')}</select><button class="btn bs" onclick="drePlanAddCat()">＋ Categoria</button><button class="btn bs" onclick="drePlanMedia()">Preencher vazios pela média realizada</button><button class="btn bg" onclick="drePlanSalvar()">💾 Salvar planejamento</button></div>
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

root.dreFinanceViewRender=function(v){
  ensureAreas();
  if(v==='conciliacao'){
    renderConc();
    if(!st.fluxoCarregado&&!st.fluxoLoading)carregarFluxo();
  }
  if(v==='planejamento'){if(!Object.keys(st.plan).length&&!st.loading)carregarPlano();else renderPlan();}
};
root.dreConcReprocessar=function(){try{root.reprocessarPagamentosCartaoDRE?.();}catch(_){}setTimeout(renderConc,120);};
root.dreFluxoSalvarBase=async function(){
  const data_inicio=document.getElementById('dre-fluxo-data')?.value||'';
  const saldo_inicial=document.getElementById('dre-fluxo-inicial')?.value;
  if(!data_inicio){root.toast?.('⚠️ Informe a data inicial do controle');return;}
  if(saldo_inicial===''||!Number.isFinite(Number(saldo_inicial))){root.toast?.('⚠️ Informe o saldo inicial');return;}
  const r=await api.put('/api/dre/fluxo-saldo',{data_inicio,saldo_inicial:Number(saldo_inicial)});
  if(!r?.ok){root.toast?.('❌ '+(r?.erro||'Erro ao salvar a base'));return;}
  if(r.conciliacao)setFluxoPacote(r.conciliacao); else await carregarFluxo();
  root.toast?.('✅ Base do fluxo salva');
  renderConc();
};

root.dreFluxoRegistrarConf=async function(){
  const data_ref=document.getElementById('dre-fluxo-data-real')?.value||'';
  const saldo=document.getElementById('dre-fluxo-real')?.value;
  const observacoes=document.getElementById('dre-fluxo-obs')?.value||'';
  if(!st.fluxo?.data_inicio){root.toast?.('⚠️ Salve primeiro a data e o saldo inicial');return;}
  if(!data_ref){root.toast?.('⚠️ Informe a data da conferência');return;}
  if(saldo===''||!Number.isFinite(Number(saldo))){root.toast?.('⚠️ Informe o saldo real do banco');return;}
  const r=await api.post('/api/dre/fluxo-conferencias',{data_ref,saldo_real:Number(saldo),observacoes});
  if(!r?.ok){root.toast?.('❌ '+(r?.erro||'Erro ao registrar saldo'));return;}
  setFluxoPacote(r);
  root.toast?.('✅ Saldo real registrado e conciliado');
  renderConc();
};

root.dreFluxoExcluirConf=async function(id){
  if(!confirm('Excluir esta conferência de saldo?'))return;
  const r=await api.delete('/api/dre/fluxo-conferencias/'+encodeURIComponent(id));
  if(!r?.ok){root.toast?.('❌ '+(r?.erro||'Erro ao excluir conferência'));return;}
  setFluxoPacote(r);
  root.toast?.('✅ Conferência removida');
  renderConc();
};

root.drePlanAno=v=>{st.ano=Number(v)||new Date().getFullYear();st.plan={};st.obs='';carregarPlano();};
root.drePlanSet=(cat,mm,v)=>{if(!st.plan[cat])st.plan[cat]={};const n=Number(v);st.plan[cat][mm]=Number.isFinite(n)?Math.max(0,n):0;renderPlan();};
root.drePlanAddCat=function(){
  const cat=document.getElementById('dre-plan-add-cat')?.value;
  if(!cat)return;
  if(!st.plan[cat])st.plan[cat]={};
  MONTHS.forEach(m=>{if(st.plan[cat][m]==null)st.plan[cat][m]=0;});
  renderPlan();
};
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
