'use strict';
const PlatformAdmin = (() => {
  const navigation=[['admin','Platform overview','◉'],['admin-clients','Clients','♧'],['admin-subscribers','Subscribers','◇'],['admin-activity','Client activity','◎'],['admin-performance','Performance','◫'],['admin-settings','Platform settings','⚙']];
  const descriptions={admin:'Monitor registrations, subscriptions and client activity across BizAtrio.','admin-clients':'Registered client businesses and their account details.','admin-subscribers':'Subscription status and plan information for client businesses.','admin-activity':'See which services clients use and their active time on the platform.','admin-performance':'Application request volumes, errors and response times.'};
  let days=30,userPage=1,clientPage=1,query='',clientQuery='',status='',businessId='',businessName='',lastView='',generation=0,detailGeneration=0,clientsGeneration=0,usersGeneration=0;
  const allowed=()=>!demo&&model.platformAdmin===true;
  const activeView=()=>allowed()&&navigation.some(([view])=>view===currentView)&&currentView!=='admin-settings';
  const duration=seconds=>seconds>=3600?(seconds/3600).toFixed(1)+' h':seconds>=60?Math.round(seconds/60)+' min':Math.round(seconds)+' sec';
  const integer=value=>Number(value||0).toLocaleString();
  const ms=value=>value===null?'—':Math.round(value)+' ms';
  const stamp=value=>value?esc(when(value)):'Not recorded';
  const shortDay=value=>new Intl.DateTimeFormat('en',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
  const statusLabel=value=>({active:'Active subscriber',trialing:'On trial',trial_expired:'Trial expired',past_due:'Past due',canceled:'Canceled',unpaid:'Unpaid',expired:'Expired',incomplete:'Incomplete',incomplete_expired:'Incomplete expired',paused:'Paused',unavailable:'Unavailable'})[value]||cap(value);
  const statusPill=value=>pill(statusLabel(value),value==='active'?'accepted':value==='trialing'?'quoted':value==='past_due'?'overdue':'archived');
  function bars(rows,field,format) {
    const max=Math.max(1,...rows.map(r=>r[field]));
    return rows.length?'<div class="admin-bars">'+rows.map(r=>'<div><div class="admin-bar-label"><span>'+esc(r.label)+'</span><strong>'+esc(format(r[field]))+'</strong></div><progress max="'+max+'" value="'+r[field]+'" aria-label="'+esc(r.label)+'"></progress></div>').join('')+'</div>':'<p class="muted">No measurements in this period yet.</p>';
  }
  function trend(rows,field,label) {
    const max=Math.max(1,...rows.map(r=>r[field])),width=720,height=155;
    const points=rows.map((r,i)=>(i/(rows.length-1)*width).toFixed(1)+','+(height-15-r[field]/max*(height-25)).toFixed(1)).join(' ');
    return '<figure class="admin-trend"><svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(label)+'"><title>'+esc(label)+'</title><line x1="0" y1="140" x2="720" y2="140" stroke="#dfe5da"/><polyline points="'+points+'" fill="none" stroke="#427554" stroke-width="3"/></svg><figcaption><span>'+shortDay(rows[0].day)+'</span><span>Daily peak: '+integer(rows.reduce((a,r)=>Math.max(a,r[field]),0))+'</span><span>'+shortDay(rows.at(-1).day)+'</span></figcaption></figure>';
  }
  function shell() {
    if(!allowed())return empty('Admin access required.','This area is available only to the platform administrator.');
    const title=navigation.find(([view])=>view===currentView)?.[1]||'Platform overview';
    return heading(title+'.',descriptions[currentView]||descriptions.admin,'<span class="pill accepted">Admin only</span>')+'<div class="toolbar"><label>ACTIVITY PERIOD<select id="adminPeriod">'+[7,30,90].map(n=>'<option value="'+n+'"'+(n===days?' selected':'')+'>Last '+n+' days</option>').join('')+'</select></label><button id="adminRefresh" class="quiet">Refresh</button><span id="adminFreshness" class="small"></span></div><div id="adminData" aria-live="polite"><p class="muted">Loading platform information…</p></div>';
  }
  function subscriptionMetrics(s) {
    return '<div class="metrics">'+metric('Client businesses',integer(s.clients),'Registered client workspaces',true)+metric('Active subscribers',integer(s.activeSubscribers),'Active subscription with a current billing period')+metric('On trial',integer(s.trialingClients),'Trial has not expired')+'</div>';
  }
  function serviceTable(services) {
    return services.length?'<div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Active time</th><th>Module visits</th><th>Actions</th></tr></thead><tbody>'+services.map(s=>'<tr><td>'+esc(s.label)+'</td><td>'+duration(s.activeSeconds)+'</td><td>'+integer(s.visits)+'</td><td>'+integer(s.actions)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="muted">No service activity measured yet.</p>';
  }
  function usageCards(d) {
    return '<div class="grid"><section class="card"><h2>Daily active client users</h2>'+trend(d.daily,'activeUsers','Daily active client users')+'</section><section class="card"><h2>Most used services</h2><p class="small">Successful service actions by client users.</p>'+bars(d.services.filter(s=>s.actions),'actions',integer)+'</section></div>';
  }
  function performance(d) {
    const p=d.performance;
    return '<div class="metrics">'+metric('API requests',integer(p.requests),'Application requests in the selected period',true)+metric('Average response handling',ms(p.averageMs),'Server handling time, excluding network transfer')+metric('Server error rate',p.errorRate===null?'—':p.errorRate.toFixed(2)+'%',integer(p.serverErrors)+' HTTP 5xx responses',false,p.serverErrors>0)+'</div>'+'<div class="grid"><section class="card"><h2>Daily requests</h2>'+trend(d.daily,'requests','Daily application API requests')+'</section><section class="card"><h2>Request health</h2>'+[['Longest handling time',p.requests?ms(p.maxMs):'—'],['Slow requests (≥ 1 sec)',integer(p.slow)],['Rejected requests (HTTP 4xx)',integer(p.clientErrors)],['Server errors (HTTP 5xx)',integer(p.serverErrors)]].map(([label,value])=>'<div class="stat-line"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</section></div>'+'<section class="card"><h2>API diagnostics</h2><div class="table-wrap"><table class="table"><thead><tr><th>Route</th><th>Requests</th><th>Average</th><th>5xx errors</th><th>4xx responses</th></tr></thead><tbody>'+d.routes.map(r=>'<tr><td class="wrap">'+esc(r.method+' '+r.route)+'</td><td>'+integer(r.requests)+'</td><td>'+ms(r.durationMs/r.requests)+'</td><td>'+integer(r.serverErrors)+'</td><td>'+integer(r.clientErrors)+'</td></tr>').join('')+'</tbody></table></div></section>';
  }
  function coverage(d) {
    return '<p class="report-definitions"><strong>Measurement coverage.</strong> Tracking started '+esc(when(d.trackingStartedAt))+'. '+integer(d.totals.missingRegistrationDates)+' client account(s) have no historical registration date. Usage summaries are retained for 90 days and use UTC dates. Active time counts visible, focused use, stops after 60 seconds idle and is capped across tabs. Actions come from successful service requests. Platform administrator activity is excluded. API handling times exclude network transfer, static assets, telemetry and admin queries; they do not measure uptime, CPU or memory. Subscription status is current, independently of the activity period. Expired billing and trial periods do not count as active.</p>';
  }
  function renderData(d) {
    if(!activeView()||!$('adminData'))return;
    $('adminFreshness').textContent='Updated '+when(d.generatedAt)+' · UTC activity dates';
    let html='';
    if(currentView==='admin'){
      html=subscriptionMetrics(d.subscriptions)+'<div class="metrics">'+metric('Registered client users',integer(d.totals.registeredUsers),'Owners and team members')+metric('Active client users',integer(d.totals.activeUsers),'Distinct client users in this period')+metric('Client active time',duration(d.totals.activeSeconds),'Visible, focused platform use')+'</div>'+usageCards(d);
      html+='<section class="card"><h2>Subscription overview</h2>'+d.subscriptions.byStatus.map(r=>'<div class="stat-line"><span>'+esc(statusLabel(r.status))+'</span><strong>'+integer(r.clients)+'</strong></div>').join('')+(d.subscriptions.clients?'':'<p class="muted">No registered clients yet.</p>')+'</section>';
    }else if(['admin-clients','admin-subscribers'].includes(currentView)){
      html=subscriptionMetrics(d.subscriptions)+'<section class="card"><h2>'+(currentView==='admin-clients'?'Registered clients':'Client subscriptions')+'</h2><form id="adminClientSearchForm" class="admin-search"><label>Search business, owner or email<input id="adminClientSearch" type="search" maxlength="100" value="'+esc(clientQuery)+'" placeholder="Find a client"></label>'+(currentView==='admin-subscribers'?'<label>Subscription status<select id="adminClientStatus"><option value="">All statuses</option>'+['active','trialing','past_due','trial_expired','expired','canceled','unpaid','incomplete','incomplete_expired','paused','unavailable'].map(v=>'<option value="'+v+'"'+(v===status?' selected':'')+'>'+esc(statusLabel(v))+'</option>').join('')+'</select></label>':'')+'<button type="submit" class="quiet">Search clients</button></form><div id="adminClients">Loading clients…</div></section>';
    }else if(currentView==='admin-activity'){
      html='<div class="metrics">'+metric('Active client users',integer(d.totals.activeUsers),'Platform total in the selected period',true)+metric('Client active time',duration(d.totals.activeSeconds),'Visible, focused platform use')+metric('Service actions',integer(d.totals.actions),'Successful client service actions')+'</div>'+usageCards(d)+'<div class="grid"><section class="card"><h2>Time by service</h2>'+bars([...d.services].sort((a,b)=>b.activeSeconds-a.activeSeconds).filter(s=>s.activeSeconds),'activeSeconds',duration)+'</section><section class="card"><h2>Client service activity</h2>'+serviceTable(d.services)+'</section></div>'+'<section class="card"><h2>Registered client users</h2>'+(businessId?'<p class="section-note">Showing users for '+esc(businessName)+'. <button id="adminClearClient" class="quiet">Show all clients</button></p>':'')+'<form id="adminSearchForm" class="admin-search"><label>Search name, email or business<input id="adminSearch" type="search" maxlength="100" value="'+esc(query)+'" placeholder="Find a client user"></label><button type="submit" class="quiet">Search users</button></form><div id="adminUsers">Loading client users…</div></section>';
    }else if(currentView==='admin-performance')html=performance(d);
    $('adminData').innerHTML=html+coverage(d);
    if($('adminSearchForm'))$('adminSearchForm').onsubmit=e=>{e.preventDefault();query=$('adminSearch').value;userPage=1;loadUsers().catch(showError);};
    if($('adminClearClient'))$('adminClearClient').onclick=()=>{businessId='';businessName='';userPage=1;load();};
    if($('adminClientSearchForm'))$('adminClientSearchForm').onsubmit=e=>{e.preventDefault();clientQuery=$('adminClientSearch').value;status=$('adminClientStatus')?.value||'';clientPage=1;loadClients().catch(showError);};
  }
  function pagination(total,page,prefix,noun) {
    return '<div class="pagination"><span>'+integer(total)+' '+noun+' · Page '+page+' of '+Math.max(1,Math.ceil(total/20))+'</span><div class="actions"><button id="'+prefix+'Prev"'+(page<=1?' disabled':'')+'>← Previous</button><button id="'+prefix+'Next"'+(page*20>=total?' disabled':'')+'>Next →</button></div></div>';
  }
  async function loadClients() {
    const version=++clientsGeneration,view=currentView;
    const result=await api('/admin/clients?days='+days+'&page='+clientPage+'&search='+encodeURIComponent(clientQuery)+'&status='+encodeURIComponent(view==='admin-subscribers'?status:''));
    if(version!==clientsGeneration||!allowed()||currentView!==view||!$('adminClients'))return;
    $('adminClients').innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Client business</th><th>Owner</th><th>Plan & status</th><th>Users</th><th>Last active</th><th>Active time</th><th>Activity</th></tr></thead><tbody>'+result.clients.map(c=>'<tr><td class="wrap"><strong>'+esc(c.name)+'</strong><span class="row-sub">Registered: '+stamp(c.registeredAt)+'</span></td><td class="wrap">'+esc(c.ownerName||'No client owner')+'<span class="row-sub">'+esc(c.ownerEmail||'—')+'</span></td><td>'+esc(cap(c.plan))+'<span class="row-sub">'+statusPill(c.subscriptionStatus)+'</span><span class="row-sub">'+(c.subscriptionStatus==='trialing'?'Trial ends: '+stamp(c.trialEndsAt):c.periodEndsAt?'Period ends: '+stamp(c.periodEndsAt):'')+(c.cancelAtPeriodEnd?' · Cancels at period end':'')+'</span></td><td>'+integer(c.enabledUsers)+' active / '+integer(c.users)+'</td><td class="wrap">'+stamp(c.lastSeenAt)+'</td><td>'+duration(c.activeSeconds)+'</td><td><button class="quiet" data-admin-client="'+esc(c.id)+'">View activity</button></td></tr>').join('')+'</tbody></table></div>'+(result.total?'':'<p class="small">No matching clients.</p>')+pagination(result.total,clientPage,'adminClients','clients');
    $('adminClientsPrev').onclick=()=>{clientPage--;loadClients().catch(showError);};$('adminClientsNext').onclick=()=>{clientPage++;loadClients().catch(showError);};
    $('adminClients').querySelectorAll('[data-admin-client]').forEach(b=>b.onclick=()=>{const c=result.clients.find(c=>c.id===b.dataset.adminClient);businessId=c.id;businessName=c.name;query='';userPage=1;go('admin-activity');});
  }
  async function loadUsers() {
    const version=++usersGeneration;
    const result=await api('/admin/users?days='+days+'&page='+userPage+'&search='+encodeURIComponent(query)+'&businessId='+encodeURIComponent(businessId));
    if(version!==usersGeneration||!allowed()||currentView!=='admin-activity'||!$('adminUsers'))return;
    $('adminUsers').innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Client user</th><th>Business</th><th>Registered</th><th>Last active</th><th>Active time</th><th>Top service</th><th>Profile</th></tr></thead><tbody>'+result.users.map(u=>'<tr><td class="wrap"><strong>'+esc(u.name)+'</strong><span class="row-sub">'+esc(u.email)+'</span>'+pill(u.active?'Active account':'Disabled',u.active?'accepted':'archived')+'</td><td class="wrap">'+esc(u.businessName)+'<span class="row-sub">'+esc(cap(u.role)+' · '+cap(u.plan))+'</span></td><td class="wrap">'+stamp(u.registeredAt)+'</td><td class="wrap">'+stamp(u.lastSeenAt)+'</td><td>'+duration(u.activeSeconds)+'</td><td>'+esc(u.topService||'No activity')+'</td><td><button class="quiet" data-admin-user="'+esc(u.id)+'">View profile</button></td></tr>').join('')+'</tbody></table></div>'+(result.total?'':'<p class="small">No matching client users.</p>')+pagination(result.total,userPage,'adminUsers','users');
    $('adminUsersPrev').onclick=()=>{userPage--;loadUsers().catch(showError);};$('adminUsersNext').onclick=()=>{userPage++;loadUsers().catch(showError);};
    $('adminUsers').querySelectorAll('[data-admin-user]').forEach(b=>b.onclick=()=>profile(b.dataset.adminUser).catch(showError));
  }
  function showError(error) { if(activeView())showToast(error.message); }
  async function load() {
    if(!activeView())return;
    const version=++generation,view=currentView;clientsGeneration++;usersGeneration++;
    try{
      const result=await api('/admin/dashboard?days='+days);
      if(version!==generation||currentView!==view||!allowed())return;
      renderData(result);
      if(['admin-clients','admin-subscribers'].includes(view))await loadClients();
      if(view==='admin-activity')await loadUsers();
    }catch(error){if($('adminData')&&activeView()&&version===generation)$('adminData').innerHTML='<div class="error">'+esc(error.message)+'</div>';}
  }
  async function profile(id) {
    const version=++detailGeneration,view=currentView;
    const data=await api('/admin/users/'+encodeURIComponent(id)+'?days='+days);
    if(!allowed()||currentView!==view||version!==detailGeneration)return;
    const u=data.user,b=data.business;
    openDialog(u.name,'<p class="section-note">Client account profile · last '+days+' days of measured service usage</p><div class="pair">'+[['Email',u.email],['Account role',cap(u.role)],['Account status',u.active?'Active':'Disabled'],['Business',b.name],['Plan',cap(u.plan)+' · '+statusLabel(u.subscriptionStatus)],['Registered',u.registeredAt?when(u.registeredAt):'Not recorded before tracking began'],['Last sign in',u.lastLoginAt?when(u.lastLoginAt):'Not measured'],['Last active',u.lastSeenAt?when(u.lastSeenAt):'Not measured'],['Business email',b.email||'—'],['Business phone',b.phone||'—'],['Address',b.address||'—'],['Currency / timezone',b.currency+' · '+b.timezone]].map(([label,value])=>'<div class="admin-profile-field"><span class="small">'+esc(label)+'</span><div>'+esc(value)+'</div></div>').join('')+'</div><h3 class="admin-subtitle">Frequently used services</h3>'+serviceTable(data.services));
  }
  return {navigation,render:shell,reload:load,
    mount(){if(!activeView())return;if(lastView!==currentView){clientPage=1;if(currentView==='admin-subscribers')status='active';lastView=currentView;}generation++;detailGeneration++;$('adminPeriod').onchange=()=>{days=Number($('adminPeriod').value);userPage=1;clientPage=1;load();};$('adminRefresh').onclick=load;load();},
    clear(){query='';clientQuery='';status='';businessId='';businessName='';lastView='';userPage=1;clientPage=1;generation++;detailGeneration++;clientsGeneration++;usersGeneration++;},
  };
})();
