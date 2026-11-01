import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = (args) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
npm(['--prefix', '../Atlas SDK', 'run', 'protocol:prepare']);
npm(['--prefix', '../Atlas SDK', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
npm(['--prefix', '../Atlas SDK', 'run', 'build']);
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
npm(['pack', '../Atlas SDK', '--ignore-scripts', '--pack-destination', 'artifacts']);
await copyFile(
  new URL('../../Atlas Core/artifacts/atlas-protocol-0.5.0.tgz', import.meta.url),
  new URL('../artifacts/atlas-protocol-0.5.0.tgz', import.meta.url),
);
const bytes = await readFile(new URL('../artifacts/atlas-sdk-0.5.0.tgz', import.meta.url));
await writeFile(
  new URL('../artifacts/sdk-sha256', import.meta.url),
  createHash('sha256').update(bytes).digest('hex') + '\n',
);
