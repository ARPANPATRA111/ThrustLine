// Carry player progress from one SpacetimeDB server to another.
//
// A new server cannot read the old server's login tokens, so every player arrives there with a new
// identity. Progress is matched up by a private transfer key instead: each browser registers one
// (see `registerTransfer` in the module), `export` pairs it with that player's profile, `import`
// puts those rows in `legacy_profile`, and the browser claims its own row on its first visit.
//
//   node scripts/move-data.mjs export <server> <database> [file]
//   node scripts/move-data.mjs import <server> <database> [file]
//
// <server> is `maincloud`, `local` or a URL. You must be logged in as the database's owner, because
// the keys are in a private table. The file holds those keys, so never commit or share it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FIELDS = ['name', 'xp', 'kills', 'deaths', 'wins', 'rounds', 'best_kills', 'season', 'season_score'];
const BATCH = 100;

function sql(server, db, query) {
  const out = execFileSync('spacetime', ['sql', db, '--server', server, '--format', 'json', '--yes', query], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('[')));
}

/** The CLI's JSON is one result per statement: a schema, then rows as positional arrays. */
function rowsOf(results) {
  const { schema, rows } = results[0];
  const names = schema.elements.map((e) => e.name.some ?? e.name);
  return rows.map((row) => Object.fromEntries(row.map((value, i) => [names[i], value])));
}

const identityOf = (v) => (Array.isArray(v) ? v[0] : v);

function exportData(server, db, file) {
  const profiles = rowsOf(sql(server, db, 'SELECT * FROM profile'));
  const keys = rowsOf(sql(server, db, 'SELECT * FROM transfer_key'));
  const byIdentity = new Map(keys.map((k) => [identityOf(k.identity), k.key]));
  const rows = [];
  for (const p of profiles) {
    const key = byIdentity.get(identityOf(p.identity));
    if (key) rows.push({ key, ...Object.fromEntries(FIELDS.map((f) => [f, p[f]])) });
  }
  writeFileSync(file, JSON.stringify({ from: server, database: db, exportedAt: new Date().toISOString(), rows }, null, 1));
  console.log(`${profiles.length} profiles, ${rows.length} with a transfer key, written to ${file}.`);
  if (rows.length < profiles.length) {
    console.log(`${profiles.length - rows.length} players have not visited since transfer keys shipped, so they will start fresh.`);
  }
}

const quote = (v) => (typeof v === 'string' ? `'${v.replaceAll("'", "''")}'` : String(v));

function importData(server, db, file) {
  const { rows } = JSON.parse(readFileSync(file, 'utf8'));
  const taken = new Set(rowsOf(sql(server, db, 'SELECT * FROM legacy_profile')).map((r) => r.key));
  const fresh = rows.filter((r) => !taken.has(r.key));
  const columns = ['key', ...FIELDS].join(', ');
  for (let i = 0; i < fresh.length; i += BATCH) {
    const values = fresh.slice(i, i + BATCH).map((r) => `(${[r.key, ...FIELDS.map((f) => r[f])].map(quote).join(', ')})`).join(', ');
    sql(server, db, `INSERT INTO legacy_profile (${columns}) VALUES ${values}`);
  }
  console.log(`${fresh.length} profiles waiting to be claimed on ${server}/${db}${taken.size ? ` (${taken.size} were already there)` : ''}.`);
}

const [command, server, db, file = 'profiles-export.json'] = process.argv.slice(2);
if (!server || !db || !['export', 'import'].includes(command)) {
  console.error('Usage: node scripts/move-data.mjs <export|import> <server> <database> [file]');
  process.exit(1);
}
if (command === 'export') exportData(server, db, file);
else importData(server, db, file);
