import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const destination = join(root, 'artifacts', 'browser');
await mkdir(destination, { recursive: true });
const bundle = await build({
  entryPoints: [process.argv[3] ?? join(root, 'scripts', 'browser-entry.mjs')],
  outfile: join(destination, 'bundle.js'),
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  bundle: true,
  metafile: true,
});
if (
  Object.keys(bundle.metafile.inputs).some(
    (path) => path.includes('zod-openapi') || path.endsWith('/reference.js'),
  )
)
  throw new Error('Build-only reference entered the browser bundle');
await writeFile(join(destination, 'metafile.json'), JSON.stringify(bundle.metafile, null, 2));
const html =
  '<!doctype html><meta charset="utf-8"><title>Atlas qualification</title><pre>Running qualification</pre><script type="module" src="/bundle.js"></script>';
await writeFile(join(destination, 'index.html'), html);
const files = new Map([
  ['/', join(destination, 'index.html')],
  ['/bundle.js', join(destination, 'bundle.js')],
  ['/fixtures.json', join(root, 'test', 'fixtures', 'acceptance.json')],
  ['/independent-cases.json', join(root, 'test', 'fixtures', 'independent-cases.json')],
]);
const port = Number(process.argv[2] ?? 4318);
const server = createServer(async (request, response) => {
  const path = files.get(request.url);
  if (!path) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(path);
    response.setHeader(
      'Content-Type',
      request.url === '/bundle.js'
        ? 'text/javascript'
        : request.url.endsWith('.json')
          ? 'application/json'
          : 'text/html',
    );
    response.end(content);
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(port, '0.0.0.0', () =>
  console.log(`Atlas browser qualification http://localhost:${port}`),
);
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
