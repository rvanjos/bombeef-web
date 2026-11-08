(function(w){
  'use strict';
  const standalone=()=>w.navigator.standalone===true||w.matchMedia('(display-mode: standalone)').matches;
  const ativo=new URLSearchParams(w.location.search).get('app')==='1'||standalone();
  const modulos=[
    ['validade','🗓️','Validade','Consulte os vencimentos do estoque'],
    ['rh','📁','RH','Acesse documentos e lançamentos'],
    ['ponto','⏱️','Ponto','Registre e consulte suas batidas'],
    ['retiradas','💸','Retiradas','Consulte e registre retiradas']
  ];
  let convite=null;
  const porId=id=>document.getElementById(id);
  function botao(rotulo,classe,acao){
    const b=document.createElement('button');b.type='button';b.className=classe;b.textContent=rotulo;b.onclick=acao;return b;
  }
  function atualizarInstalacao(){
    for(const box of document.querySelectorAll('[data-bb-instalar]')){
      box.hidden=!ativo||standalone();
      const b=box.querySelector('button');if(b)b.hidden=!convite;
    }
  }
  w.addEventListener('beforeinstallprompt',e=>{
    if(!ativo)return;
    e.preventDefault();convite=e;atualizarInstalacao();
  });
  w.addEventListener('appinstalled',()=>{convite=null;atualizarInstalacao();});
  async function instalar(){
    if(!convite)return;
    const evento=convite;convite=null;
    try{await evento.prompt();}catch(_){/* instruções manuais permanecem disponíveis */}
    atualizarInstalacao();
  }
  function permitido(id,perfil){
    const tab=document.querySelector('.pnav-tab[data-tab="'+id+'"]');
    return !!tab&&(tab.dataset.perfil||'').split(',').includes(perfil);
  }
  function abrir(usuario,navegar){
    if(!ativo)return;
    const painel=porId('bb-app-modulos'),nav=porId('bb-app-nav');
    painel.replaceChildren();nav.replaceChildren(botao('Início','bb-app-nav-btn',()=>navegar('app-inicio')));
    let visiveis=0;
    for(const [id,icone,nome,descricao] of modulos){
      if(!permitido(id,usuario?.perfil))continue;
      visiveis++;
      const ir=()=>{if(permitido(id,usuario?.perfil))navegar(id);};
      const card=botao(icone+' '+nome,'bb-app-card',ir);
      const detalhe=document.createElement('small');detalhe.textContent=descricao;card.append(detalhe);
      painel.append(card);const atalho=botao(nome,'bb-app-nav-btn',ir);atalho.dataset.bbAppTab=id;nav.append(atalho);
    }
    porId('bb-app-sem-acesso').hidden=visiveis!==0;
    nav.hidden=false;nav.firstElementChild.dataset.bbAppTab='app-inicio';
    navegar('app-inicio');
  }
  function selecionar(tab){
    if(!ativo)return;
    for(const b of document.querySelectorAll('[data-bb-app-tab]')){
      if(b.dataset.bbAppTab===tab)b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    }
  }
  if(ativo){
    document.documentElement.classList.add('bb-app');
    const iniciar=()=>{
      for(const box of document.querySelectorAll('[data-bb-instalar]'))box.querySelector('button').onclick=instalar;
      atualizarInstalacao();
      if('serviceWorker' in w.navigator)w.navigator.serviceWorker.register('/bom-beef-sw.js').catch(()=>{});
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',iniciar,{once:true});
    else iniciar();
  }
  w.BomBeefApp={abrir,selecionar};
})(window);
