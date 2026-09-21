import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations';

/**
 * Opens (and migrates) the local database.
 *
 * Uses the SQLite bundled in Node/Electron (`node:sqlite`) instead of `better-sqlite3`, so there
 * is no native build step. It is still flagged experimental upstream; FTS5 support was verified
 * on Node 24 and in Electron 44 (see docs/architecture.md).
 */
export function openDatabase(path: string = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    backupBeforeMigrating(db, path);
  }
  migrate(db);
  return db;
}

/**
 * When a newer version of the app is about to change the schema of an existing database, keep a copy of it first
 * (`<file>.backup-v<old version>`, next to it, made once per version). A new database (version 0) or one that is
 * already current needs none. If the copy cannot be made the app does not migrate: better not to start than to risk
 * the user's data.
 */
export function backupBeforeMigrating(db: DatabaseSync, path: string): string | null {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (current === 0 || current >= migrations.length) return null;
  const backup = `${path}.backup-v${current}`;
  if (existsSync(backup)) return backup;
  // VACUUM INTO writes a consistent, complete copy (including what is still in the WAL file).
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  return backup;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this app supports (${migrations.length}).`,
    );
  }
  for (let v = current; v < migrations.length; v++) {
    const sql = migrations[v] as string;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
