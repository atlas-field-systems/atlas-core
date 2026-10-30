import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../../Atlas Core/artifacts/atlas-protocol-0.3.0.tgz', import.meta.url),
  new URL('../artifacts/atlas-protocol-0.3.0.tgz', import.meta.url),
);
