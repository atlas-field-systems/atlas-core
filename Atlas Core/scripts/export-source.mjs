import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Source export requires a clean committed checkout');
execFileSync('git', ['archive', '--format=tar', '--prefix=atlas/', '--output', join(root, 'artifacts', 'source.tar'), 'HEAD'], { cwd: repository, stdio: 'inherit' });
console.log('Exported the complete committed source to artifacts/source.tar');
