'use strict';
(() => {
  const form=document.getElementById('adminSetupForm'),message=document.getElementById('setupMessage'),errorBox=document.getElementById('setupError'),button=document.getElementById('setupSubmit');
  const fragment=new URLSearchParams(location.hash.slice(1)),code=fragment.get('code');
  if(code && /^[a-f0-9]{64}$/.test(code))document.getElementById('setupCode').value=code;
  if(location.hash)history.replaceState(null,'','/admin/setup');
  async function request(method,body) {
    const response=await fetch('/api/admin-setup'+(method==='GET'?'/status':''),{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to complete setup.');return result;
  }
  request('GET').then(result=>{
    form.hidden=!result.available;
    message.textContent=result.available?'Enter the administrator email from your invitation and choose your new ProfitPlus password.':'This invitation is unavailable, expired or already used. If you created the account, use Sign in below.';
  }).catch(()=>{message.textContent='Unable to reach the setup service. Refresh to try again.';});
  form.onsubmit=async event=>{
    event.preventDefault();errorBox.hidden=true;
    const values=Object.fromEntries(new FormData(form));
    if(values.password!==values.confirmPassword){errorBox.textContent='The new passwords must match.';errorBox.hidden=false;return;}
    delete values.confirmPassword;button.disabled=true;
    try{await request('POST',values);form.reset();location.replace('/app#admin');}
    catch(error){errorBox.textContent=error.message;errorBox.hidden=false;button.disabled=false;}
  };
})();
