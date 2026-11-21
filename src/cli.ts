#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { FileCache, defaultCacheDir, download } from './cache.js';
import { findBrowser, launch, runPass } from './browser.js';
import { applyFades, encodeWav, peak, type BitDepth, type FadeCurve } from './wav.js';
import type { RenderRequest } from './shared/types.js';

const HELP = `strudel2wav - render a Strudel script to a WAV file

Usage: strudel2wav <script.js|-> -d <seconds> [options]

Length (one is required):
  -d, --duration <time>     length in seconds, or m:ss (e.g. 90, 1:30)
  -c, --cycles <n>          length in cycles (uses the script's cps)

Sound:
      --cps <n>             override cycles per second (default: script's setcps/setcpm, else 0.5)
      --tail <seconds>      extra time rendered after the end so notes/reverb ring out (default 0)
      --fade-out <seconds>  fade out over the last N seconds of the file
      --fade-in <seconds>   fade in over the first N seconds
      --fade-curve <c>      linear | exp (default exp, even-sounding dB fade)

Output:
  -o, --output <file>       output path (default: <script>.wav)
  -r, --sample-rate <hz>    default 44100
  -b, --bit-depth <bits>    16 | 24 | 32 (32 = float) (default 16)

Samples & network:
      --no-prebake          don't load Strudel's default sample library
      --samples <url>       extra sample map to load (repeatable), e.g. github:user/repo
  -y, --yes                 download needed files without asking
      --offline             never download; render with what is cached
      --cache-dir <dir>     default ${defaultCacheDir()}

Other:
      --browser <path>      Chromium-based browser to use (default: auto-detect)
      --max-polyphony <n>   default 128
  -v, --verbose             print Strudel log output
  -h, --help
`;

const out = (s: string) => process.stderr.write(s + '\n');

function fail(msg: string): never {
  out(`error: ${msg}`);
  process.exit(1);
}

function num(name: string, v: string | undefined, def?: number, min = 0): number | undefined {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) fail(`--${name} must be a number >= ${min} (got "${v}")`);
  return n;
}

function parseTime(v: string): number {
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  const n = m ? Number(m[1]) * 60 + Number(m[2]) : Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`invalid duration "${v}"`);
  return n;
}

