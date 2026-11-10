// Local-only initial provisioning; never exposed as an HTTP endpoint.
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const id=String(process.env.BATTO_SUITE_OWNER_ID || '').trim();
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('BATTO_SUITE_OWNER_ID muss die bestätigte eigene Konto-UUID enthalten.');
const database=path.resolve(process.env.DATA_DIR || './data','account.sqlite');
if(!fs.existsSync(database))throw Error('Zuerst den Server starten, das eigene Konto registrieren und E-Mail bestätigen.');
const db=new DatabaseSync(database);
try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  const account=db.prepare('SELECT id,confirmed,suspended FROM accounts WHERE id=?').get(id);
  if(!account?.confirmed||account.suspended)throw Error('Nur ein vorhandenes, bestätigtes und nicht gesperrtes Konto kann Betreiber werden.');
  const other=db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE is_admin=1 AND id<>?').get(id);
  if(other.n)throw Error('Diese Erstfreigabe ist nur für eine Installation ohne anderes Admin-Konto vorgesehen.');
  db.prepare('UPDATE accounts SET is_admin=1 WHERE id=?').run(id);
  db.exec('COMMIT;');
  console.log('Das bestätigte Betreiberkonto wurde lokal freigegeben. Den Dienst jetzt neu starten.');
} catch(error) { try {db.exec('ROLLBACK;');}catch{} throw error; }
finally {db.close();}
