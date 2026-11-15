import type Database from 'better-sqlite3';
import { CACHE_VERSION, schema } from './schema.js';

// Structural validation of cache.db, done with SQLite's own introspection (sqlite_master, table_list, table_xinfo, index_list,
// index_info, foreign_key_list) and not by column names alone. cache.db can be shipped by a repository, so a database is only
// trusted for cache operations when its objects are exactly the ones schema.ts creates: ordinary tables of the expected shape,
// the one index the primary key implies, and nothing else (no virtual tables, views, triggers, extra indexes, statistics tables,
// generated or hidden columns, foreign keys, CHECK / DEFAULT / COLLATE clauses, WITHOUT ROWID or STRICT tables).
//
// Versions. CACHE_VERSION is the current layout. 5 is the oldest layout this code migrates (CHANGELOG: cache versions 5 and 6; 7 added
// the `usage_archive` table, which a migration simply creates): the `files` table of an older version is dropped and rebuilt, and its
// `usage` statistics are kept after they pass the same checks. Version 0 is a database
// that has never been written (it must hold no objects at all). Any other version (older ones nothing here can vouch for, and
// versions from a newer release) is not trusted and is replaced like a corrupted file.
export const OLDEST_MIGRATABLE_VERSION = 5;

type Db = Database.Database;
export type SchemaState = 'fresh' | 'current' | 'migrate';

type Column = { name: string; type: string; notnull: 0 | 1; pk: 0 | 1 };
type TableSpec = { columns: Column[]; autoIndex: string | null; autoIncrement: boolean };

const col = (name: string, type: string, notnull: 0 | 1, pk: 0 | 1 = 0): Column => ({ name, type, notnull, pk });
const TABLES: Record<'files' | 'usage' | 'usage_archive', TableSpec> = {
  files: {
    columns: [col('path', 'TEXT', 0, 1), col('hash', 'TEXT', 1), col('size', 'INTEGER', 1), col('mtime_ms', 'INTEGER', 1), col('info', 'TEXT', 1)],
    autoIndex: 'path',
    autoIncrement: false,
  },
  usage: {
    columns: [col('id', 'INTEGER', 0, 1), col('at', 'INTEGER', 1), col('tool', 'TEXT', 1), col('raw_tokens', 'INTEGER', 1), col('sent_tokens', 'INTEGER', 1)],
    autoIndex: null,
    autoIncrement: true,
  },
  // One row (id 1): the totals of usage rows that were trimmed away. An INTEGER PRIMARY KEY is the rowid itself, so it has no index.
  usage_archive: {
    columns: [col('id', 'INTEGER', 0, 1), col('calls', 'INTEGER', 1), col('raw_tokens', 'INTEGER', 1), col('sent_tokens', 'INTEGER', 1)],
    autoIndex: null,
    autoIncrement: false,
  },
};
type TableName = keyof typeof TABLES;

// SQLite keeps the CREATE statement as it was written (minus IF NOT EXISTS), so a whitespace- and case-insensitive comparison with
// the statements of schema.ts catches every clause the pragmas cannot show (CHECK, DEFAULT, COLLATE, ON CONFLICT, GENERATED ...).
const squash = (sql: string): string => sql.replace(/\s+/g, '').replace(/ifnotexists/gi, '').toLowerCase();
const EXPECTED_SQL = new Map<string, string>(
  schema
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((statement) => [/^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(statement)![1].toLowerCase(), squash(statement)]),
);

// At most this many entries in sqlite_master are read: a real cache has five. More is refused without reading further.
const MAX_OBJECTS = 16;

type Master = { type: string; name: string; tbl_name: string; sql: string | null };

