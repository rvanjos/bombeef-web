(function(){
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = require('./dre-conferencia-core.js');
    return;
  }
  function tags(){
    return '<link rel="stylesheet" href="/css/dre-v2.css?v=1" data-dre-v2="1">' +
      '<script src="/js/dre-conferencia-core.js?v=1"><\/script>' +
      '<script src="/js/dre-v2.js?v=1" data-dre-v2="1"><\/script>';
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.write(tags());
    } else {
      if (!document.querySelector('link[data-dre-v2]')) {
        var l=document.createElement('link'); l.rel='stylesheet'; l.href='/css/dre-v2.css?v=1'; l.dataset.dreV2='1'; document.head.appendChild(l);
      }
      var c=document.createElement('script'); c.src='/js/dre-conferencia-core.js?v=1'; c.onload=function(){
        var s=document.createElement('script'); s.src='/js/dre-v2.js?v=1'; s.dataset.dreV2='1'; document.head.appendChild(s);
      }; document.head.appendChild(c);
    }
  }
})();
