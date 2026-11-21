import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    banner: { js: '' },
  }),
  build({
    entryPoints: ['src/page/main.ts'],
    outfile: 'dist/renderer.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  }),
]);
