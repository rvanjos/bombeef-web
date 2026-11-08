(function(w){
  'use strict';
  let ciclo=0,operacao=0,urlAtual=null,raizAtual=null,identidade='';
  function contexto(tk){try{const p=JSON.parse(atob(tk.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));return JSON.stringify([p.id,p.lojaId,p.sessaoId]);}catch(_){return '';}}
  function liberar(){operacao++;if(urlAtual){URL.revokeObjectURL(urlAtual);urlAtual=null;}}
  function el(tag,texto){const e=document.createElement(tag);if(texto)e.textContent=texto;return e;}
  function botao(texto,acao){const b=el('button',texto);b.type='button';b.className='btn btn-gray';b.onclick=acao;return b;}
  function nomeArquivo(doc,tipo){
    const ext=tipo==='application/pdf'?'pdf':tipo==='image/png'?'png':'jpg';
    let nome=String(doc.arquivo_nome||'documento-'+doc.id).replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g,'_').slice(0,160);
    if(!nome||/^\.+$/.test(nome))nome='documento-'+doc.id;
    if(!(ext==='jpg'?/\.jpe?g$/i:new RegExp('\\.'+ext+'$','i')).test(nome))nome+='.'+ext;
    return nome;
  }
  async function carregar(root){
    raizAtual=root;identidade=contexto(BB.api.token());
    const atual=++ciclo;liberar();root.replaceChildren(el('p','Carregando seus documentos...'));
    const d=await BB.api.get('/api/rh/documentos?escopo=meu');
    if(atual!==ciclo)return;
    root.replaceChildren();
    const topo=el('div');topo.style.cssText='display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px';
    topo.append(el('h2','Meus documentos'),botao('Atualizar',()=>carregar(root)));root.append(topo);
    if(!d.ok){root.append(el('p',d.erro||'Não foi possível carregar os documentos. Tente atualizar.'));return;}
    const itens=(d.data||[]).filter(x=>Number.isSafeInteger(Number(x.id))&&Number(x.id)>0);
    if(!itens.length){root.append(el('p','Nenhum documento vinculado ao seu cadastro nesta loja.'));return;}
    const aviso=el('p');aviso.setAttribute('role','status');aviso.style.cssText='margin:12px 0;color:#8b0000';root.append(aviso);
    const viewer=el('section');viewer.hidden=true;root.append(viewer);
    for(const doc of itens){
      const card=el('article');card.style.cssText='background:#fff;border:1px solid #e8e0d8;border-radius:12px;padding:16px;margin:12px 0';
      const estado=el('p',doc.confirmado_em?'Recebimento confirmado':doc.visualizado_em?'Visualizado — recebimento pendente':'Ainda não visualizado');estado.style.cssText='margin:8px 0;color:#73675e';
      const acoes=el('div');acoes.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
      const confirmar=botao('Confirmar recebimento',async()=>{
        if(!w.confirm('Confirmar o recebimento deste documento? Isso não significa concordância com valores ou quitação.'))return;
        confirmar.disabled=true;
        const r=await BB.api.post('/api/rh/documentos/'+Number(doc.id)+'/confirmar',{});
        if(atual!==ciclo)return;
        if(r.ok){await carregar(root);return;}
        aviso.textContent=r.erro||'Não foi possível confirmar o recebimento.';confirmar.disabled=false;
      });
      confirmar.disabled=!doc.visualizado_em;
      const abrir=async(modo='visualizar')=>{
        liberar();const op=operacao,tk=BB.api.token();aviso.textContent='Abrindo documento...';
        viewer.hidden=true;viewer.replaceChildren();
        try{
          const r=await fetch('/api/rh/documentos/'+Number(doc.id)+'/arquivo',{cache:'no-store',headers:{Authorization:'Bearer '+tk}});
          if(!r.ok){const erro=await r.json().catch(()=>({}));throw Error(erro.erro||'Não foi possível abrir o documento.');}
          const blob=await r.blob();
          if(atual!==ciclo||op!==operacao||tk!==BB.api.token())return;
          if(!['application/pdf','image/jpeg','image/png'].includes(blob.type.split(';')[0]))throw Error('Formato do documento não suportado para visualização.');
          urlAtual=URL.createObjectURL(blob);
          estado.textContent=doc.confirmado_em?'Recebimento confirmado':'Visualizado — recebimento pendente';confirmar.disabled=false;
          if(modo==='baixar'){
            const a=el('a');a.href=urlAtual;a.download=nomeArquivo(doc,blob.type.split(';')[0]);a.style.display='none';document.body.append(a);a.click();a.remove();
            aviso.textContent='Download solicitado. O recebimento continua dependendo da sua confirmação.';return;
          }
          const imagem=blob.type.startsWith('image/');
          const arquivo=el(imagem&&modo!=='imprimir'?'img':'iframe');arquivo.title=doc.titulo||'Documento do funcionário';arquivo.alt=doc.titulo||'Documento do funcionário';
          arquivo.style.cssText='width:100%;border:1px solid #ddd;border-radius:8px;'+(arquivo.tagName==='IMG'?'height:auto':'height:65vh');
          const link=el('a','Abrir em outra aba');link.href=urlAtual;link.target='_blank';link.rel='noopener';
          let pronto=false;
          const imprimir=()=>{
            if(!pronto||atual!==ciclo||op!==operacao)return;
            try{arquivo.contentWindow.focus();arquivo.contentWindow.print();aviso.textContent='Impressão solicitada. Se o navegador não abrir a impressão, use “Abrir em outra aba” ou baixe o arquivo para imprimir.';}
            catch(_){aviso.textContent='Use “Abrir em outra aba” ou baixe o arquivo e escolha Imprimir no visualizador do navegador.';}
          };
          const btnImprimir=botao('Imprimir arquivo',imprimir);btnImprimir.disabled=true;
          const prontoParaImprimir=()=>{if(atual!==ciclo||op!==operacao)return;pronto=true;btnImprimir.disabled=false;if(modo==='imprimir')imprimir();};
          if(arquivo.tagName==='IFRAME'){
            if(imagem){
              arquivo.onload=()=>{
                if(atual!==ciclo||op!==operacao)return;
                const pagina=arquivo.contentDocument,img=pagina.createElement('img'),style=pagina.createElement('style');
                pagina.title=doc.titulo||'Documento';
                style.textContent='@page{margin:12mm}body{margin:0}img{display:block;max-width:100%;height:auto}';pagina.head.append(style);
                img.onload=prontoParaImprimir;img.src=urlAtual;pagina.body.append(img);
              };
              arquivo.src='about:blank';
            }else{arquivo.onload=prontoParaImprimir;arquivo.src=urlAtual;}
          }else arquivo.src=urlAtual;
          viewer.append(el('h3',doc.titulo||'Documento'),link);
          if(arquivo.tagName==='IFRAME')viewer.append(btnImprimir);
          viewer.append(botao('Fechar visualização',()=>{liberar();viewer.replaceChildren();viewer.hidden=true;}),arquivo);
          viewer.hidden=false;aviso.textContent='Documento aberto. Confira o arquivo e confirme o recebimento quando estiver pronto.';
          viewer.scrollIntoView({behavior:'smooth',block:'start'});
        }catch(e){if(atual===ciclo&&op===operacao)aviso.textContent=e.message;}
      };
      acoes.append(botao('Visualizar documento',()=>abrir()),botao('Baixar',()=>abrir('baixar')),botao('Imprimir',()=>abrir('imprimir')));
      if(doc.exige_confirmacao&&!doc.confirmado_em)acoes.append(confirmar);
      card.append(el('h3',doc.titulo||'Documento'),el('p',doc.competencia?'Competência: '+doc.competencia:''),estado,acoes);
      if(doc.abrangencia==='geral')card.append(el('p','🌐 Documento geral da loja'));
      if(doc.observacao)card.append(el('p',doc.observacao));
      if(doc.exige_confirmacao&&!doc.confirmado_em)card.append(el('p','Abra o documento antes de confirmar. O ateste registra somente o recebimento e não significa concordância com valores ou quitação.'));
      root.append(card);
    }
  }
  w.addEventListener('pagehide',()=>{ciclo++;liberar();});
  w.addEventListener('message',e=>{
    if(e.origin!==w.location.origin||e.source!==w.parent)return;
    if(e.data?.type==='bb_logout'){
      ciclo++;liberar();identidade='';
      if(raizAtual)raizAtual.replaceChildren(el('p','Entre novamente para consultar seus documentos.'));
    }else if(e.data?.type==='bb_token'&&e.data.token){
      const proximo=contexto(e.data.token);
      if(proximo&&proximo!==identidade){
        ciclo++;liberar();identidade=proximo;
        if(raizAtual){raizAtual.replaceChildren();carregar(raizAtual);}
      }
    }
  });
  w.RHDocumentosFuncionario={carregar};
})(window);
