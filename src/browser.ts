import { existsSync } from 'node:fs';
import { join } from 'node:path';
// The browser bundle, inlined as a string at build time (see build.mjs).
import rendererSource from 'virtual:renderer';
import { launchChromium, Page, type Browser } from './cdp.js';
import type { FileCache } from './cache.js';
import type { RenderRequest, RenderResult } from './shared/types.js';

export type { Browser };

// The page is served from localhost (a secure context, required for AudioWorklet)
// entirely through request interception: no real server is started.
const ORIGIN = 'http://localhost:7357';

function candidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean) as string[];
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    return rel.flatMap((r) => roots.map((root) => join(root, r)));
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
}

export function findBrowser(explicit?: string): string {
  const path = explicit ?? process.env.STRUDEL2WAV_BROWSER ?? candidates().find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      'no Chromium-based browser found (Chrome, Chromium, Edge or Brave).\n' +
        'Install one, or pass --browser <path> (or set STRUDEL2WAV_BROWSER).',
    );
  }
  if (!existsSync(path)) throw new Error(`browser not found: ${path}`);
  return path;
}

export async function launch(executablePath: string): Promise<Browser> {
  try {
    return await launchChromium(executablePath);
  } catch (err: any) {
    throw new Error(`could not start the browser at ${executablePath}: ${err.message}`);
  }
}

export interface PassResult {
  result: RenderResult;
  /** Remote URLs the page wanted but which are not in the cache (they were blocked). */
  missing: string[];
  channels?: Float32Array[];
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
};
const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

export async function runPass(
  browser: Browser,
  cache: FileCache,
  req: RenderRequest,
  onLog: (msg: string) => void,
): Promise<PassResult> {
  const page = await Page.create(browser.cdp);
  const missing = new Set<string>();

  page.on('Runtime.exceptionThrown', (p) => onLog(`[page] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));

  page.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const fulfill = (status: number, h: Record<string, string>, body: string | Buffer) =>
      page.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers(h), body: b64(body) });
    try {
      const url: string = request.url;
      if (url.startsWith(ORIGIN)) {
        const path = new URL(url).pathname;
        if (path === '/') {
          return await fulfill(200, { 'content-type': 'text/html' }, '<!doctype html><meta charset="utf-8"><script type="module" src="/renderer.js"></script>');
        }
        if (path === '/renderer.js') return await fulfill(200, { 'content-type': 'text/javascript' }, rendererSource);
        return await fulfill(404, {}, '');
      }
      if (request.method === 'OPTIONS') return await fulfill(204, CORS, '');
      const cached = await cache.get(url);
      if (cached) return await fulfill(cached.status, { ...CORS, 'content-type': cached.contentType }, cached.body);
      // Never touch the network from the browser: record it and fail the request.
      missing.add(url);
      await page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch (err: any) {
      onLog(`[intercept] ${err.message}`);
    }
  });

  try {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await page.send('Page.navigate', { url: `${ORIGIN}/` });
    await page.waitFor('window.strudel2wavReady === true', 30_000);
    const result = await page.evaluate<RenderResult>(`window.strudel2wav.render(${JSON.stringify(req)})`);

    let channels: Float32Array[] | undefined;
    if (result.ok && !req.dryRun && result.frames && result.channels) {
      channels = [];
      const CHUNK = 1 << 20; // frames per transfer
      for (let c = 0; c < result.channels; c++) {
        const data = new Float32Array(result.frames);
        for (let start = 0; start < result.frames; start += CHUNK) {
          const chunk = await page.evaluate<string>(`window.strudel2wav.readChunk(${c}, ${start}, ${CHUNK})`);
          const bytes = Buffer.from(chunk, 'base64');
          // copy: pooled Buffers may not be 4-byte aligned
          const aligned = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          data.set(new Float32Array(aligned), start);
        }
        channels.push(data);
      }
    }
    return { result, missing: [...missing], channels };
  } finally {
    await page.close();
  }
}
