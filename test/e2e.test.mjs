// End-to-end tests. They need a Chromium-based browser but no internet:
// remote samples are simulated with a local HTTP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '../src/wav.ts';

import { fileURLToPath } from 'node:url';

// Set STRUDEL2WAV_EXE to test a built standalone executable instead of dist/cli.cjs.
const EXE = process.env.STRUDEL2WAV_EXE ? join(process.cwd(), process.env.STRUDEL2WAV_EXE) : undefined;
const CLI = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url));
let dir, server, base, requests;

function run(args, stdin = '') {
  return new Promise((resolve) => {
    const child = execFile(EXE ?? process.execPath, EXE ? args : [CLI, ...args], { cwd: dir }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
    child.stdin.end(stdin);
  });
}

function readWav(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const dataSize = buf.readUInt32LE(40);
  const frames = dataSize / channels / (bits / 8);
  const rms = (fromSec, toSec) => {
    let sum = 0, n = 0;
    for (let f = Math.floor(fromSec * sampleRate); f < Math.min(frames, toSec * sampleRate); f++) {
      const v = buf.readInt16LE(44 + f * channels * 2) / 32768;
      sum += v * v;
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  };
  return { channels, sampleRate, bits, frames, seconds: frames / sampleRate, rms };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'strudel2wav-test-'));
  // a 0.5 s 440 Hz tone as a "remote" sample
  const sr = 44100;
  const tone = new Float32Array(sr / 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));
  const toneWav = encodeWav([tone], sr, 16);
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/map.json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ _base: `${base}/`, testtone: ['tone.wav'] }));
    }
    if (req.url === '/tone.wav') {
      res.setHeader('content-type', 'audio/wav');
      return res.end(toneWav);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(dir, 'synth.js'), 'setcps(1)\nnote("c3 e3 g3 c4").s("sawtooth").gain(0.4)');
  await writeFile(join(dir, 'tone.js'), 'setcps(1)\ns("testtone")');
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('renders a synth script to a WAV with the requested length', async () => {
  const r = await run(['synth.js', '-d', '3', '--no-prebake', '--offline', '--cache-dir', 'cache']);
  assert.equal(r.code, 0, r.stderr);
  const wav = readWav(await readFile(join(dir, 'synth.wav')));
  assert.equal(wav.channels, 2);
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.bits, 16);
  assert.equal(wav.frames, 3 * 44100);
  assert.ok(wav.rms(0, 3) > 0.01, 'should not be silent');
});

test('--cycles, --tail and --fade-out', async () => {
  const r = await run(['synth.js', '-c', '2', '--tail', '1', '--fade-out', '1', '--fade-curve', 'linear', '--no-prebake', '--offline', '-o', 'f.wav', '--cache-dir', 'cache']);
  assert.equal(r.code, 0, r.stderr);
  const wav = readWav(await readFile(join(dir, 'f.wav')));
  assert.equal(wav.seconds, 3); // 2 cycles at cps 1 + 1 s tail
  assert.ok(wav.rms(2.95, 3) < wav.rms(1, 2) * 0.1, 'end should be faded');
});

test('asks before downloading and refuses without a terminal', async () => {
  requests.length = 0;
  const r = await run(['tone.js', '-d', '1', '--no-prebake', '--samples', `${base}/map.json`, '--cache-dir', 'cache2']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs 1 file\(s\) that are not cached/);
  assert.match(r.stderr, /map\.json/);
  assert.match(r.stderr, /--yes/);
  assert.deepEqual(requests, [], 'nothing may be fetched without consent');
});

test('--offline never downloads and renders anyway', async () => {
  requests.length = 0;
  const r = await run(['tone.js', '-d', '1', '--no-prebake', '--samples', `${base}/map.json`, '--offline', '-o', 'off.wav', '--cache-dir', 'cache3']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(requests, []);
  assert.match(r.stderr, /silent/);
});

test('--yes downloads in rounds (map, then sample), caches, and renders the sample', async () => {
  requests.length = 0;
  const r = await run(['tone.js', '-d', '2', '--no-prebake', '--samples', `${base}/map.json`, '-y', '-o', 'tone.wav', '--cache-dir', 'cache4']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(requests, ['/map.json', '/tone.wav']);
  const wav = readWav(await readFile(join(dir, 'tone.wav')));
  assert.ok(wav.rms(0, 0.4) > 0.05, 'sample should be audible');

  // second run: everything cached, no prompt, no network
  requests.length = 0;
  const again = await run(['tone.js', '-d', '2', '--no-prebake', '--samples', `${base}/map.json`, '-o', 'tone2.wav', '--cache-dir', 'cache4']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(requests, []);
});

test('rejects --yes together with --offline', async () => {
  const r = await run(['tone.js', '-d', '1', '--yes', '--offline']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /mutually exclusive/);
});

test('reports script errors', async () => {
  await writeFile(join(dir, 'bad.js'), 'note("c3").s("sawtooth").thisDoesNotExist()');
  const r = await run(['bad.js', '-d', '1', '--no-prebake', '--offline', '--cache-dir', 'cache']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /script error/);
});
