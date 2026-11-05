// Publish the module to the production server named in client/.env.production.
// VITE_STDB_URI decides where: https://maincloud.spacetimedb.com (SpacetimeDB's cloud, Virginia)
// or https://<your-host> (your own SpacetimeDB server, see deploy/README.md).
// Usage: npm run publish:cloud
// Never pass --delete-data here: it would erase every player's level and the season board.
// Migrate instead: new tables, or new columns with .default().
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const env = readFileSync(new URL('../client/.env.production', import.meta.url), 'utf8');
const db = /VITE_STDB_DB=(.+)/.exec(env)?.[1].trim();
const uri = /VITE_STDB_URI=(.+)/.exec(env)?.[1].trim();
if (!db || !uri) throw new Error('VITE_STDB_DB and VITE_STDB_URI must be set in client/.env.production');
const server = uri.includes('maincloud.spacetimedb.com') ? 'maincloud' : uri;
const extra = process.argv.slice(2).join(' ');
const cmd = `spacetime publish ${db} --server ${server} --module-path server --yes ${extra}`;
console.log(`> ${cmd}`);
execSync(cmd, { stdio: 'inherit' });
