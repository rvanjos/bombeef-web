/* OCR local: o documento permanece no navegador; apenas os recursos do leitor vêm do CDN. */
(function(root){
  'use strict';
  let carregando;
  function carregar(){
    if(root.Tesseract)return Promise.resolve(root.Tesseract);
    if(!carregando)carregando=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
      script.onload=()=>resolve(root.Tesseract);
      script.onerror=()=>{script.remove();carregando=null;reject(Error('Não foi possível carregar o leitor de imagens. Verifique a conexão e tente novamente.'));};
      document.head.appendChild(script);
    });
    return carregando;
  }
  async function ler(pdf,textos){
    if(pdf.numPages>30)throw Error('PDF por imagem limitado a 30 páginas. Divida o arquivo por fatura.');
    const fundo=document.createElement('div');
    fundo.style.cssText='position:fixed;inset:0;background:#0008;z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px';
    const painel=document.createElement('div');
    painel.style.cssText='background:white;border-radius:14px;padding:24px;width:440px;max-width:100%;color:#222';
    const titulo=document.createElement('h3');titulo.textContent='Lendo fatura por imagem';
    const status=document.createElement('p');status.style.cssText='margin:16px 0';status.textContent='Preparando o leitor. Na primeira vez, isso pode levar alguns instantes.';
    const barra=document.createElement('progress');barra.max=pdf.numPages;barra.value=0;barra.style.width='100%';
    const nota=document.createElement('p');nota.style.cssText='margin:12px 0;font-size:12px';nota.textContent='Nenhum lançamento será salvo antes da conferência. Mantenha esta tela aberta.';
    const botao=document.createElement('button');botao.textContent='Cancelar leitura';
    painel.append(titulo,status,barra,nota,botao);fundo.append(painel);document.body.append(fundo);
    let cancelado=false,worker,paginaAtual=0,rejeitar;
    const cancelError=()=>Error('Leitura cancelada. Nenhum lançamento foi salvo.');
    const interrompido=new Promise((_,reject)=>{rejeitar=reject;});
    interrompido.catch(()=>{});
    const aguardar=p=>Promise.race([p,interrompido]);
    const timer=setTimeout(()=>{cancelado=true;rejeitar(Error('A leitura excedeu 5 minutos. Nenhum lançamento foi salvo. Tente novamente ou envie o PDF original do banco.'));},300000);
    botao.onclick=()=>{cancelado=true;rejeitar(cancelError());};
    try{
      const T=await aguardar(carregar());if(cancelado)throw cancelError();
      const criacao=T.createWorker('eng',1,{
        workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
        corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
        logger:m=>{if(!cancelado&&paginaAtual&&m.status==='recognizing text')status.textContent='Página '+paginaAtual+' de '+pdf.numPages+' · '+Math.round(m.progress*100)+'%';}
      });
      criacao.then(w=>{if(cancelado)w.terminate().catch(()=>{});},()=>{});
      worker=await aguardar(criacao);
      await aguardar(worker.setParameters({tessedit_pageseg_mode:'6'}));
      const saida=[...textos];
      for(let i=1;i<=pdf.numPages;i++){
        if(cancelado)throw cancelError();paginaAtual=i;
        if((saida[i-1]||'').replace(/\s/g,'').length<40){
          status.textContent='Página '+i+' de '+pdf.numPages+' · preparando imagem';
          const page=await aguardar(pdf.getPage(i));
          const base=page.getViewport({scale:1});
          const viewport=page.getViewport({scale:Math.min(2.5,1500/base.width)});
          const canvas=document.createElement('canvas');
          canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          try{
            await aguardar(page.render({canvasContext:canvas.getContext('2d'),viewport}).promise);
            const resultado=await aguardar(worker.recognize(canvas));
            saida[i-1]=resultado.data.text;
          }finally{canvas.width=0;canvas.height=0;page.cleanup();}
        }
        barra.value=i;
      }
      if(cancelado)throw cancelError();
      return saida.join('\n--- PAGE ---\n');
    }finally{
      clearTimeout(timer);
      if(worker)await worker.terminate().catch(()=>{});
      fundo.remove();
    }
  }
  root.DRECartaoOCR={ler};
})(window);
