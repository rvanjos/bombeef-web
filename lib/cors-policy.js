'use strict';
function politicaCors(env=process.env){
  const permitidas=new Set(String(env.ALLOWED_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean));
  if(env.RAILWAY_PUBLIC_DOMAIN)permitidas.add('https://'+env.RAILWAY_PUBLIC_DOMAIN);
  permitidas.add('https://bombeef-web-production.up.railway.app');
  return {credentials:true,origin(origin,cb){
    cb(null,!origin||env.NODE_ENV!=='production'||permitidas.has(origin));
  }};
}
module.exports={politicaCors};
