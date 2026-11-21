// Browser-side renderer. Bundled by esbuild and loaded into headless Chromium.
// It evaluates a Strudel script with the real Strudel packages and renders it
// with superdough into an OfflineAudioContext.

import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import * as soundfonts from '@strudel/soundfonts';
import { transpiler } from '@strudel/transpiler';
import {
  superdough,
  samples,
  aliasBank,
  initAudio,
  setAudioContext,
  setSuperdoughAudioController,
  registerSynthSounds,
  registerZZFXSounds,
} from 'superdough';
import type { RenderRequest, RenderResult } from '../shared/types.js';

const { repl, logKey } = core as any;

type Log = { level: 'info' | 'warning' | 'error'; message: string };
const logs: Log[] = [];
const log = (level: Log['level'], message: string) => logs.push({ level, message });

document.addEventListener(logKey, (e: any) => {
  const { message, type } = e.detail ?? {};
  const level = type === 'error' ? 'error' : /error|could not|not found|failed/i.test(message) ? 'warning' : 'info';
  log(level, String(message));
});

let rendered: AudioBuffer | undefined;

// Same default sound library that strudel.cc preloads.
const DOUGH = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const DEFAULT_SAMPLE_MAPS = [
  `${DOUGH}/tidal-drum-machines.json`,
  `${DOUGH}/piano.json`,
  `${DOUGH}/Dirt-Samples.json`,
  `${DOUGH}/EmuSP12.json`,
  `${DOUGH}/vcsl.json`,
  `${DOUGH}/mridangam.json`,
];
const DEFAULT_ALIASES = 'https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json';

async function settle(label: string, promises: Promise<unknown>[]) {
  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === 'rejected') log('warning', `${label}: ${r.reason?.message ?? r.reason}`);
  }
}

async function render(req: RenderRequest): Promise<RenderResult> {
  const { code, seconds, tail, sampleRate, cpsOverride, prebake, extraSamples, dryRun, maxPolyphony } = req;
  logs.length = 0;

  const frames = Math.max(1, Math.ceil((seconds + tail) * sampleRate));
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  setAudioContext(ctx);
  // Reset the controller: superdough lazily recreates it on the current (offline) context.
  // (Don't import SuperdoughAudioController directly: a deep import bundles a second
  // copy of superdough whose nodes live on a different AudioContext.)
  setSuperdoughAudioController(null);

  await core.evalScope(core, mini, tonal, webaudio, soundfonts, Promise.resolve({ samples, aliasBank }));
  await initAudio({ maxPolyphony });

  registerSynthSounds();
  registerZZFXSounds();
  soundfonts.registerSoundfonts();
  if (prebake) {
    await settle('default samples', DEFAULT_SAMPLE_MAPS.map((url) => samples(url, undefined, { prebake: true })));
    await settle('default aliases', [aliasBank(DEFAULT_ALIASES)]);
  }
  await settle('samples', extraSamples.map((s: string) => samples(s)));

  let evalError: string | undefined;
  const instance = repl({
    defaultOutput: () => {},
    getTime: () => 0,
    transpiler,
    onEvalError: (err: Error) => (evalError = err?.message ?? String(err)),
  });
  const pattern = await instance.evaluate(code, false);
  if (!pattern || evalError) {
    return { ok: false, error: evalError ?? 'script did not produce a pattern', logs: [...logs], haps: 0 };
  }

  const cps: number = cpsOverride ?? instance.scheduler.cps;
  const endCycle = seconds * cps;

  // Ascending onset order matters for controls like `cut` (same as Strudel's own renderer).
  const haps = pattern
    .queryArc(0, endCycle, { _cps: cps })
    .filter((h: any) => h.hasOnset())
    .sort((a: any, b: any) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

  for (const hap of haps) {
    hap.ensureObjectValue();
    const t = hap.whole.begin.valueOf() / cps;
    try {
      await superdough(hap.value, t, hap.duration / cps, cps, t);
    } catch (err: any) {
      log('warning', `[superdough] ${err?.message ?? err}`);
    }
  }

  if (dryRun) {
    return { ok: true, logs: [...logs], haps: haps.length, cps };
  }

  rendered = await ctx.startRendering();
  setAudioContext(null);
  setSuperdoughAudioController(null);
  return {
    ok: true,
    logs: [...logs],
    haps: haps.length,
    cps,
    frames: rendered.length,
    channels: rendered.numberOfChannels,
    sampleRate: rendered.sampleRate,
  };
}

// Returns a base64 slice of one rendered channel (Float32 little-endian).
function readChunk(channel: number, start: number, length: number): string {
  if (!rendered) throw new Error('nothing rendered');
  const data = rendered.getChannelData(channel).subarray(start, start + length);
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(bin);
}

(window as any).strudel2wav = { render, readChunk };
(window as any).strudel2wavReady = true;