function tableProblem(db: Db, name: TableName, master: Master): string | null {
  const spec = TABLES[name];
  const what = `the ${name} table`;
  if (master.type !== 'table' || master.tbl_name !== name || typeof master.sql !== 'string') return `${what} is not an ordinary table`;
  if (/^\s*CREATE\s+VIRTUAL/i.test(master.sql)) return `${what} is a virtual table`;
  if (squash(master.sql) !== EXPECTED_SQL.get(name)) return `${what} was declared differently from the supported schema`;

  const listed = (db.prepare('PRAGMA main.table_list').all() as { name: string; type: string; wr: number; strict: number }[]).find((t) => t.name === name);
  if (!listed || listed.type !== 'table' || listed.wr !== 0 || listed.strict !== 0) return `${what} is not a plain rowid table`;

  const found = db.prepare(`PRAGMA main.table_xinfo(${name})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number; hidden: number }[];
  if (found.length !== spec.columns.length) return `${what} has ${found.length} columns, expected ${spec.columns.length}`;
  for (const [i, want] of spec.columns.entries()) {
    const got = found[i];
    if (got.name !== want.name) return `${what} has column ${got.name} where ${want.name} is expected`;
    if (got.type.toUpperCase() !== want.type) return `${what}: column ${want.name} has type ${got.type || '(none)'}, expected ${want.type}`;
    if (got.notnull !== want.notnull) return `${what}: column ${want.name} has the wrong nullability`;
    if (got.pk !== want.pk) return `${what}: column ${want.name} has the wrong primary key membership`;
    if (got.dflt_value !== null) return `${what}: column ${want.name} has a default value`;
    if (got.hidden !== 0) return `${what}: column ${want.name} is hidden or generated`;
  }

  const indexes = db.prepare(`PRAGMA main.index_list(${name})`).all() as { name: string; unique: number; origin: string; partial: number }[];
  if (spec.autoIndex === null) {
    if (indexes.length > 0) return `${what} has an index`;
  } else {
    if (indexes.length !== 1) return `${what} has ${indexes.length} indexes, expected only its primary key`;
    const [index] = indexes;
    if (index.origin !== 'pk' || index.unique !== 1 || index.partial !== 0) return `${what} has an index that is not its plain primary key`;
    const columns = (db.prepare(`PRAGMA main.index_info(${JSON.stringify(index.name)})`).all() as { name: string }[]).map((c) => c.name);
    if (columns.join(',') !== spec.autoIndex) return `${what}: the primary key covers ${columns.join(',')}`;
  }
  if ((db.prepare(`PRAGMA main.foreign_key_list(${name})`).all() as unknown[]).length > 0) return `${what} has a foreign key`;
  return null;
}

// Counts of rows in sqlite_sequence are bounded by the number of AUTOINCREMENT tables; anything else in it is not ours.
function sequenceProblem(db: Db, master: Master): string | null {
  if (master.type !== 'table' || master.sql === null || squash(master.sql) !== 'createtablesqlite_sequence(name,seq)') return 'sqlite_sequence is not the table SQLite creates';
  const rows = db.prepare('SELECT name FROM sqlite_sequence LIMIT 3').all() as { name: unknown }[];
  return rows.length > 1 || rows.some((r) => r.name !== 'usage') ? 'sqlite_sequence holds entries that are not ours' : null;
}

// null when the database matches what `version` promises, otherwise the first difference. Read-only: it runs before anything is
// created, dropped or migrated, so nothing is ever executed against a structure that has not been looked at. `state` says what
// the caller has to do next.
export function inspectSchema(db: Db, version: number): { state: SchemaState; problem: null } | { state: null; problem: string } {
  const refuse = (problem: string) => ({ state: null, problem }) as const;
  const objects = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master LIMIT ?').all(MAX_OBJECTS + 1) as Master[];
  if (objects.length > MAX_OBJECTS) return refuse('it holds more schema objects than a cache ever does');

  if (version === 0) return objects.length === 0 ? { state: 'fresh', problem: null } : refuse('it has content but no schema version');
  if (!Number.isInteger(version) || version < OLDEST_MIGRATABLE_VERSION || version > CACHE_VERSION) return refuse(`schema version ${version} is not supported (supported: ${OLDEST_MIGRATABLE_VERSION} to ${CACHE_VERSION})`);
  const current = version === CACHE_VERSION;

  // First pass, names and kinds only, before any pragma is run: a pragma that lists tables resolves every one of them, and a
  // virtual table of a module this process does not have would make it fail. Only the expected names, of the expected kind, are
  // let through: indexes other than the primary key's automatic one, views, triggers, virtual tables and tables of any other name
  // (sqlite_stat1, shadow tables, ...) are refused here.
  const seen = new Set<string>();
  for (const object of objects) {
    if (seen.has(object.name)) return refuse(`${object.name} appears twice`);
    seen.add(object.name);
    const named = object.name === 'files' || object.name === 'usage' || object.name === 'usage_archive';
    if (named && (object.type !== 'table' || typeof object.sql !== 'string')) return refuse(`the ${object.name} table is not an ordinary table`);
    if (named && /^\s*CREATE\s+VIRTUAL/i.test(object.sql!)) return refuse(`the ${object.name} table is a virtual table`);
    const sequence = object.name === 'sqlite_sequence' && object.type === 'table';
    const autoIndex = object.type === 'index' && object.sql === null && object.tbl_name === 'files' && /^sqlite_autoindex_files_\d+$/.test(object.name);
    if (!named && !sequence && !autoIndex) return refuse(`it contains an unexpected ${object.type} (${object.name.slice(0, 60)})`);
  }

  // Second pass, the details. The `files` table of an older version is dropped, not read: being an ordinary table is enough.
  for (const object of objects) {
    if (object.name === 'usage' || object.name === 'usage_archive' || (object.name === 'files' && current)) {
      const problem = tableProblem(db, object.name, object);
      if (problem) return refuse(problem);
    } else if (object.name === 'sqlite_sequence') {
      const problem = sequenceProblem(db, object);
      if (problem) return refuse(problem);
    }
  }
  return { state: current ? 'current' : 'migrate', problem: null };
}

// After the schema was created or migrated, the whole structure is checked once more against the current version.
export function currentSchemaProblem(db: Db): string | null {
  return inspectSchema(db, CACHE_VERSION).problem;
}
