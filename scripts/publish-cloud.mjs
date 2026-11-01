// Publish the module to Maincloud under the database name in client/.env.production.
// Usage: npm run publish:cloud            (add -- --delete-data to wipe an incompatible schema)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const env = readFileSync(new URL('../client/.env.production', import.meta.url), 'utf8');
const db = /VITE_STDB_DB=(.+)/.exec(env)?.[1].trim();
if (!db) throw new Error('VITE_STDB_DB missing from client/.env.production');
const extra = process.argv.slice(2).join(' ');
const cmd = `spacetime publish ${db} --server maincloud --module-path server --yes ${extra}`;
console.log(`> ${cmd}`);
execSync(cmd, { stdio: 'inherit' });