function groupByHost(urls: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const u of urls) {
    let host = u;
    try {
      host = new URL(u).host;
    } catch {}
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

type Decision = 'yes' | 'no' | 'quit';

async function askToFetch(urls: string[], mode: 'ask' | 'yes' | 'offline'): Promise<Decision> {
  const PREVIEW = 12;
  out(`\nThe script needs ${urls.length} file(s) that are not cached yet:`);
  for (const [host, n] of groupByHost(urls)) out(`  ${String(n).padStart(5)}  from ${host}`);
  const show = (all: boolean) => {
    for (const u of all ? urls : urls.slice(0, PREVIEW)) out(`    ${decodeURI(u)}`);
    if (!all && urls.length > PREVIEW) out(`    ... and ${urls.length - PREVIEW} more`);
  };
  show(false);

  if (mode === 'yes') return 'yes';
  if (mode === 'offline') {
    out('--offline: not downloading; those sounds will be silent.');
    return 'no';
  }
  if (!process.stdin.isTTY) {
    fail('confirmation needed but stdin is not a terminal. Re-run with --yes to download or --offline to skip.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const a = (await rl.question('Download them? [y]es / [n]o, render without them / [l]ist all / [q]uit: ')).trim().toLowerCase();
      if (a === 'y' || a === 'yes') return 'yes';
      if (a === 'n' || a === 'no') return 'no';
      if (a === 'q' || a === 'quit') return 'quit';
      if (a === 'l' || a === 'list') show(true);
    }
  } finally {
    rl.close();
  }
}

async function downloadAll(urls: string[], cache: FileCache): Promise<string[]> {
  const failed: string[] = [];
  let done = 0;
  let bytes = 0;
  const queue = [...urls];
  const tty = process.stderr.isTTY;
  const progress = () => {
    if (tty) process.stderr.write(`\r  downloaded ${done}/${urls.length} (${(bytes / 1e6).toFixed(1)} MB)`);
  };
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          const res = await download(url);
          await cache.put(url, res);
          bytes += res.body.length;
        } catch (err: any) {
          failed.push(url);
          if (tty) process.stderr.write('\n');
          out(`  failed: ${url} (${err.message})`);
        }
        done++;
        progress();
      }
    }),
  );
  if (tty) process.stderr.write('\n');
  out(`  downloaded ${urls.length - failed.length} file(s), ${(bytes / 1e6).toFixed(1)} MB`);
  return failed;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      duration: { type: 'string', short: 'd' },
      cycles: { type: 'string', short: 'c' },
      cps: { type: 'string' },
      tail: { type: 'string' },
      'fade-out': { type: 'string' },
      'fade-in': { type: 'string' },
      'fade-curve': { type: 'string' },
      output: { type: 'string', short: 'o' },
      'sample-rate': { type: 'string', short: 'r' },
      'bit-depth': { type: 'string', short: 'b' },
      'no-prebake': { type: 'boolean' },
      samples: { type: 'string', multiple: true },
      yes: { type: 'boolean', short: 'y' },
      offline: { type: 'boolean' },
      'cache-dir': { type: 'string' },
      browser: { type: 'string' },
      'max-polyphony': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length !== 1) fail('expected exactly one input script (or "-" for stdin). See --help.');
  const input = positionals[0];
  if (values.duration && values.cycles) fail('use either --duration or --cycles, not both');
  if (!values.duration && !values.cycles) fail('a length is required: --duration <seconds> or --cycles <n>');
  if (values.yes && values.offline) fail('--yes and --offline are mutually exclusive');

  const code = input === '-' ? await new Response(process.stdin as any).text() : await readFile(input, 'utf8').catch(() => fail(`cannot read ${input}`));
  const output = values.output ?? (input === '-' ? 'out.wav' : `${basename(input, extname(input))}.wav`);
  const sampleRate = num('sample-rate', values['sample-rate'], 44100, 3000)!;
  const bitDepth = num('bit-depth', values['bit-depth'], 16) as BitDepth;
  if (![16, 24, 32].includes(bitDepth)) fail('--bit-depth must be 16, 24 or 32');
  const curve = (values['fade-curve'] ?? 'exp') as FadeCurve;
  if (curve !== 'linear' && curve !== 'exp') fail('--fade-curve must be linear or exp');
  const cpsOverride = num('cps', values.cps);
  if (cpsOverride === 0) fail('--cps must be > 0');
  const cycles = num('cycles', values.cycles);
  const tail = num('tail', values.tail, 0)!;
  const fadeIn = num('fade-in', values['fade-in'], 0)!;
  const fadeOut = num('fade-out', values['fade-out'], 0)!;
  const mode = values.yes ? 'yes' : values.offline ? 'offline' : 'ask';

  const cache = new FileCache(values['cache-dir'] ? resolve(values['cache-dir']) : defaultCacheDir());
  const bundlePath = fileURLToPath(new URL('./renderer.js', import.meta.url));
  const browser = await launch(findBrowser(values.browser));
  const log = (m: string) => values.verbose && out(m);

  const req: RenderRequest = {
    code,
    seconds: values.duration ? parseTime(values.duration) : 0,
    tail,
    sampleRate,
    cpsOverride,
    prebake: !values['no-prebake'],
    extraSamples: values.samples ?? [],
    dryRun: true,
    maxPolyphony: num('max-polyphony', values['max-polyphony'], 128, 1)!,
  };

  try {
    // 1) Discovery: run the script with network blocked, collect what it needs, ask, download, repeat.
    //    (Downloading sample maps reveals new sample URLs, hence several rounds.)
    const skipped = new Set<string>();
    for (let round = 0; ; round++) {
      if (round > 8) fail('gave up resolving dependencies after 8 rounds');
      if (cycles !== undefined) req.seconds = 0.001; // need cps first; see below
      let pass = await runPass(browser, bundlePath, cache, req, log);
      if (cycles !== undefined && pass.result.cps) {
        req.seconds = cycles / pass.result.cps;
        pass = await runPass(browser, bundlePath, cache, req, log);
      }
      const wanted = pass.missing.filter((u) => !skipped.has(u));
      if (!wanted.length) {
        if (!pass.result.ok) fail(`script error: ${pass.result.error}`);
        break;
      }
      const decision = await askToFetch(wanted, mode);
      if (decision === 'quit') fail('aborted');
      if (decision === 'no') wanted.forEach((u) => skipped.add(u));
      else (await downloadAll(wanted, cache)).forEach((u) => skipped.add(u));
    }

    // 2) Real render, everything served from the cache.
    out(`\nRendering ${req.seconds.toFixed(2)}s${tail ? ` + ${tail}s tail` : ''} at ${sampleRate} Hz...`);
    const t0 = performance.now();
    const { result, channels } = await runPass(browser, bundlePath, cache, { ...req, dryRun: false }, log);
    if (!result.ok || !channels) fail(`render failed: ${result.error ?? 'unknown error'}`);
    for (const l of result.logs) {
      if (values.verbose) out(`  ${l.message}`);
      else if (l.level !== 'info') out(`  warning: ${l.message}`);
    }

    applyFades(channels, sampleRate, fadeIn, fadeOut, curve);
    const p = peak(channels);
    await writeFile(output, encodeWav(channels, sampleRate, bitDepth));

    const secs = channels[0].length / sampleRate;
    out(`Wrote ${output}: ${secs.toFixed(2)}s, ${result.haps} events, cps ${result.cps?.toFixed(3)}, ` +
      `peak ${p > 0 ? (20 * Math.log10(p)).toFixed(1) : '-inf'} dBFS (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    if (p === 0) out('warning: output is completely silent');
    if (p > 1 && bitDepth !== 32) out('warning: output clipped (peak above 0 dBFS); lower .gain() or use -b 32');
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
