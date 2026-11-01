import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { ImageId, Manifest, optionalJson } from './installation.js';
import { docker } from './docker.js';
import { join } from 'node:path';

export const RegistryReference = z
  .string()
  .max(1024)
  .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/);
export const ReleaseMetadata = z.strictObject({
  format: z.literal(1),
  release: z.literal('0.6.0'),
  protocol: z.literal('0.6.0'),
  databaseFormat: z.literal('6'),
  platform: z.literal('linux/amd64'),
  node: z.literal('24.22.1'),
  npm: z.literal('11.19.0'),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  sourceTree: z.string().regex(/^[0-9a-f]{40}$/),
  sourceDirty: z.boolean(),
  image: ImageId,
  imageReference: RegistryReference.nullable(),
  npmName: z.string().min(1).max(214).nullable(),
  packagePrivate: z.boolean(),
});
export type ReleaseMetadata = z.infer<typeof ReleaseMetadata>;
export async function releaseMetadata() {
  return optionalJson(
    fileURLToPath(new URL('./operator-release.json', import.meta.url)),
    ReleaseMetadata,
  );
}
export async function checkCompatibility(
  root: string,
  release: ReleaseMetadata | undefined,
  image: string | undefined,
  kind: string,
): Promise<void> {
  if (image && release && image !== release.image) throw new Error('incompatible_image');
  if (kind === 'doctor') return;
  const installed = await optionalJson(join(root, 'setup', 'installation.json'), Manifest);
  if (
    installed &&
    release &&
    installed.image !== release.image &&
    ![
      'inspect',
      'doctor',
      'settings-show',
      'enrollment-inspect',
      'tls-show',
      'stop',
      'recover',
      'update',
    ].includes(kind)
  )
    throw new Error('incompatible_image');
}
export async function verifyImage(
  image: string,
  release: ReleaseMetadata | undefined,
  acquire: boolean,
): Promise<void> {
  ImageId.parse(image);
  let raw: string;
  try {
    raw = await docker(['image', 'inspect', image]);
  } catch {
    if (!acquire || !release?.imageReference) throw new Error('image_unavailable');
    await docker(['pull', '--quiet', '--platform', release.platform, release.imageReference]);
    raw = await docker(['image', 'inspect', image]);
  }
  validateImageInspection(raw, image, release);
}
export function validateImageInspection(
  raw: string,
  image: string,
  release: ReleaseMetadata | undefined,
): void {
  const inspected = z
    .array(
      z.object({
        Id: ImageId,
        Os: z.string(),
        Architecture: z.string(),
        Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
      }),
    )
    .length(1)
    .parse(JSON.parse(raw))[0];
  if (
    !inspected ||
    inspected.Id !== image ||
    `${inspected.Os}/${inspected.Architecture}` !== (release?.platform ?? 'linux/amd64') ||
    (release &&
      inspected.Config.Labels?.['org.opencontainers.image.revision'] !== release.sourceRevision)
  )
    throw new Error('incompatible_image');
}
