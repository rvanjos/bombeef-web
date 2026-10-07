(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.DREFluxo=api;})(typeof window!=='undefined'?window:null,function(root){
  'use strict';
  const Cartao=typeof module==='object'&&module.exports?require('./dre-cartao-pagamentos'):root?.DRECartaoPagamentos;
  const banco=t=>['EXTRATO','OFX'].includes(t.fonte);
  const documento=t=>String(t.fonte||'').startsWith('BOLETO');
  const cents=v=>Math.round(Number(v||0)*100);
  const ref=t=>String(t.faturaCC||t.cartaoFaturaRef||'');
  const pagamentoCartao=t=>banco(t)&&Number(t.valor)<0&&(
    ['Pagamento de Cartão','Pagamento de Fatura CC'].includes(t.categoria)||t.vinculadoFaturaCC||
    /pag(?:amento|to|\.)?\s*(?:de\s*)?(?:fatura|cart[aã]o)|pag.*fatura/i.test(t.lancamento||''));
  function identidade(t){
    const origem=documento(t)?'BOLETO':banco(t)?'BANCO':String(t.fonte||'');
    if(documento(t)&&t.boletoId)return origem+'|'+t.boletoId;
    if(banco(t)&&t.fitid)return origem+'|'+(t.conta||t.banco||'')+'|'+t.fitid;
    if(t.fonte==='CC'&&(t.item_hash||t.hash_item_persistido))return 'CC|'+ref(t)+'|'+(t.item_hash||t.hash_item_persistido);
    if(t.id)return origem+'|id|'+t.id;
    return origem+'|'+ref(t)+'|'+JSON.stringify([t.data,t.valor,t.lancamento,t.mes,t.parcela,t.totalParcelas]);
  }
  function resolver(txs,modo='comp'){
    const entrada=Array.isArray(txs)?txs:[];
    const faturas=Cartao?.faturasDosLancamentos(entrada)||[];
    const fontes=entrada.map(t=>{if(!banco(t)||ref(t))return t;const d=Cartao?.decidir(t,faturas);return d?.acao==='vincular'?{...t,faturaCC:d.fatura.faturaId,vinculadoFaturaCC:true}:t;});
    const ativos=fontes.filter(t=>!t.ignorar||pagamentoCartao(t));
    const documentos=new Map(),itens=new Map(),pagamentos=new Map(),suprimidos=[],pendencias=[];
    for(const t of ativos){
      if(documento(t)&&t.boletoId){const k=String(t.boletoId);const antigo=documentos.get(k);if(!antigo||(!antigo.categoria&&t.categoria))documentos.set(k,t);}
      if(t.fonte==='CC')itens.set(String(t.id),t);
      if(pagamentoCartao(t)){
        const k=ref(t)||'pagamento:'+t.id;
        if(!pagamentos.has(k))pagamentos.set(k,[]);
        pagamentos.get(k).push(t);
      }
    }
    const ccDocumentos=new Map();
    for(const d of documentos.values())if(d.cartaoItemRef)ccDocumentos.set(String(d.cartaoItemRef),d);
    const fitids=new Set(),linhas=[];
    const retirar=(t,motivo)=>{suprimidos.push({id:t.id,motivo,valor:t.valor});};
    const adicionar=(t)=>{
      const linha={...t};
      if(!String(linha.categoria||'').trim()){
        linha.categoria='A CLASSIFICAR';linha._pendenciaClassificacao=true;
        pendencias.push({id:t.id,tipo:'classificacao',valor:t.valor,mes:linha.mes,mesCaixa:linha.mesCaixa,descricao:t.lancamento||t.razaoSocial||''});
      }
      linhas.push(linha);
    };
    for(const t of ativos){
      if(banco(t)&&t.fitid){const k=String(t.conta||t.banco||'')+'|'+t.fitid;if(fitids.has(k)){retirar(t,'FITID repetido');continue;}fitids.add(k);}
      if(pagamentoCartao(t))continue;
      if(documento(t)){
        if(t.boletoId&&documentos.get(String(t.boletoId))!==t){retirar(t,'mesmo boleto');continue;}
        const pagamento=ativos.find(x=>banco(x)&&!pagamentoCartao(x)&&t.boletoId&&String(x.boletoId)===String(t.boletoId));
        const item=t.cartaoItemRef&&itens.get(String(t.cartaoItemRef));
        if(modo==='caixa'&&(pagamento||item)){retirar(t,'documento representado pelo pagamento');continue;}
        if(modo==='caixa'&&t.fonte==='BOLETO_PREV'&&!t.cartaoCredito){retirar(t,'documento ainda não pago');continue;}
        adicionar({...t,categoria:t.categoria||pagamento?.categoria||item?.categoria});continue;
      }
      if(t.fonte==='CC'){
        const d=ccDocumentos.get(String(t.id))||(t.documentoBoletoId&&documentos.get(String(t.documentoBoletoId)));
        if(modo==='comp'&&d){retirar(t,'compra representada por documento');continue;}
        const p=pagamentos.get(ref(t))?.at(-1);
        adicionar({...t,categoria:d?.categoria||t.categoria,mesCaixa:p?.mesCaixa||p?.mes||t.mesCaixa});continue;
      }
      if(banco(t)&&t.boletoId&&documentos.has(String(t.boletoId))){
        const d=documentos.get(String(t.boletoId));
        if(modo==='comp'){retirar(t,'documento é a despesa de competência');continue;}
        adicionar({...t,categoria:d.categoria||t.categoria});continue;
      }
      adicionar(t);
    }
    for(const [chave,pags] of pagamentos){
      // Identidade bancária, nunca mera coincidência de data e valor.
      const vistos=new Set();const unicos=pags.filter(t=>{if(!t.fitid)return true;const k=(t.conta||t.banco||'')+'|'+t.fitid;if(vistos.has(k)){retirar(t,'FITID repetido');return false;}vistos.add(k);return true;});
      const detalhes=chave.startsWith('pagamento:')?[]:ativos.filter(t=>t.fonte==='CC'&&ref(t)===chave);
      const docsSemItem=chave.startsWith('pagamento:')?[]:[...documentos.values()].filter(d=>ref(d)===chave&&(!d.cartaoItemRef||!itens.has(String(d.cartaoItemRef))));
      const pago=unicos.reduce((n,t)=>n+cents(t.valor),0);
      const representado=detalhes.reduce((n,t)=>n+cents(t.valor),0)+docsSemItem.reduce((n,t)=>n+cents(t.valor),0);
      // Pagamento parcial não reduz a despesa de competência da compra.
      const parcial=representado<0&&pago<0&&Math.abs(pago)<Math.abs(representado);
      const diferenca=parcial?0:pago-representado;
      if(modo==='caixa'&&representado<0&&pago<0){
        const originais=linhas.filter(t=>ref(t)===chave&&(t.fonte==='CC'||documento(t)));
        if(originais.length){
          for(const t of originais)linhas.splice(linhas.indexOf(t),1);
          const distribuido=Math.max(pago,representado);
          for(const p of unicos){
            const alvo=cents(p.valor)*distribuido/pago;
            let soma=0;
            originais.forEach((t,i)=>{
              const valor=i===originais.length-1?Math.round(alvo)-soma:Math.round(cents(t.valor)*alvo/representado);
              soma+=valor;linhas.push({...t,id:t.id+'__caixa_'+p.id,valor:valor/100,mesCaixa:p.mesCaixa||p.mes});
            });
          }
        }
      }
      if(diferenca!==0){
        const base=unicos.at(-1);
        adicionar({...base,id:base.id+'__pendencia',valor:diferenca/100,categoria:null,ignorar:false,lancamento:'Fatura pendente de detalhamento — '+(base.lancamento||''),mes:base.mesCaixa||base.mes});
        pendencias.push({id:base.id,tipo:'fatura',valor:diferenca/100,mes:base.mes,mesCaixa:base.mesCaixa,referencia:chave,descricao:'Pagamento e itens da fatura não conciliados'});
      }
      for(const p of unicos)retirar(p,diferenca===0?'pagamento representado pelos gastos da fatura':'pagamento substituído por gastos + diferença a classificar');
    }
    return {linhas,pendencias,suprimidos};
  }
  return {resolver,pagamentoCartao,identidade};
});
