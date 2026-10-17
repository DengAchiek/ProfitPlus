'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const { AppError, publicUser, passwordHash } = require('./store');
const digest = value => createHash('sha256').update(value).digest('hex');

// A deployment-controlled, expiring invitation can create one reserved admin
// account. Recovering an existing login requires an explicit deployment setting
// and a fresh invitation. Only digests are configured.
class AdminSetup {
  constructor(store, analytics, config = {}, now = Date.now) {
    this.store=store;this.analytics=analytics;this.config=config;this.now=now;
  }
  available() {
    const {tokenHash,emailHash,expiresAt}=this.config;
    return ['create','recover'].includes(this.config.mode||'create') && /^[a-f0-9]{64}$/.test(tokenHash||'') && /^[a-f0-9]{64}$/.test(emailHash||'') && Date.parse(expiresAt)>this.now() &&
      !this.store.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('admin_setup_used:'+tokenHash);
  }
  recoveryEnabled() { return this.config.mode==='recover'; }
  consume() { this.store.db.prepare('INSERT INTO platform_meta VALUES (?,?)').run('admin_setup_used:'+this.config.tokenHash,new Date(this.now()).toISOString()); }
  claim(input) {
    const invalid=()=>{throw new AppError(403,'This setup link is invalid, expired or already used.');};
    if(!this.available() || !input || typeof input!=='object' || typeof input.setupCode!=='string' || !/^[a-f0-9]{64}$/.test(input.setupCode))invalid();
    const supplied=Buffer.from(digest(input.setupCode),'hex'),expected=Buffer.from(this.config.tokenHash,'hex');
    if(!timingSafeEqual(supplied,expected))invalid();
    const address=typeof input.email==='string'?input.email.trim().toLowerCase():'';
    if(digest(address)!==this.config.emailHash || !this.analytics.allowedEmail(address))invalid();
    const existing=this.store.db.prepare('SELECT * FROM users WHERE email=?').get(address);
    if(existing){
      if(!this.recoveryEnabled())throw new AppError(409,'This account already exists. Ask the platform operator for a private recovery invitation to set a new BizAtrio password.');
      if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100)throw new AppError(422,'Enter a valid name.');
      const encoded=passwordHash(input.password);
      const user=this.store.transaction(()=>{
        if(!this.available())invalid();
        this.store.db.prepare('UPDATE users SET name=?,password=?,active=1 WHERE id=?').run(input.name.trim(),encoded,existing.id);
        this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
        this.consume();
        const updated=this.store.db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
        this.analytics.login(updated);
        this.store.audit(updated,'recovered administrator access','account',existing.id,publicUser(existing),publicUser(updated));
        return updated;
      });
      return user;
    }
    const user=this.store.createBusiness({name:input.name,email:address,password:input.password,businessName:input.businessName||'BizAtrio Administration',currency:'KES',locale:'en-KE',timezone:'Africa/Nairobi',plan:'starter'});
    // Account uniqueness also prevents reuse if a process stops between creation
    // and the marker. No account deletion or email-change route exists.
    this.consume();
    this.analytics.registered(user);this.analytics.login(user);
    return user;
  }
}
module.exports={AdminSetup};
