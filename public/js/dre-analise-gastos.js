(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.DREAnaliseGastos=api;})(typeof window!=='undefined'?window:null,function(root){
 'use strict';
 const indice=m=>{const r=/^(0[1-9]|1[0-2])\/(\d{4})$/.exec(m||'');return r?Number(r[2])*12+Number(r[1])-1:null;};
 const mesDe=i=>String(i%12+1).padStart(2,'0')+'/'+Math.floor(i/12);
 function analisar(base,mes,opcoes={}){
  const alvo=indice(mes);if(alvo===null)return [];
  const hoje=opcoes.hoje||new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  const atual=indice(String(hoje).slice(5,7)+'/'+String(hoje).slice(0,4));if(atual!==null&&alvo>atual)return [];
  const minimo=Math.max(0,Number(opcoes.minimo??100))*100,limiar=Math.max(0,Number(opcoes.percentual??30))/100;
  const disponiveis=new Set(base.meses||[]),saida=[];
  const parcial=alvo===atual;
  for(const [grupo,categorias] of Object.entries(base.data||{})){
   if(['RECEITAS','OUTROS'].includes(grupo))continue;
   for(const [categoria,valores] of Object.entries(categorias)){
    if(!categoria||categoria==='A CLASSIFICAR')continue;
    const custo=m=>Math.max(0,-Math.round(Number(valores[m]||0)*100));
    const valor=custo(mes);if(!valor)continue;
    const anterior=mesDe(alvo-1),referencias=[];
    if(disponiveis.has(anterior)&&custo(anterior)>0)referencias.push({tipo:'mês anterior',base:custo(anterior),meses:[anterior]});
    const historico=[3,2,1].map(n=>mesDe(alvo-n)).filter(m=>disponiveis.has(m)&&custo(m)>0);
    const media=historico.length>=2?Math.round(historico.reduce((s,m)=>s+custo(m),0)/historico.length):0;
    if(media>0)referencias.push({tipo:'média recente',base:media,meses:historico});
    const comparacoes=referencias.filter(r=>valor-r.base>=minimo&&(valor-r.base)/r.base>=limiar).map(r=>({...r,base:r.base/100,diferenca:(valor-r.base)/100,percentual:(valor-r.base)/r.base*100}));
    if(comparacoes.length)saida.push({categoria,grupo,mes,valor:valor/100,parcial,comparacoes,impacto:Math.max(...comparacoes.map(r=>r.diferenca))});
   }
  }
  return saida.sort((a,b)=>b.impacto-a.impacto||a.categoria.localeCompare(b.categoria,'pt-BR'));
 }
 let ultimaBase=null,mesDre=null;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const brl=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 function atualizar(base,mes){
  if(!root?.document)return;ultimaBase=base;
  const destino=root.document.getElementById('dre-body');if(!destino)return;
  let painel=root.document.getElementById('dre-alertas-gastos');
  if(!painel){painel=root.document.createElement('section');painel.id='dre-alertas-gastos';painel.style.cssText='margin:10px 12px;border:1px solid #e4d8c9;border-radius:10px;background:#fffaf3;padding:12px';destino.before(painel);}
  const selecionado=mesDre===mes?painel.querySelector('select')?.value:mes;mesDre=mes;
  mostrar(selecionado||mes);
 }
 function mostrar(mes){
  if(!ultimaBase)return;
  const painel=root.document.getElementById('dre-alertas-gastos');if(!painel)return;
  const aberto=painel.querySelector('details')?.open||false,alertas=analisar(ultimaBase,mes);
  const meses=[...new Set([...(ultimaBase.meses||[]),mes])].sort((a,b)=>indice(b)-indice(a));
  painel.innerHTML=`<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><strong>🔎 Análise de gastos · ${alertas.length} alerta(s)</strong><label>Mês <select aria-label="Mês da análise de gastos" onchange="DREAnaliseGastos.mostrar(this.value)" style="padding:6px;border:1px solid #d7c8b7;border-radius:6px">${meses.map(m=>`<option ${m===mes?'selected':''}>${esc(m)}</option>`).join('')}</select></label></div><div style="font-size:11px;color:#76634f;margin:7px 0">Aumentos de pelo menos 30% e R$ 100 em relação ao mês anterior ou à média dos meses com gasto nos 3 meses anteriores. Usa o regime selecionado e os lançamentos após o tratamento de duplicidades.</div><details ${aberto?'open':''}><summary style="cursor:pointer;color:#8b0000;font-weight:600">${alertas.length?'Conferir variações de despesas':'Ver resultado da análise'}</summary><div style="padding-top:10px">${alertas.length?alertas.map(a=>`<article style="border-top:1px solid #ebdfd1;padding:10px 0"><div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap"><b>${esc(a.categoria)} · ${brl(a.valor)}</b><button type="button" class="btn bs" data-categoria="${esc(a.categoria)}" data-mes="${esc(mes)}" onclick="DREAnaliseGastos.abrir(this)">Conferir lançamentos</button></div>${a.comparacoes.map(r=>`<div style="margin-top:5px;font-size:12px">+${r.percentual.toFixed(1).replace('.',',')}% · ${brl(r.diferenca)} acima ${r.tipo==='mês anterior'?'do mês anterior':'da média recente'} (${brl(r.base)} · ${esc(r.meses.join(', '))})</div>`).join('')}${a.parcial?'<div style="font-size:11px;color:#946600;margin-top:5px">Mês em andamento: o gasto acumulado já ultrapassou a referência de meses completos.</div>':''}</article>`).join(''):'<p>Nenhum aumento ultrapassou os limites de alerta. Meses sem histórico suficiente não geram comparação.</p>'}<p style="font-size:11px;color:#76634f">Os avisos indicam pontos para conferir; podem refletir aumento real, duplicidade, pagamento acumulado ou classificação incorreta. Meses anteriores precisam estar importados para a comparação ser completa.</p></div></details>`;
 }
 function abrir(botao){root.drillDown(botao.dataset.categoria,botao.dataset.mes);}
 return {analisar,atualizar,mostrar,abrir};
});
