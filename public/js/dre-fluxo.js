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
  function contaBanco(t){
    return String(t.contaBancaria||[t.bankId||t.banco||'',t.acctId||t.conta||''].join(':')).trim();
  }
  function identidade(t){
    const loja=String(t.loja_id||'');
    const origem=documento(t)?'BOLETO':banco(t)?'BANCO':String(t.fonte||'');
    if(documento(t)&&t.boletoId)return loja+'|'+origem+'|'+t.boletoId;
    if(banco(t)&&t.fitid)return loja+'|'+origem+'|'+contaBanco(t)+'|'+t.fitid;
    if(t.fonte==='CC'&&(t.item_hash||t.hash_item_persistido))return loja+'|CC|'+(t.fatura_db_id||ref(t))+'|'+(t.item_hash||t.hash_item_persistido);
    if(t.fonte==='CC'&&t.item_db_id&&t.fatura_db_id)return loja+'|CCDB|'+t.fatura_db_id+'|'+t.item_db_id;
    if(t.id)return loja+'|'+origem+'|id|'+t.id;
    return loja+'|'+origem+'|'+ref(t)+'|'+JSON.stringify([t.data,t.valor,t.lancamento,t.mes,t.parcela,t.totalParcelas]);
  }
  function deduplicar(fontes){
    const vistos=new Map(),suprimidos=[],aliases=new Map();
    const qualidade=t=>(t.ignorarAlteradoEm?2000:0)+(t.ignorar?0:1000)+(t._categoriaEditada?100:0)+(t.item_db_id?20:0)+(t.categoria?2:0)+(t.documentoBoletoId||t.cartaoItemRef?1:0)+(t.fonte==='BOLETO'?5:0);
    for(const t of fontes){
      if(t.ignorar&&t.duplicadoDe){aliases.set(String(t.id),String(t.duplicadoDe));suprimidos.push({id:t.id,motivo:'Duplicidade confirmada: '+t.duplicadoDe,valor:t.valor});continue;}
      // Só identidade comprovada; data/valor/descrição iguais exigem conferência.
      const temOrigem=t.id||(banco(t)&&t.fitid)||(documento(t)&&t.boletoId)||(t.fonte==='CC'&&(t.item_db_id||t.hash_item_persistido||t.item_hash));
      const k=temOrigem?identidade(t):'sem-identidade|'+vistos.size,ant=vistos.get(k);
      if(ant&&cents(ant.valor)===cents(t.valor)&&String(ant.data||'')===String(t.data||'')){
        const manter=qualidade(t)>qualidade(ant)?t:ant,outro=manter===t?ant:t;
        vistos.set(k,manter);aliases.set(String(outro.id),String(manter.id));
        suprimidos.push({id:outro.id,motivo:'Mesma identidade de origem: '+manter.id,valor:outro.valor});
      }else vistos.set(ant?k+'|conflito|'+String(t.id):k,t);
    }
    const final=id=>{const visitados=new Set();while(aliases.has(id)&&!visitados.has(id)){visitados.add(id);id=aliases.get(id);}return id;};
    return {fontes:[...vistos.values()].map(t=>t.cartaoItemRef&&aliases.has(String(t.cartaoItemRef))?{...t,cartaoItemRef:final(String(t.cartaoItemRef))}:t),suprimidos};
  }
  function detectarDuplicidades(txs){
    const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const grupos=new Map(),pares=[];
    for(const t of txs||[]){
      if(t.ignorar||(!banco(t)&&t.fonte!=='CC')||!t.data||!Number(t.valor))continue;
      const k=[t.loja_id||'',banco(t)?'BANCO':'CC',String(t.data).slice(0,10),cents(t.valor),t.fonte==='CC'?(t.mesCaixa||''):''].join('|');
      if(!grupos.has(k))grupos.set(k,[]);grupos.get(k).push(t);
    }
    for(const itens of grupos.values())for(let i=0;i<itens.length;i++)for(let j=i+1;j<itens.length;j++){
      const a=itens[i],b=itens[j];if(String(a.id)===String(b.id))continue;
      if(banco(a)&&contaBanco(a)!==':'&&contaBanco(b)!==':'&&contaBanco(a)!==contaBanco(b))continue;
      const x=norm(a.lancamento),y=norm(b.lancamento),fx=norm(a.razaoSocial),fy=norm(b.razaoSocial);
      const desc=x.length>=12&&y.length>=12&&(x.startsWith(y)||y.startsWith(x));
      const fornecedor=x===y&&fx.length>=12&&fx===fy;
      if(desc||fornecedor)pares.push({ids:[String(a.id),String(b.id)],motivo:identidade(a)===identidade(b)?'Mesma identidade de origem':'Mesma data e valor; descrição igual ou abreviada — confirmar'});
    }
    return pares;
  }
  function reconhecerNotas(fontes){
    const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>=3&&!['LTDA','COMERCIAL','COMERCIO','SERVICOS','SAO','PAULO','ATACADO','INDUSTRIA','CARNES','ACOUGUE','CAMPINAS','VALINHOS','INDAIATUBA'].includes(x));
    const pagos=new Set(fontes.filter(t=>banco(t)&&!pagamentoCartao(t)&&t.boletoId).map(t=>String(t.boletoId)));
    const docs=fontes.filter(t=>documento(t)&&!t.ignorar&&t.boletoId&&!t.cartaoItemRef&&!t.cartaoFaturaRef&&!pagos.has(String(t.boletoId)));
    const porValor=new Map();for(const d of docs){const k=Math.abs(cents(d.valor));if(!porValor.has(k))porValor.set(k,[]);porValor.get(k).push(d);}
    const pares=new Map(),reverso=new Map(),vinculos=[],pendencias=[];
    for(const c of fontes.filter(t=>t.fonte==='CC'&&!t.ignorar&&Number(t.valor)<0&&!t.documentoBoletoId&&!t.documentoStatus)){
      const a=norm(c.razaoSocial||c.lancamento),dc=c.data&&Date.parse(c.data);
      const candidatos=(porValor.get(Math.abs(cents(c.valor)))||[]).filter(d=>{
        if(c.loja_id&&d.loja_id&&String(c.loja_id)!==String(d.loja_id))return false;
        const dd=Date.parse(d.dataNota||d.data||'');if(!Number.isFinite(dc)||!Number.isFinite(dd)||Math.abs(dc-dd)>(d.dataNota?7:5)*86400000)return false;
        const b=norm(d.razaoSocial||d.lancamento);return !!a[0]&&a[0]===b[0];
      });
      if(candidatos.length){pares.set(c,candidatos);for(const d of candidatos){if(!reverso.has(d))reverso.set(d,[]);reverso.get(d).push(c);}}
    }
    const trocas=new Map();for(const [c,ds] of pares){
      if(ds.length===1&&reverso.get(ds[0]).length===1){const d=ds[0];trocas.set(d,{...d,cartaoItemRef:String(c.id),cartaoFaturaRef:ref(c),cartaoCredito:c.cartaoNome||c.bandeira||'Cartão',_vinculoCartaoInferido:true});vinculos.push({itemId:c.id,boletoId:d.boletoId,motivo:'Fornecedor, valor e data compatíveis; correspondência única'});}
      else pendencias.push({id:c.id,tipo:'vinculo_documento',valor:c.valor,mes:c.mes,mesCaixa:c.mesCaixa,descricao:'Mais de uma correspondência entre nota e compra no cartão; confirmar vínculo'});
    }
    return {fontes:fontes.map(t=>trocas.get(t)||t),vinculos,pendencias};
  }
  function resolver(txs,modo='comp'){
    const dedup=deduplicar(Array.isArray(txs)?txs:[]);
    const entrada=dedup.fontes;
    const faturas=Cartao?.faturasDosLancamentos(entrada)||[];
    const pagamentosResolvidos=entrada.map(t=>{if(!banco(t))return t;const d=Cartao?.decidir(t,faturas);return d?.acao==='vincular'?{...t,faturaCC:d.fatura.faturaId,faturasCCRefs:d.fatura.referencias||null,vinculadoFaturaCC:true}:t;});
    const notas=reconhecerNotas(pagamentosResolvidos),fontes=notas.fontes;
    const grupos=new Map();for(const p of fontes.filter(pagamentoCartao)){const refs=p.faturasCCRefs||faturas.find(f=>f.faturaId===ref(p))?.referencias||[];for(const r of refs)grupos.set(String(r),ref(p));}
    const chave=t=>grupos.get(ref(t))||ref(t);
    const ativos=fontes.filter(t=>!t.ignorar||pagamentoCartao(t));
    const documentos=new Map(),itens=new Map(),pagamentos=new Map(),bancosPorBoleto=new Map(),suprimidos=[...dedup.suprimidos],pendencias=[...notas.pendencias];
    for(const t of ativos){
      if(banco(t)&&!pagamentoCartao(t)&&t.boletoId&&!bancosPorBoleto.has(String(t.boletoId)))bancosPorBoleto.set(String(t.boletoId),t);
      if(documento(t)&&t.boletoId){const k=String(t.boletoId);const antigo=documentos.get(k);if(!antigo||(!antigo.categoria&&t.categoria))documentos.set(k,t);}
      if(t.fonte==='CC')itens.set(String(t.id),t);
      if(pagamentoCartao(t)){
        const k=chave(t)||'pagamento:'+t.id;
        if(!pagamentos.has(k))pagamentos.set(k,[]);
        pagamentos.get(k).push(t);
      }
    }
    const ccDocumentos=new Map();
    for(const d of documentos.values())if(d.cartaoItemRef)ccDocumentos.set(String(d.cartaoItemRef),d);
    const fitids=new Set(),linhas=[],faturasPendentes=[];
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
      if(pagamentoCartao(t))continue;
      if(documento(t)){
        if(t.boletoId&&documentos.get(String(t.boletoId))!==t){retirar(t,'mesmo boleto');continue;}
        const pagamento=t.boletoId?bancosPorBoleto.get(String(t.boletoId)):null;
        const item=t.cartaoItemRef&&itens.get(String(t.cartaoItemRef));
        if(modo==='caixa'&&(pagamento||item)){retirar(t,'documento representado pelo pagamento');continue;}
        if(modo==='caixa'&&t.fonte==='BOLETO_PREV'&&!t.cartaoCredito){retirar(t,'documento ainda não pago');continue;}
        adicionar({...t,categoria:t.categoria||pagamento?.categoria||item?.categoria});continue;
      }
      if(t.fonte==='CC'){
        const d=ccDocumentos.get(String(t.id))||(t.documentoBoletoId&&documentos.get(String(t.documentoBoletoId)));
        if(modo==='comp'&&d){retirar(t,'compra representada por documento');continue;}
        const p=pagamentos.get(chave(t))?.at(-1);
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
      const unicos=pags; // Identidades de origem já conciliadas antes de montar as faturas.
      const detalhes=chave.startsWith('pagamento:')?[]:fontes.filter(t=>t.fonte==='CC'&& (grupos.get(ref(t))||ref(t))===chave);
      const docsSemItem=chave.startsWith('pagamento:')?[]:[...documentos.values()].filter(d=>(grupos.get(ref(d))||ref(d))===chave&&(!d.cartaoItemRef||!itens.has(String(d.cartaoItemRef))));
      const pago=unicos.reduce((n,t)=>n+cents(t.valor),0);
      const representado=detalhes.reduce((n,t)=>n+cents(t.valor),0)+docsSemItem.reduce((n,t)=>n+cents(t.valor),0);
      // Pagamento parcial não reduz a despesa de competência da compra.
      const parcial=representado<0&&pago<0&&Math.abs(pago)<Math.abs(representado);
      const diferenca=parcial?0:pago-representado;
      if(modo==='caixa'&&representado<0&&pago<0){
        const originais=linhas.filter(t=>(grupos.get(ref(t))||ref(t))===chave&&(t.fonte==='CC'||documento(t)));
        if(originais.length){
          for(const t of originais)linhas.splice(linhas.indexOf(t),1);
          const totalOriginais=originais.reduce((s,t)=>s+cents(t.valor),0);
          const proporcao=Math.min(1,Math.abs(pago/representado));
          for(const p of unicos){
            const fracao=Math.abs(cents(p.valor)/pago)*proporcao;
            const alvo=totalOriginais*fracao;
            let soma=0;
            originais.forEach((t,i)=>{
              const valor=i===originais.length-1?Math.round(alvo)-soma:Math.round(cents(t.valor)*fracao);
              soma+=valor;linhas.push({...t,id:t.id+'__caixa_'+p.id,_origemId:t.id,valor:valor/100,mesCaixa:p.mesCaixa||p.mes});
            });
          }
        }
      }
      if(diferenca!==0){
        const base=unicos.at(-1);
        faturasPendentes.push({...base,_foraDRE:true,_pendenciaClassificacao:true,id:base.id+'__pendencia',_pagamentoOrigemId:base.id,valor:diferenca/100,categoria:null,ignorar:false,lancamento:'Fatura pendente de detalhamento — '+(base.lancamento||''),mes:base.mesCaixa||base.mes});
        pendencias.push({id:base.id,tipo:'fatura',valor:diferenca/100,mes:base.mes,mesCaixa:base.mesCaixa,referencia:chave,descricao:'Pagamento e itens da fatura não conciliados'});
      }
      for(const p of unicos)retirar(p,diferenca===0?'pagamento representado pelos gastos da fatura':'pagamento fora do resultado; detalhamento da fatura pendente');
    }
    return {linhas,pendencias,suprimidos,faturasPendentes,vinculosInferidos:notas.vinculos};
  }
  return {resolver,pagamentoCartao,identidade,contaBanco,deduplicar,detectarDuplicidades};
});
