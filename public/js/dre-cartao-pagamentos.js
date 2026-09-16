(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.DRECartaoPagamentos=api;
})(typeof window!=='undefined'?window:null,function(root){
  'use strict';

  const CAT='Pagamento de Fatura CC';
  const LEGACY='Pagamento de Cartão';
  const FONTES_BANCO=new Set(['EXTRATO','OFX']);

  function norm(v){
    return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
  }
  function mesIdx(m){
    const x=String(m||'').match(/^(\d{2})\/(\d{4})$/); if(!x)return null;
    return Number(x[2])*12+Number(x[1])-1;
  }
  function diffMes(a,b){const x=mesIdx(a),y=mesIdx(b);return x==null||y==null?null:x-y;}
  function textoForte(tx){
    const s=norm((tx&&tx.lancamento)||'')+' '+norm((tx&&tx.razaoSocial)||'')+' '+norm((tx&&tx.fornecedor)||'');
    return /PAG(?:AMENTO|TO)?\s+(?:DE\s+)?FATURA|PAG(?:AMENTO|TO)?\s+.*CART|CARTAO\s+(?:DE\s+)?CREDITO|FATURA\s*ITAU|FATURA\s*CAIXA|FATURA\s*C6|ITAUCARD|FATURAITAU|DEB(?:ITO)?\s+.*CARTAO/.test(s);
  }
  function categoriaCartao(cat){return cat===CAT||cat===LEGACY;}
  function faturasDosLancamentos(txs){
    const mapa=new Map();
    (Array.isArray(txs)?txs:[]).forEach(t=>{
      if(String(t.fonte||'').toUpperCase()!=='CC'||!t.faturaCC)return;
      const id=String(t.faturaCC);
      if(!mapa.has(id)){
        const mm=id.match(/CC_(\d{2})_(\d{4})/);
        mapa.set(id,{faturaId:id,mes:mm?`${mm[1]}/${mm[2]}`:(t.mesCaixa||t.mes||''),bandeira:t.bandeira||'',soma:0,itens:0});
      }
      const f=mapa.get(id); f.soma+=Number(t.valor||0)||0; f.itens++;
      if(!f.bandeira&&t.bandeira)f.bandeira=t.bandeira;
    });
    return [...mapa.values()].map(f=>({...f,total:Math.abs(f.soma)})).filter(f=>f.total>0.009);
  }
  function tolerancia(total){return Math.max(0.05,Math.min(2,Math.abs(total||0)*0.001));}
  function tokenBandeiraCombina(tx,f){
    const texto=norm((tx.lancamento||'')+' '+(tx.razaoSocial||''));
    const b=norm(f.bandeira||'');
    const tokens=['ITAU','ITAUCARD','CAIXA','C6','VISA','MASTERCARD'];
    return tokens.some(k=>b.includes(k)&&texto.includes(k));
  }
  function candidatos(tx,faturas){
    const valor=Math.abs(Number(tx.valor||0));
    const mesTx=tx.mesCaixa||tx.mes||'';
    return (faturas||[]).map(f=>{
      const d=Math.abs(valor-Number(f.total||0));
      const dm=diffMes(mesTx,f.mes);
      const tol=tolerancia(f.total);
      if(d>tol||dm==null||dm<-1||dm>2)return null;
      let score=d<=0.05?80:70;
      if(dm===0)score+=20; else if(dm===1)score+=18; else if(dm===2)score+=8; else if(dm===-1)score+=5;
      if(textoForte(tx))score+=20;
      if(categoriaCartao(tx.categoria))score+=20;
      if(tokenBandeiraCombina(tx,f))score+=10;
      return {fatura:f,score,diferenca:d,diferencaMeses:dm};
    }).filter(Boolean).sort((a,b)=>b.score-a.score||a.diferenca-b.diferenca);
  }
  function decidir(tx,faturas){
    if(!tx||!FONTES_BANCO.has(String(tx.fonte||'').toUpperCase())||Number(tx.valor||0)>=0)return {acao:'nenhuma'};
    if(tx.faturaCC)return {acao:'vinculado',faturaId:tx.faturaCC};
    const catAtual=String(tx.categoria||'');
    const jaCartao=categoriaCartao(catAtual);
    if(catAtual&&!jaCartao)return {acao:'nenhuma'}; // não sobrescreve classificação manual de outra natureza
    const forte=textoForte(tx);
    const cs=candidatos(tx,faturas);
    const melhor=cs[0]; const segundo=cs[1];
    const unicoSeguro=!!melhor&&melhor.score>=90&&(!segundo||melhor.score-segundo.score>=10||melhor.diferenca+0.01<segundo.diferenca);
    const genericoExato=!!melhor&&!forte&&!jaCartao&&melhor.diferenca<=0.01&&melhor.diferencaMeses>=0&&melhor.diferencaMeses<=1&&cs.filter(c=>c.diferenca<=0.01).length===1;
    if(unicoSeguro||genericoExato)return {acao:'vincular',fatura:melhor.fatura,score:melhor.score};
    if(forte||jaCartao)return {acao:'pendente',motivo:cs.length?'Fatura compatível ambígua':'Fatura correspondente ainda não localizada'};
    return {acao:'nenhuma'};
  }

  function instalarBrowser(){
    if(!root||!root.document||root.__dreCartaoPagamentosInstalado)return;
    root.__dreCartaoPagamentosInstalado=true;
    let renderBase=null,processando=false;

    function limparOpcoesDuplicadas(){
      document.querySelectorAll('option').forEach(o=>{if(o.value===LEGACY)o.remove();});
      document.querySelectorAll('input.csel').forEach(i=>{if(i.value===LEGACY)i.value=CAT;});
    }
    function processar(){
      if(processando||!Array.isArray(root.TXS))return false;
      processando=true;
      try{
        const faturas=faturasDosLancamentos(root.TXS);
        let mudou=false,vinculados=0,pendentes=0,normalizados=0;
        root.TXS.forEach(tx=>{
          if(tx.categoria===LEGACY){tx.categoria=CAT;normalizados++;mudou=true;}
          const r=decidir(tx,faturas);
          if(r.acao==='vinculado'){
            if(tx.categoria!==CAT){tx.categoria=CAT;mudou=true;}
            if(tx.needsReview){tx.needsReview=false;mudou=true;}
            tx._pagamentoCartaoPendente=false;
          }else if(r.acao==='vincular'&&r.fatura){
            tx.categoria=CAT;
            tx.faturaCC=r.fatura.faturaId;
            tx.vinculadoFaturaCC=true;
            tx.needsReview=false;
            tx._pagamentoCartaoPendente=false;
            tx._pagamentoCartaoAuto=true;
            vinculados++;mudou=true;
          }else if(r.acao==='pendente'){
            if(tx.categoria!==CAT){tx.categoria=CAT;mudou=true;}
            if(!tx.needsReview){tx.needsReview=true;mudou=true;}
            tx._pagamentoCartaoPendente=true;
            tx._pagamentoCartaoMotivo=r.motivo;
            pendentes++;
          }
        });
        limparOpcoesDuplicadas();
        if(mudou){
          if(typeof root.autoSv==='function')root.autoSv();
          if(typeof root.renderDRE==='function')root.renderDRE();
          if(renderBase)setTimeout(()=>renderBase(),0);
          if((vinculados||normalizados)&&typeof root.toast==='function')root.toast(`💳 Cartões: ${vinculados} pagamento(s) vinculado(s) automaticamente${normalizados?` · ${normalizados} classificação(ões) unificada(s)`:''}`);
        }
        return mudou;
      }finally{processando=false;}
    }
    function envolverRender(){
      if(renderBase||typeof root.render!=='function')return;
      renderBase=root.render;
      root.render=function(){const r=renderBase.apply(this,arguments);setTimeout(processar,10);return r;};
    }
    function envolverSetCat(){
      if(typeof root.setCat!=='function'||root.setCat.__cartaoCanon)return;
      const old=root.setCat;
      const wrap=function(id,cat){const r=old.call(this,id,cat===LEGACY?CAT:cat);setTimeout(processar,20);return r;};
      wrap.__cartaoCanon=true;root.setCat=wrap;
    }
    function init(){envolverRender();envolverSetCat();limparOpcoesDuplicadas();setTimeout(processar,350);}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,180));else setTimeout(init,180);
    root.reprocessarPagamentosCartaoDRE=processar;
  }

  const api={CAT,LEGACY,norm,textoForte,categoriaCartao,faturasDosLancamentos,candidatos,decidir,instalarBrowser};
  instalarBrowser();
  return api;
});
