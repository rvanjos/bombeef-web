(function(w){
  'use strict';
  let geracao=0,dialogo=null;
  function limpar(){geracao++;if(dialogo){dialogo.remove();dialogo=null;}}
  async function verificar({consultar,abrir}){
    limpar();const atual=geracao;
    let resposta;
    // O heartbeat pode renovar a sessão no mesmo instante em que o portal abre.
    for(let tentativa=0;tentativa<3;tentativa++){
      if(atual!==geracao)return;
      try{resposta=await consultar();}catch(_){resposta=null;}
      if(resposta?.ok)break;
      if(tentativa<2)await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(atual!==geracao||!resposta?.ok||!Number.isSafeInteger(resposta.total)||resposta.total<=0)return;
    const anterior=document.activeElement;
    const d=document.createElement('dialog');dialogo=d;
    d.id='bb-documentos-aviso';d.setAttribute('aria-labelledby','bb-documentos-aviso-titulo');
    d.setAttribute('aria-describedby','bb-documentos-aviso-texto');
    d.style.cssText='margin:auto;border:1px solid #e8e0d8;border-radius:16px;padding:24px;width:460px;max-width:calc(100vw - 32px);max-height:85dvh;overflow:auto;box-sizing:border-box;color:#29221f;background:#fff;font:14px DM Sans,sans-serif;box-shadow:0 12px 48px #0004';
    const titulo=document.createElement('h2');titulo.id='bb-documentos-aviso-titulo';titulo.textContent='Documentos para visualizar';titulo.style.cssText='font-size:20px;margin:0 0 14px;color:#8b0000';
    const texto=document.createElement('p');texto.id='bb-documentos-aviso-texto';texto.textContent=resposta.total===1?'Você tem 1 documento aguardando visualização e confirmação de recebimento.':'Você tem '+resposta.total+' documentos aguardando visualização e confirmação de recebimento.';
    const nota=document.createElement('p');nota.textContent='Abra o documento e confirme o recebimento na tela de Documentos. Fechar este aviso não confirma o recebimento.';nota.style.cssText='font-size:12px;line-height:1.5;color:#73675e;margin:12px 0 20px';
    const acoes=document.createElement('div');acoes.style.cssText='display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap';
    const depois=document.createElement('button');depois.type='button';depois.textContent='Ver depois';
    const ver=document.createElement('button');ver.type='button';ver.textContent='Ver documentos';
    for(const b of [depois,ver])b.style.cssText='padding:11px 16px;border-radius:8px;border:1px solid #ddd5ce;font:inherit;cursor:pointer';
    ver.style.background='#8b0000';ver.style.color='#fff';
    const fechar=()=>{limpar();if(anterior?.isConnected)anterior.focus();};
    depois.onclick=fechar;ver.onclick=()=>{fechar();abrir();};
    d.addEventListener('cancel',e=>{e.preventDefault();fechar();});
    acoes.append(depois,ver);d.append(titulo,texto,nota,acoes);document.body.append(d);
    d.showModal();ver.focus();
  }
  w.BBDocumentosAviso={verificar,limpar};
})(window);
