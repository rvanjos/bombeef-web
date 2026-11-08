'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=p=>fs.readFileSync(require.resolve('../public/'+p),'utf8');

test('manifesto abre o portal no modo app, com ícones PNG do tamanho declarado',()=>{
  const m=JSON.parse(read('bom-beef.webmanifest'));
  assert.equal(m.start_url,'/?app=1');assert.equal(m.display,'standalone');
  for(const {src,sizes} of [...m.icons,{src:'/app-icons/bom-beef-180.png',sizes:'180x180'}]){
    const png=fs.readFileSync(require.resolve('../public'+src));
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16)+'x'+png.readUInt32BE(20),sizes);
  }
});

test('modo instalado reaproveita as permissões do portal e só mostra os atalhos autorizados',()=>{
  const mk=()=>({dataset:{},children:[],append(...els){this.children.push(...els)},replaceChildren(...els){this.children=els},get firstElementChild(){return this.children[0]}});
  const painel=mk(),nav=mk(),sem=mk(),caminhos=[],classes=[],registros=[];
  const els={'bb-app-modulos':painel,'bb-app-nav':nav,'bb-app-sem-acesso':sem};
  const window={location:{search:''},navigator:{standalone:true,serviceWorker:{register:async u=>registros.push(u)}},matchMedia:()=>({matches:false}),addEventListener(){}};
  const document={readyState:'complete',documentElement:{classList:{add:c=>classes.push(c)}},getElementById:id=>els[id],querySelectorAll:()=>[],createElement:mk,querySelector:s=>({dataset:{perfil:s.includes('rh')||s.includes('ponto')?'operador,admin':'admin'}})};
  vm.runInNewContext(read('js/bom-beef-app.js'),{window,document,URLSearchParams});
  assert.deepEqual(classes,['bb-app']);assert.deepEqual(registros,['/bom-beef-sw.js']);
  window.BomBeefApp.abrir({perfil:'operador'},x=>caminhos.push(x));
  assert.deepEqual(nav.children.map(x=>x.dataset.bbAppTab),['app-inicio','rh','ponto']);
  painel.children[1].onclick();nav.children[0].onclick();
  assert.deepEqual(caminhos,['app-inicio','ponto','app-inicio']);
});

test('worker não intercepta dados, arquivos, módulos ou envios',async()=>{
  let handler;const chamadas=[];
  vm.runInNewContext(read('bom-beef-sw.js'),{
    self:{location:{origin:'https://app.test'},addEventListener:(_,f)=>handler=f},
    URL,Response,fetch:async()=>{throw Error('offline')},
  });
  for(const [path,method,mode] of [['/api/ponto','POST','cors'],['/api/rh/documentos','GET','navigate'],['/ponto.html','GET','navigate'],['/','GET','navigate'],['/?app=1','GET','cors']]){
    handler({request:{url:'https://app.test'+path,method,mode},respondWith:r=>chamadas.push(r)});
  }
  assert.equal(chamadas.length,0);
  handler({request:{url:'https://app.test/?app=1',method:'GET',mode:'navigate'},respondWith:r=>chamadas.push(r)});
  const res=await chamadas[0];assert.equal(res.status,503);assert.equal(res.headers.get('Cache-Control'),'no-store');
  assert.match(await res.text(),/Verifique a internet/);
});
