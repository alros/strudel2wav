// Packs dist/cli.cjs into a standalone executable with Node's Single Executable
// Applications (SEA) feature: https://nodejs.org/api/single-executable-applications.html
//
// Builds for the current platform/arch only (run it on each OS, as the release
// workflow does). Output: release/strudel2wav-<os>-<arch>[.exe]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform;
const ext = process.platform === 'win32' ? '.exe' : '';
const outDir = 'release';
const exe = join(outDir, `strudel2wav-${os}-${process.arch}${ext}`);
const blob = join(outDir, 'sea-prep.blob');
const config = join(outDir, 'sea-config.json');

const run = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  // .cmd shims need a shell on Windows; everything else must not use one (paths with spaces)
  execFileSync(cmd, args, { stdio: 'inherit', shell: cmd.endsWith('.cmd') });
};

mkdirSync(outDir, { recursive: true });
writeFileSync(
  config,
  JSON.stringify({ main: 'dist/cli.cjs', output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }),
);

run(process.execPath, ['--experimental-sea-config', config]);
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);

if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);
if (process.platform === 'win32') {
  // the official node.exe is signed; the signature is invalid after injection, remove it if signtool exists
  try {
    run('signtool', ['remove', '/s', exe]);
  } catch {
    console.log('(signtool not available; leaving the stale signature in place)');
  }
}

const postject = join('node_modules', '.bin', `postject${process.platform === 'win32' ? '.cmd' : ''}`);
run(postject, [
  exe,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);

// macOS requires a valid signature to run on Apple silicon; ad-hoc is enough.
if (process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);

rmSync(blob);
rmSync(config);
console.log(`\nbuilt ${exe}`);
