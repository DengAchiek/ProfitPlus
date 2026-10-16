'use strict';
const PlatformAdmin = (() => {
  let days=30,userPage=1,query='',snapshot=null,userList=null,generation=0,dashboardGeneration=0,detailGeneration=0;
  const duration = seconds => seconds>=3600?(seconds/3600).toFixed(1)+' h':seconds>=60?Math.round(seconds/60)+' min':Math.round(seconds)+' sec';
  const integer = value => Number(value||0).toLocaleString();
  const ms = value => value===null?'—':Math.round(value)+' ms';
  const shortDay = value => new Intl.DateTimeFormat('en',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
  const allowed = () => !demo && model.platformAdmin===true;
  function bars(rows,field,format) {
    const max=Math.max(1,...rows.map(r=>r[field]));
    return rows.length?'<div class="admin-bars">'+rows.map(r=>'<div><div class="admin-bar-label"><span>'+esc(r.label)+'</span><strong>'+esc(format(r[field]))+'</strong></div><progress max="'+max+'" value="'+r[field]+'" aria-label="'+esc(r.label)+'"></progress></div>').join('')+'</div>':'<p class="muted">No measurements in this period yet.</p>';
  }
  function trend(rows,field,label) {
    const max=Math.max(1,...rows.map(r=>r[field])),width=720,height=155;
    const points=rows.map((r,i)=>((i/(rows.length-1))*width).toFixed(1)+','+(height-15-r[field]/max*(height-25)).toFixed(1)).join(' ');
    return '<figure class="admin-trend"><svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(label)+'"><title>'+esc(label)+'</title><line x1="0" y1="140" x2="720" y2="140" stroke="#dfe5da"/><polyline points="'+points+'" fill="none" stroke="#427554" stroke-width="3"/>'+rows.map((r,i)=>'<circle cx="'+(i/(rows.length-1)*width)+'" cy="'+(height-15-r[field]/max*(height-25))+'" r="3" fill="#427554"><title>'+shortDay(r.day)+': '+r[field]+'</title></circle>').join('')+'</svg><figcaption><span>'+shortDay(rows[0].day)+'</span><span>Daily peak: '+integer(max===1&&rows.every(r=>!r[field])?0:max)+'</span><span>'+shortDay(rows.at(-1).day)+'</span></figcaption></figure>';
  }
  function shell() {
    if(!allowed())return empty('Admin access required.','This dashboard is available only to the platform administrator.');
    return heading('Platform administration.','Understand your users, their workflows and application performance.','<span class="pill accepted">Admin only</span>')+
      '<div class="toolbar"><label>PERIOD<select id="adminPeriod">'+[7,30,90].map(n=>'<option value="'+n+'"'+(n===days?' selected':'')+'>Last '+n+' days</option>').join('')+'</select></label><button id="adminRefresh" class="quiet">Refresh analytics</button><span id="adminFreshness" class="small"></span></div><div id="adminData" aria-live="polite"><p class="muted">Loading platform analytics…</p></div>';
  }
  function renderData() {
    if(!allowed()||!snapshot||!$('adminData'))return;
    const d=snapshot,t=d.totals,p=d.performance;
    const findings=[];
    if(t.activeUsers)findings.push(integer(t.activeUsers)+' users used the platform, with '+duration(t.activeSeconds/t.activeUsers)+' average active time per active user.');
    else findings.push('No user activity has been measured in this period yet.');
    const top=d.services.find(s=>s.actions>0);
    if(top)findings.push(top.label+' is the most frequently completed service ('+integer(top.actions)+' actions).');
    if(p.requests)findings.push(integer(p.serverErrors)+' server errors across '+integer(p.requests)+' API requests; '+ms(p.averageMs)+' average handling time.');
    $('adminFreshness').textContent='Updated '+when(d.generatedAt)+' · UTC dates';
    $('adminData').innerHTML='<div class="metrics">'+metric('Registered users',integer(t.registeredUsers),'All accounts · '+integer(t.businesses)+' workspaces',true)+metric('Active users',integer(t.activeUsers),'Distinct users with a visit, active time or action')+metric('New registrations',integer(t.newUsers),'Known registration dates in this period')+metric('Active time',duration(t.activeSeconds),'Visible, focused app · idle cutoff 60 sec')+metric('Service actions',integer(t.actions),'Successful saves, PDFs, backups and billing actions')+metric('API server error rate',p.errorRate===null?'—':p.errorRate.toFixed(2)+'%',integer(p.serverErrors)+' responses with HTTP 5xx',false,p.serverErrors>0)+'</div>'+
      '<section class="card"><h2>Application insights</h2><ul class="admin-insights">'+findings.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul></section>'+
      '<div class="grid"><section class="card"><h2>Daily active users</h2>'+trend(d.daily,'activeUsers','Daily active users')+'</section><section class="card"><h2>Most used services</h2><p class="small">Completed actions in this period; module visits are shown below.</p>'+bars(d.services.filter(s=>s.actions),'actions',integer)+'</section></div>'+
      '<div class="grid"><section class="card"><h2>Time by service</h2>'+bars([...d.services].sort((a,b)=>b.activeSeconds-a.activeSeconds).filter(s=>s.activeSeconds),'activeSeconds',duration)+'</section><section class="card"><h2>API performance</h2>'+[['Requests',integer(p.requests)],['Average handling time',ms(p.averageMs)],['Longest handling time',p.requests?ms(p.maxMs):'—'],['Slow requests (≥ 1 sec)',integer(p.slow)],['Rejected requests (HTTP 4xx)',integer(p.clientErrors)]].map(([label,value])=>'<div class="stat-line"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</section></div>'+
      '<section class="card"><h2>Registered users</h2><form id="adminSearchForm" class="admin-search"><label>Search name, email or business<input id="adminSearch" type="search" maxlength="100" value="'+esc(query)+'" placeholder="Find a registered user"></label><button type="submit" class="quiet">Search users</button></form><div id="adminUsers"></div></section>'+
      '<details class="card"><summary>Service activity and API diagnostics</summary><h3 class="admin-subtitle">Service activity</h3>'+serviceTable(d.services)+
      '<h3 class="admin-subtitle">API routes</h3><div class="table-wrap"><table class="table"><thead><tr><th>Route</th><th>Requests</th><th>Average</th><th>5xx errors</th><th>4xx responses</th></tr></thead><tbody>'+d.routes.map(r=>'<tr><td class="wrap">'+esc(r.method+' '+r.route)+'</td><td>'+integer(r.requests)+'</td><td>'+ms(r.durationMs/r.requests)+'</td><td>'+integer(r.serverErrors)+'</td><td>'+integer(r.clientErrors)+'</td></tr>').join('')+'</tbody></table></div><h3 class="admin-subtitle">Daily totals</h3><div class="table-wrap"><table class="table"><thead><tr><th>UTC date</th><th>Active users</th><th>New users</th><th>Active time</th><th>Actions</th><th>API requests</th><th>5xx errors</th></tr></thead><tbody>'+d.daily.map(r=>'<tr><td>'+esc(r.day)+'</td><td>'+r.activeUsers+'</td><td>'+r.newUsers+'</td><td>'+duration(r.activeSeconds)+'</td><td>'+r.actions+'</td><td>'+r.requests+'</td><td>'+r.serverErrors+'</td></tr>').join('')+'</tbody></table></div></details>'+
      '<div class="report-definitions"><strong>Measurement coverage.</strong> Tracking started '+esc(when(d.trackingStartedAt))+'. '+integer(t.missingRegistrationDates)+' existing account(s) have no historical registration date. Usage and API summaries are retained for 90 days; all dates use UTC. Active time is an estimate from browser heartbeats while the app is visible, focused and recently used, capped across tabs. Service actions are recorded by the server; visits and time are reported by the browser. API timings measure application handling, excluding network transfer, static assets, telemetry, admin queries and failures before the application starts. These metrics do not measure uptime, CPU or memory. No activity is backfilled.</div>';
    renderUsers();
    $('adminSearchForm').onsubmit=event=>{event.preventDefault();query=$('adminSearch').value;userPage=1;loadUsers().catch(showError);};
  }
  function serviceTable(services) {
    return '<div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Active time</th><th>Module visits</th><th>Actions</th></tr></thead><tbody>'+services.map(s=>'<tr><td>'+esc(s.label)+'</td><td>'+duration(s.activeSeconds)+'</td><td>'+integer(s.visits)+'</td><td>'+integer(s.actions)+'</td></tr>').join('')+'</tbody></table></div>';
  }
  function renderUsers() {
    if(!allowed()||!$('adminUsers'))return;
    if(!userList){$('adminUsers').textContent='Loading users…';return;}
    $('adminUsers').innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Workspace</th><th>Registered</th><th>Last active</th><th>Active time</th><th>Top service</th><th>Profile</th></tr></thead><tbody>'+userList.users.map(u=>'<tr><td class="wrap"><strong>'+esc(u.name)+'</strong><span class="row-sub">'+esc(u.email)+'</span>'+pill(u.active?'Active account':'Disabled',u.active?'accepted':'archived')+'</td><td class="wrap">'+esc(u.businessName)+'<span class="row-sub">'+esc(cap(u.role)+' · '+cap(u.plan))+'</span></td><td class="wrap">'+(u.registeredAt?esc(when(u.registeredAt)):'Not recorded')+'</td><td class="wrap">'+(u.lastSeenAt?esc(when(u.lastSeenAt)):'Not measured')+'</td><td>'+duration(u.activeSeconds)+'</td><td>'+esc(u.topService||'No activity')+'</td><td><button class="quiet" data-admin-user="'+esc(u.id)+'">View profile</button></td></tr>').join('')+'</tbody></table></div>'+(userList.total?'':'<p class="small">No matching users.</p>')+
      '<div class="pagination"><span>'+integer(userList.total)+' users · Page '+userPage+' of '+Math.max(1,Math.ceil(userList.total/20))+'</span><div class="actions"><button id="adminPrev"'+(userPage<=1?' disabled':'')+'>← Previous</button><button id="adminNext"'+(userPage*20>=userList.total?' disabled':'')+'>Next →</button></div></div>';
    $('adminPrev').onclick=()=>{userPage--;loadUsers().catch(showError);};
    $('adminNext').onclick=()=>{userPage++;loadUsers().catch(showError);};
    $('adminUsers').querySelectorAll('[data-admin-user]').forEach(button=>button.onclick=()=>profile(button.dataset.adminUser).catch(showError));
  }
  function showError(error) { if(allowed()&&currentView==='admin')showToast(error.message); }
  async function loadUsers() {
    const version=++generation;
    const result=await api('/admin/users?days='+days+'&page='+userPage+'&search='+encodeURIComponent(query));
    if(version!==generation||!allowed()||currentView!=='admin')return;
    userList=result;renderUsers();
  }
  async function load() {
    if(!allowed())return;
    const period=days,version=++dashboardGeneration;generation++;
    try {
      const result=await api('/admin/dashboard?days='+period);
      if(!allowed()||currentView!=='admin'||period!==days||version!==dashboardGeneration)return;
      snapshot=result;renderData();await loadUsers();
    }catch(error){if($('adminData')&&allowed()&&version===dashboardGeneration)$('adminData').innerHTML='<div class="error">'+esc(error.message)+'</div>';}
  }
  async function profile(id) {
    const version=++detailGeneration;
    const data=await api('/admin/users/'+encodeURIComponent(id)+'?days='+days);
    if(!allowed()||currentView!=='admin'||version!==detailGeneration)return;
    const u=data.user,b=data.business;
    openDialog(u.name,'<p class="section-note">Platform user profile · last '+days+' days of measured usage</p><div class="pair">'+[['Email',u.email],['Account role',cap(u.role)],['Account status',u.active?'Active':'Disabled'],['Business',b.name],['Plan',cap(u.plan)+' · '+cap(u.subscriptionStatus)],['Registered',u.registeredAt?when(u.registeredAt):'Not recorded before tracking began'],['Last sign in',u.lastLoginAt?when(u.lastLoginAt):'Not measured'],['Last active',u.lastSeenAt?when(u.lastSeenAt):'Not measured'],['Business email',b.email||'—'],['Business phone',b.phone||'—'],['Address',b.address||'—'],['Currency / timezone',b.currency+' · '+b.timezone]].map(([label,value])=>'<div class="admin-profile-field"><span class="small">'+esc(label)+'</span><div>'+esc(value)+'</div></div>').join('')+'</div><h3 class="admin-subtitle">Frequently used services</h3>'+serviceTable(data.services)+(data.services.length?'':'<p class="muted">No measured service usage yet.</p>'));
  }
  return {
    render:shell,
    reload:load,
    mount(){if(!allowed())return;$('adminPeriod').onchange=()=>{days=Number($('adminPeriod').value);userPage=1;snapshot=null;userList=null;generation++;load();};$('adminRefresh').onclick=load;load();},
    clear(){snapshot=null;userList=null;query='';userPage=1;generation++;dashboardGeneration++;detailGeneration++;},
  };
})();
