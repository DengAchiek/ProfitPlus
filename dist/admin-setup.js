'use strict';
(() => {
  const form=document.getElementById('adminSetupForm'),message=document.getElementById('setupMessage'),errorBox=document.getElementById('setupError'),button=document.getElementById('setupSubmit');
  function consumeInvitation(){
    const fragment=new URLSearchParams(location.hash.slice(1)),code=fragment.get('code');
    if(code && /^[a-f0-9]{64}$/.test(code))document.getElementById('setupCode').value=code;
    if(location.hash)history.replaceState(null,'','/admin/setup');
  }
  consumeInvitation();window.addEventListener('hashchange',()=>{consumeInvitation();loadStatus();});
  async function request(method,body) {
    const response=await fetch('/api/admin-setup'+(method==='GET'?'/status':''),{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to complete setup.');return result;
  }
  function loadStatus(){
    request('GET').then(result=>{
      form.hidden=!result.available;
      message.textContent=result.available?'Enter the administrator email from your invitation and choose your new BizAtrio password.':'This invitation is unavailable, expired or already used. If you created the account, use Sign in below.';
      document.getElementById('setupTitle').textContent=result.recovery?'Set up your admin access.':'Set your BizAtrio password.';
      document.getElementById('setupIntro').textContent=result.recovery?'Use this private invitation to create your admin account or set a new password for an existing admin account. Choose a BizAtrio password of at least 12 characters.':'This creates your BizAtrio account. Choose a new password for this application; your Google password is used only with Google.';
      document.getElementById('setupEffect').textContent=result.recovery?'For an existing admin account, this restores sign-in access and signs out previous sessions. Your business records are kept. The invitation works once, for the email it was issued to.':'Use at least 12 characters. This invitation works once, for the administrator email it was issued to.';
      button.textContent=result.recovery?'Set up admin access':'Create admin account';
    }).catch(()=>{message.textContent='Unable to reach the setup service. Refresh to try again.';});
  }
  loadStatus();
  form.onsubmit=async event=>{
    event.preventDefault();errorBox.hidden=true;
    const values=Object.fromEntries(new FormData(form));
    if(values.password!==values.confirmPassword){errorBox.textContent='The new passwords must match.';errorBox.hidden=false;return;}
    delete values.confirmPassword;button.disabled=true;
    try{await request('POST',values);form.reset();location.replace('/app#admin');}
    catch(error){errorBox.textContent=error.message;errorBox.hidden=false;button.disabled=false;}
  };
})();
