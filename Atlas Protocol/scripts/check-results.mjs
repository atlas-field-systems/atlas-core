import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const [kind, file] = process.argv.slice(2);
const raw = readFileSync(file, 'utf8');
if (kind === 'go') {
 const events = raw.trim().split('\n').map(line => JSON.parse(line));
 assert(!events.some(event => event.Action === 'skip'), 'Go skipped coverage');
 assert(events.some(event => event.Action === 'pass' && !event.Test), 'Go did not finish');
} else {
 for (const field of ['skipped', 'cancelled', 'todo', 'fail']) assert(new RegExp(`^# ${field} 0$`, 'm').test(raw), `TypeScript ${field} or missing test summary`);
}
