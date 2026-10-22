'use strict';
(()=>{
  const $=id=>document.getElementById(id),forgot=$('forgotPasswordForm'),reset=$('resetPasswordForm');
  let token='',generation=0,submitting=false;
  function message(value){$('recoveryMessage').textContent=value;$('recoveryMessage').hidden=!value;}
  function error(value){$('recoveryError').textContent=value;$('recoveryError').hidden=!value;}
  async function request(route,body){
    const response=await fetch('/api/password/'+route,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    let result;try{result=await response.json();}catch{throw Error('Password recovery is temporarily unavailable. Please try again.');}
    if(!response.ok){const e=Error(result.error||'Password recovery is temporarily unavailable.');e.status=response.status;throw e;}return result;
  }
  async function initialize(){
    const version=++generation;token='';forgot.hidden=true;reset.hidden=true;error('');
    if(location.pathname==='/reset-password'){
      $('recoveryTitle').textContent='Choose your new password.';
      $('recoveryIntro').textContent='Use the password reset link sent to your registered email.';
      token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
      // A fragment never reaches the server. Clear it from the visible URL and
      // browser history immediately; retain it only in this page's memory.
      history.replaceState(null,'',location.pathname);
      if(!/^[a-f0-9]{64}$/.test(token)){message('');error('This reset link is missing or invalid. Request a new link below.');return;}
      message('Checking your reset link…');
      try{await request('validate',{token});if(version!==generation)return;message('This link works once and expires 15 minutes after it was requested.');reset.reset();reset.hidden=false;}
      catch(e){if(version===generation){token='';message('');error(e.message);}}
    }else{
      message('Checking password recovery…');
      try{const status=await request('status');if(version!==generation)return;if(!status.available)throw Error('Password recovery email is not configured yet. Contact the platform administrator.');message('We’ll send a private reset link if an active account matches your email.');forgot.hidden=false;}
      catch(e){if(version===generation){message('');error(e.message);}}
    }
  }
  async function submit(form,operation){
    if(submitting)return;const version=generation;submitting=true;error('');const button=form.querySelector('[type=submit]');button.disabled=true;
    try{await operation(Object.fromEntries(new FormData(form)));}catch(e){if(version===generation){error(e.message);if(e.status===400&&form===reset){token='';reset.reset();reset.hidden=true;message('');}}}
    finally{submitting=false;button.disabled=false;}
  }
  forgot.onsubmit=e=>{e.preventDefault();submit(forgot,async values=>{const result=await request('forgot',{email:values.email});message(result.message);forgot.reset();});};
  reset.onsubmit=e=>{e.preventDefault();const version=generation;submit(reset,async values=>{
    if(values.newPassword!==values.confirmPassword)throw Error('The new passwords must match.');
    await request('reset',{token,...values});if(version!==generation)return;token='';reset.reset();reset.hidden=true;
    $('recoveryTitle').textContent='Your password has been reset.';$('recoveryIntro').textContent='Sign in with your new BizAtrio password.';
    message('Your previous sessions have been signed out. Your records and account permissions are unchanged.');
  });};
  window.addEventListener('hashchange',()=>{if(location.pathname==='/reset-password'&&location.hash)initialize();});
  initialize();
})();
