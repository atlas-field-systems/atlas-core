import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test(
  'public Full types preserve each resource image, frozen pages, prepared writes and HTTP mode distinctions',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'picture-types-'));
    const consumer = process.env.ATLAS_SDK_ENTRY
      ? dirname(fileURLToPath(process.env.ATLAS_SDK_ENTRY))
      : undefined;
    const sdkRoot = consumer
      ? join(consumer, 'node_modules/@atlas/sdk')
      : fileURLToPath(new URL('../', import.meta.url));
    const protocolRoot = join(consumer ?? sdkRoot, 'node_modules/@atlas/protocol');
    await mkdir(join(root, 'node_modules/@atlas'), { recursive: true });
    await symlink(sdkRoot, join(root, 'node_modules/@atlas/sdk'));
    await symlink(protocolRoot, join(root, 'node_modules/@atlas/protocol'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          types: [],
          lib: ['ES2022', 'DOM'],
        },
        files: ['consumer.ts'],
      }),
    );
    const common = `import { createClient, type FullClient, type HttpClient, type PictureRead, type FrozenQuery, type Prepared } from '@atlas/sdk';
import { NewId, type Asset, type Track, type Geofeature, type Task, type ObjectImage, type RequestOf, type ResponseOf } from '@atlas/protocol';
const id = NewId.parse('11111111-1111-4111-8111-111111111111');
const full: FullClient = createClient({ baseUrl: 'https://localhost', credentials: () => '', mode: 'full', picture: { images: 100 } });
const http: HttpClient = createClient({ baseUrl: 'https://localhost', credentials: () => '' });
const asset: PictureRead<Asset | null> = full.assets.get({ asset_id: id });
const track: PictureRead<Track | null> = full.tracks.get({ track_id: id });
const feature: PictureRead<Geofeature | null> = full.geofeatures.get({ geofeature_id: id });
const task: PictureRead<Task | null> = full.tasks.get({ task_id: id });
const object: PictureRead<ObjectImage | null> = full.objects.get({ object_id: id });
const query = full.tasks.query({ filters: { states: ['cancellation_requested'] } });
if (query.kind === 'available') { const typed: FrozenQuery<Task> = query.value; const page = typed.page(); if (page.kind === 'available') { const images: readonly Task[] = page.value.items; void images; } }
const operation: Prepared<RequestOf<'CreateTask'>, ResponseOf<'CreateTask'>> = full.tasks.create({ request_id: id, task_id: id, asset_id: id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } });
const remote: Promise<unknown> = full.http.assets.get({ asset_id: id });
const observation: Promise<unknown> = full.observations.get({ observation_id: id });
void [asset, track, feature, task, object, operation, remote, observation, http];
`;
    const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
    const compile = () =>
      spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')], {
        encoding: 'utf8',
      });
    await writeFile(join(root, 'consumer.ts'), common);
    const positive = compile();
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    const invalid = [
      'full.tasks.get({ asset_id: id });',
      'full.assets.query({ page_token: "foreign" });',
      'full.tasks.query({ filters: { states: ["unrecognized"] } });',
      'const wrong: PictureRead<Asset | null> = full.tasks.get({ task_id: id });',
      'full.tasks.byAlias({ alias: "missing" });',
      'http.picture.subscribe();',
      'createClient({ baseUrl: "https://localhost", credentials: () => "", mode: "partial" });',
    ];
    const files = [];
    for (const [index, line] of invalid.entries()) {
      const name = `negative-${index}.ts`;
      files.push(name);
      await writeFile(join(root, name), common + line);
    }
    const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ ...config, files }));
    const negative = compile();
    assert.notEqual(negative.status, 0);
    for (const name of files)
      assert.ok(
        negative.stdout.includes(`${name}(`),
        `Missing independent diagnostic for ${name}: ${negative.stdout}`,
      );
    assert.ok(!negative.stdout.includes('TS2307'), negative.stdout);
    await rm(root, { recursive: true, force: true });
  },
);
