'use strict';
// Restore a verified SQLite snapshot into a NEW directory. Never overwrites live data.
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const [source,destination]=process.argv.slice(2);
if(!source||!destination){console.error('Usage: node scripts/recover.cjs /path/to/daily-backup.sqlite /path/to/new-data-directory');process.exit(1);}
const input=path.resolve(source),dir=path.resolve(destination),target=path.join(dir,'profitpulse.sqlite');
if(fs.existsSync(target))throw Error('Destination already contains a database. Choose a new directory; no data has been replaced.');
const original=new DatabaseSync(input,{readOnly:true});
try{if(original.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup failed its integrity check.');if(![2,3].includes(original.prepare('PRAGMA user_version').get().user_version))throw Error('Unsupported database schema.');}
finally{original.close();}
fs.mkdirSync(dir,{recursive:true,mode:0o700});
fs.copyFileSync(input,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);
const restored=new DatabaseSync(target);
try{restored.exec('DELETE FROM sessions;');}finally{restored.close();}
console.log('Recovery verified. Original files were preserved. Stop the application, set DATA_DIR to '+dir+', then restart and sign in.');
