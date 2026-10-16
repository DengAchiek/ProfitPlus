(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PulseUsage=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const modules = ['overview','customers','leads','quotes','invoices','reports','integrations','settings','billing'];
  function create({send,now=Date.now,visible,tabId}) {
    let module=null,lastTick=now(),lastInteraction=now(),lastSent=0,seconds=0,view=false,sequence=0;
    function tick() {
      const current=now(), gap=current-lastTick,elapsed=gap>2500?0:Math.max(0,gap);
      if(module && visible()) seconds+=Math.max(0,Math.min(elapsed,lastInteraction+60000-lastTick))/1000;
      lastTick=current;
    }
    function flush(keepalive=false) {
      tick();
      if(!module || (!seconds&&!view) || now()-lastSent<1000)return;
      const payload={module,tabId,sequence:++sequence,activeSeconds:Math.min(60,seconds),view};
      seconds=0;view=false;lastSent=now();
      Promise.resolve(send(payload,keepalive)).catch(()=>{});
    }
    return {
      activity(){tick();lastInteraction=now();},
      module(value){if(value===module)return;flush();module=modules.includes(value)?value:null;seconds=0;view=!!module;lastTick=now();flush();},
      sample(){tick();if(view||now()-lastSent>=30000)flush();},
      flush,
      stop(){flush(true);module=null;seconds=0;view=false;lastTick=now();},
    };
  }
  return {create};
});
