'use strict';

// Apenas a navegação de entrada do app tem uma tela de contingência.
// Não intercepta APIs, arquivos privados, módulos nem envios.
self.addEventListener('fetch', event => {
  const {request} = event;
  if(request.method !== 'GET' || request.mode !== 'navigate')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin || url.pathname!=='/' || url.search!=='?app=1')return;
  event.respondWith(fetch(request).catch(()=>new Response(
    '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bom Beef — Sem conexão</title><body style="font:18px system-ui;color:#27211e;background:#f7f4f0;max-width:32rem;margin:15vh auto;padding:24px"><h1 style="color:#8b0000">Bom Beef</h1><p>Não foi possível conectar ao sistema. Verifique a internet e tente novamente.</p><a href="/?app=1">Tentar novamente</a></body></html>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});
