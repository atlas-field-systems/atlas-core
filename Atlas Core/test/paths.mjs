import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const source = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const selected = process.env.ATLAS_TEST_ROOT ?? mkdtempSync(join(tmpdir(), 'atlas-core-'));
if (!isAbsolute(selected)) throw new Error('ATLAS_TEST_ROOT must be absolute');
function outsideSource(path) {
  const location = relative(source, path);
  if (location !== '..' && !location.startsWith('../') && !isAbsolute(location)) throw new Error('ATLAS_TEST_ROOT must be outside the source workspace');
}
outsideSource(resolve(selected));
mkdirSync(selected, { recursive: true, mode: 0o700 });
export const mutableRoot = realpathSync(selected);
outsideSource(mutableRoot);
process.env.ATLAS_TEST_ROOT = mutableRoot;
