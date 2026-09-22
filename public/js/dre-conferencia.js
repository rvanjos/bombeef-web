(function(){
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = require('./dre-conferencia-core.js');
    return;
  }
  function tags(){
    return '<link rel="stylesheet" href="/css/dre-v2.css?v=3" data-dre-v2="1">' +
      '<script src="/js/dre-conferencia-core.js?v=4"><\/script>' +
      '<script src="/js/dre-v2.js?v=3" data-dre-v2="1"><\/script>' +
      '<script src="/js/dre-cartao-pagamentos.js?v=2" data-dre-cartao-pag="1"><\/script>' +
      '<script src="/js/dre-conferencia-v2.js?v=2" data-dre-conf-v2="1"><\/script>' +
      '<script src="/js/dre-lancamentos-area.js?v=3" data-dre-lanc-area="1"><\/script>' +
      '<script src="/js/dre-fechamento.js?v=2" data-dre-fechamento="1"><\/script>';
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.write(tags());
    } else {
      if (!document.querySelector('link[data-dre-v2]')) {
        var l=document.createElement('link'); l.rel='stylesheet'; l.href='/css/dre-v2.css?v=3'; l.dataset.dreV2='1'; document.head.appendChild(l);
      }
      var c=document.createElement('script'); c.src='/js/dre-conferencia-core.js?v=4'; c.onload=function(){
        var s=document.createElement('script'); s.src='/js/dre-v2.js?v=3'; s.dataset.dreV2='1'; s.onload=function(){
          var p=document.createElement('script'); p.src='/js/dre-cartao-pagamentos.js?v=2'; p.dataset.dreCartaoPag='1'; p.onload=function(){
            var q=document.createElement('script'); q.src='/js/dre-conferencia-v2.js?v=2'; q.dataset.dreConfV2='1'; q.onload=function(){
              var a=document.createElement('script'); a.src='/js/dre-lancamentos-area.js?v=3'; a.dataset.dreLancArea='1'; a.onload=function(){
                var f=document.createElement('script'); f.src='/js/dre-fechamento.js?v=2'; f.dataset.dreFechamento='1'; document.head.appendChild(f);
              }; document.head.appendChild(a);
            }; document.head.appendChild(q);
          }; document.head.appendChild(p);
        }; document.head.appendChild(s);
      }; document.head.appendChild(c);
    }
  }
})();
