import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exportReference } from '../dist/reference.js';
const destination =
  process.argv[2] ?? fileURLToPath(new URL('../artifacts/openapi.json', import.meta.url));
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(destination, exportReference());
console.log(destination);
