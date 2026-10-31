import { build } from '../operator/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [join(root, 'operator/tui.tsx')],
  outfile: join(root, 'dist/tui.js'),
  bundle: true,
  jsx: 'automatic',
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'esm',
  target: 'node24',
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    'process.env.DEV': 'false',
    'process.env.NODE_ENV': '"production"',
  },
  nodePaths: [join(root, 'operator/node_modules')],
  plugins: [
    {
      name: 'core-modules',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/src\// }, ({ path }) => ({
          path: './' + path.split('/').at(-1),
          external: true,
        }));
      },
    },
  ],
  banner: {
    js: "import { createRequire as operatorCreateRequire } from 'node:module'; const require = operatorCreateRequire(import.meta.url);",
  },
});
