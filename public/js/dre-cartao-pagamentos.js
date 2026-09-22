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
  function grupoDriveRef(ref){
    const s=String(ref||'');
    if(!s.startsWith('DRIVE:'))return null;
    const partes=s.split(':');
    if(partes.length<3)return null;
    return partes.slice(0,-1).join(':');
  }
  function faturasDoBanco(rows){
    const individuais=(Array.isArray(rows)?rows:[]).filter(r=>r&&r.fatura_id_ref&&Number(r.valor_total||0)>0.009).map(r=>({
      faturaId:String(r.fatura_id_ref), refs:[String(r.fatura_id_ref)], dbIds:[Number(r.id)],
      mes:r.competencia||'', bandeira:r.bandeira||r.cartao||'', total:Math.abs(Number(r.valor_total||0)),
      itens:Number(r.itens_total||r.qtd_itens||0), status:r.status||'', vencimento:r.vencimento||null,
      arquivo:r.arquivo_nome||'', origemBanco:true
    }));
    const grupos=new Map();
    for(const f of individuais){
      const k=grupoDriveRef(f.faturaId);
      if(!k)continue;
      if(!grupos.has(k))grupos.set(k,{faturaId:'GRUPO:'+k,refs:[],dbIds:[],mes:f.mes,bandeira:f.bandeira,total:0,itens:0,status:'',vencimento:f.vencimento,arquivo:f.arquivo,grupoPagamento:true,origemBanco:true});
      const g=grupos.get(k);g.refs.push(...f.refs);g.dbIds.push(...f.dbIds);g.total+=f.total;g.itens+=f.itens;
      if(!g.bandeira&&f.bandeira)g.bandeira=f.bandeira;
    }
    const agregadas=[...grupos.values()]
      .filter(g=>g.refs.length>1)
      .map(g=>({...g,total:Number(g.total.toFixed(2))}));
    return [...individuais,...agregadas];
  }
  function combinarFaturas(txs,dbRows){
    const mapa=new Map();
    for(const f of [...faturasDosLancamentos(txs),...faturasDoBanco(dbRows)]){
      const k=String(f.faturaId||'');if(!k)continue;
      if(!mapa.has(k))mapa.set(k,f);
      else {
        const a=mapa.get(k);
        mapa.set(k,{...a,...f,total:Number(f.total||a.total||0),refs:f.refs||a.refs,dbIds:f.dbIds||a.dbIds});
      }
    }
    return [...mapa.values()];
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
    let renderBase=null,processando=false,dbFaturas=[],ultimoFetch=0;
    const pagosMarcados=new Set();

    function txsAtuais(){
      try{
        if(typeof root.getDreTransactions==='function'){
          const v=root.getDreTransactions();
          if(Array.isArray(v))return v;
        }
      }catch(_){}
      return Array.isArray(root.TXS)?root.TXS:[];
    }
    function bbApi(){return root.BB&&root.BB.api?root.BB.api:null;}

    function limparOpcoesDuplicadas(){
      document.querySelectorAll('option').forEach(o=>{if(o.value===LEGACY)o.remove();});
      document.querySelectorAll('input.csel').forEach(i=>{if(i.value===LEGACY)i.value=CAT;});
    }

    async function carregarBanco(force){
      const now=Date.now();
      if(!force&&now-ultimoFetch<30000)return;
      const api=bbApi();if(!api)return;
      ultimoFetch=now;
      try{
        const [fat,itens]=await Promise.all([
          api.get('/api/dre/cartao-faturas'),
          api.get('/api/dre/cartao-faturas/itens-dre?meses=24')
        ]);
        if(fat&&fat.ok)dbFaturas=Array.isArray(fat.data)?fat.data:[];
        if(itens&&itens.ok&&Array.isArray(itens.data))sincronizarItens(itens.data);
      }catch(e){console.warn('[DRE cartões] sincronização:',e.message);}
    }

    function sincronizarItens(itens){
      const txs=txsAtuais();if(!Array.isArray(txs))return 0;
      const refs=new Set(txs.map(t=>String(t.cartaoItemRef||'')).filter(Boolean));
      const hashes=new Set(txs.filter(t=>t.faturaCC&&t.hash_item).map(t=>String(t.faturaCC)+'|'+String(t.hash_item)));
      let criados=0;
      for(const it of itens){
        const ref=String(it.cartaoItemRef||'');
        const hk=String(it.faturaCC||'')+'|'+String(it.hash_item||'');
        if((ref&&refs.has(ref))||(it.hash_item&&hashes.has(hk)))continue;
        txs.push({...it});
        if(ref)refs.add(ref);if(it.hash_item)hashes.add(hk);criados++;
      }
      if(criados){
        if(typeof root.render==='function')root.render();
        if(typeof root.renderDRE==='function')root.renderDRE();
        if(typeof root.updStats==='function')root.updStats();
        if(typeof root.autoSv==='function')root.autoSv();
        if(typeof root.toast==='function')root.toast('💳 '+criados+' item(ns) de fatura sincronizado(s) com o DRE');
      }
      return criados;
    }

    async function marcarFaturaPaga(fatura,tx){
      const api=bbApi();if(!api||!fatura)return;
      const refs=(Array.isArray(fatura.refs)&&fatura.refs.length?fatura.refs:[fatura.faturaId]).filter(r=>r&&!String(r).startsWith('GRUPO:'));
      for(const ref of refs){
        if(pagosMarcados.has(ref))continue;
        pagosMarcados.add(ref);
        try{
          const r=await api.patch('/api/dre/cartao-faturas/marcar-paga-por-ref',{
            fatura_id_ref:ref,data_pagamento:String(tx.data||'').slice(0,10)||null,origem:'dre_extrato_auto'
          });
          if(!r||r.ok===false)pagosMarcados.delete(ref);
        }catch(_){pagosMarcados.delete(ref);}
      }
    }

    async function processar(forceBanco){
      if(processando)return false;
      processando=true;
      try{
        await carregarBanco(!!forceBanco);
        const txs=txsAtuais();
        if(!Array.isArray(txs))return false;
        const faturas=combinarFaturas(txs,dbFaturas);
        let mudou=false,vinculados=0,pendentes=0,normalizados=0;
        const paraPagar=[];

        for(const tx of txs){
          if(tx.categoria===LEGACY){tx.categoria=CAT;normalizados++;mudou=true;}
          const r=decidir(tx,faturas);
          if(r.acao==='vinculado'){
            if(tx.categoria!==CAT){tx.categoria=CAT;mudou=true;}
            if(tx.needsReview){tx.needsReview=false;mudou=true;}
            tx._pagamentoCartaoPendente=false;
            const f=faturas.find(x=>String(x.faturaId)===String(tx.faturaCC));
            if(f)paraPagar.push([f,tx]);
          }else if(r.acao==='vincular'&&r.fatura){
            tx.categoria=CAT;
            tx.faturaCC=r.fatura.faturaId;
            tx.faturasCC=Array.isArray(r.fatura.refs)?r.fatura.refs:[r.fatura.faturaId];
            tx.faturaDbIds=Array.isArray(r.fatura.dbIds)?r.fatura.dbIds:[];
            tx.vinculadoFaturaCC=true;
            tx.needsReview=false;
            tx._pagamentoCartaoPendente=false;
            tx._pagamentoCartaoAuto=true;
            tx._pagamentoCartaoScore=r.score;
            paraPagar.push([r.fatura,tx]);
            vinculados++;mudou=true;
          }else if(r.acao==='pendente'){
            if(tx.categoria!==CAT){tx.categoria=CAT;mudou=true;}
            if(!tx.needsReview){tx.needsReview=true;mudou=true;}
            tx._pagamentoCartaoPendente=true;
            tx._pagamentoCartaoMotivo=r.motivo;
            pendentes++;
          }
        }
        limparOpcoesDuplicadas();
        if(mudou){
          if(typeof root.autoSv==='function')root.autoSv();
          if(typeof root.renderDRE==='function')root.renderDRE();
          if(renderBase)setTimeout(()=>renderBase(),0);
          if((vinculados||normalizados)&&typeof root.toast==='function')root.toast(`💳 Cartões: ${vinculados} pagamento(s) vinculado(s) automaticamente${normalizados?` · ${normalizados} classificação(ões) unificada(s)`:''}`);
        }
        paraPagar.forEach(([fat,tx])=>marcarFaturaPaga(fat,tx));
        return mudou;
      }finally{processando=false;}
    }

    function envolverRender(){
      if(renderBase||typeof root.render!=='function')return;
      renderBase=root.render;
      root.render=function(){const r=renderBase.apply(this,arguments);setTimeout(()=>processar(false),30);return r;};
    }
    function envolverSetCat(){
      if(typeof root.setCat!=='function'||root.setCat.__cartaoCanon)return;
      const old=root.setCat;
      const wrap=function(id,cat){const r=old.call(this,id,cat===LEGACY?CAT:cat);setTimeout(()=>processar(false),40);return r;};
      wrap.__cartaoCanon=true;root.setCat=wrap;
    }
    function init(){
      envolverRender();envolverSetCat();limparOpcoesDuplicadas();
      setTimeout(()=>processar(true),450);
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,180));else setTimeout(init,180);
    root.reprocessarPagamentosCartaoDRE=()=>processar(true);
    root.sincronizarFaturasAgenteDRE=()=>carregarBanco(true).then(()=>processar(false));
  }

  const api={CAT,LEGACY,norm,textoForte,categoriaCartao,faturasDosLancamentos,faturasDoBanco,combinarFaturas,candidatos,decidir,instalarBrowser};
  instalarBrowser();
  return api;
});
