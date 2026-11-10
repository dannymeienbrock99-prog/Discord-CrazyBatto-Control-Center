import {after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';

// Older feature fixtures deliberately expose their settings Map to assertions.
// Preserve that interface while running new relational notice/receipt storage
// against real SQLite, including commit/rollback and deterministic cleanup.
const databases=new Set();
after(()=>{for(const db of databases)db.close();databases.clear();});
export function withCommunitySqlite(store){
  if(store.db)throw Error('Fixture adapter requires an existing non-SQLite test store.');
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');databases.add(db);
  const originalTransaction=store.transaction.bind(store);
  Object.assign(store,{db,get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),run:(sql,...args)=>db.prepare(sql).run(...args),transaction(fn){
    return originalTransaction(()=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}});
  }});
  return store;
}
