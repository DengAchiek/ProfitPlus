import storeModule from '../lib/store.js';

const { Store, AppError } = storeModule;

// Keep the business rules shared with Node; adapt only synchronous persistence.
class DurableDatabase {
  constructor(storage) { this.storage = storage; }
  exec(query) { this.storage.sql.exec(query).toArray(); }
  prepare(query) {
    const rows = (...bindings) => this.storage.sql.exec(query, ...bindings).toArray();
    return {
      all: rows,
      get: (...bindings) => rows(...bindings)[0],
      run: (...bindings) => { rows(...bindings); },
    };
  }
  transaction(callback) { return this.storage.transactionSync(callback); }
  close() {}
}

export class CloudflareStore extends Store {
  constructor(storage) {
    const database = new DurableDatabase(storage);
    database.exec('CREATE TABLE IF NOT EXISTS app_schema(version INTEGER NOT NULL);');
    const version = database.prepare('SELECT version FROM app_schema').get()?.version || 0;
    if (![0, 3].includes(version)) throw Error('Unsupported Cloudflare database version.');
    super(null, { database, schemaVersion: version });
    if (!version) database.prepare('INSERT INTO app_schema VALUES (3)').run();
    database.exec(`
      CREATE TABLE IF NOT EXISTS safety_backups(name TEXT PRIMARY KEY, business_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS safety_backup_chunks(name TEXT NOT NULL REFERENCES safety_backups(name), position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(name,position));
      CREATE TABLE IF NOT EXISTS login_attempts(address TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
    `);
    this.backupStatus = { mode: 'cloudflare', maxImportMB: 8, lastSuccess: null, error: null };
  }
  saveSafetyBackup(user, name, data) {
    this.db.prepare('INSERT INTO safety_backups VALUES (?,?,?)').run(name, user.business_id, '');
    const text = JSON.stringify(data);
    // Keep every row comfortably below the Durable Objects string-size limit.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 128000, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end--;
      this.db.prepare('INSERT INTO safety_backup_chunks VALUES (?,?,?)').run(name, offset, text.slice(offset, end));
      offset = end;
    }
  }
  listSafetyBackups(user) {
    this.owner(user);
    return this.db.prepare('SELECT name FROM safety_backups WHERE business_id=? ORDER BY name DESC LIMIT 20').all(user.business_id).map(row => row.name);
  }
  readSafetyBackup(user, name) {
    this.owner(user);
    const row = this.db.prepare('SELECT data FROM safety_backups WHERE business_id=? AND name=?').get(user.business_id, name);
    if (!row) throw new AppError(404, 'Backup not found.');
    return JSON.parse(row.data || this.db.prepare('SELECT data FROM safety_backup_chunks WHERE name=? ORDER BY position').all(name).map(chunk => chunk.data).join(''));
  }
}

// Rate limits survive object eviction and deployment, like sessions and records.
export function loginAttempts(database) {
  return {
    get: address => database.prepare('SELECT count,reset FROM login_attempts WHERE address=?').get(address),
    set(address, attempt) {
      database.prepare('DELETE FROM login_attempts WHERE reset<=?').run(Date.now());
      database.prepare('INSERT INTO login_attempts VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET count=excluded.count,reset=excluded.reset').run(address, attempt.count, attempt.reset);
    },
    delete: address => database.prepare('DELETE FROM login_attempts WHERE address=?').run(address),
  };
}
