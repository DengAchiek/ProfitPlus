'use strict';
(()=>{
  const script=document.currentScript,site=script?.getAttribute('data-profitplus-site');if(!/^[\w-]{8,100}$/.test(site||''))return;
  const service=new URL(script.src).origin,context={type:'profitplus-context',site,pageURL:location.origin+location.pathname,referrer:'',campaign:new URLSearchParams(location.search).get('utm_campaign')||''};
  try{const u=new URL(document.referrer);context.referrer=u.origin+u.pathname;}catch{}
  const frames=[...document.querySelectorAll('iframe[data-profitplus-site]')].filter(frame=>frame.getAttribute('data-profitplus-site')===site);
  const send=frame=>frame.contentWindow?.postMessage(context,service);
  for(const frame of frames){frame.addEventListener('load',()=>send(frame));send(frame);}
  window.addEventListener('message',event=>{if(event.origin!==service||event.data?.type!=='profitplus-form-ready'||event.data.site!==site)return;const frame=frames.find(f=>f.contentWindow===event.source);if(frame)send(frame);});
  fetch(service+'/api/capture/'+encodeURIComponent(site)+'/visit',{method:'POST',mode:'cors',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
})();
