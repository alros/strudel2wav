// Builds dist/cli.cjs: one self-contained file (no runtime dependencies) that
// embeds the browser renderer bundle. Used by `npm link` and by the SEA executables.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));

const renderer = await build({
  entryPoints: ['src/page/main.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const rendererSource = renderer.outputFiles[0].text;

const inlineRenderer = {
  name: 'inline-renderer',
  setup(b) {
    b.onResolve({ filter: /^virtual:renderer$/ }, () => ({ path: 'renderer', namespace: 'virtual' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: rendererSource, loader: 'text' }));
  },
};

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs', // Node SEA requires CommonJS
  target: 'node22',
  define: { __VERSION__: JSON.stringify(version) },
  plugins: [inlineRenderer],
  logLevel: 'warning',
});
