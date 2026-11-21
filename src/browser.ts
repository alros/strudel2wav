import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { FileCache } from './cache.js';
import type { RenderRequest, RenderResult } from './shared/types.js';

// The page is served from localhost (a secure context, required for AudioWorklet)
// entirely through request interception: no real server is started.
const ORIGIN = 'http://localhost:7357';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findBrowser(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.STRUDEL2WAV_BROWSER) return process.env.STRUDEL2WAV_BROWSER;
  return CANDIDATES.find((p) => existsSync(p)); // undefined => Playwright's bundled Chromium
}

export async function launch(executablePath?: string): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, executablePath });
  } catch (err: any) {
    throw new Error(
      `could not start a Chromium-based browser (${err.message.split('\n')[0]}).\n` +
        `Install Chrome/Chromium, pass --browser <path>, or run: npx playwright install chromium`,
    );
  }
}

export interface PassResult {
  result: RenderResult;
  /** Remote URLs the page wanted but which are not in the cache (they were blocked). */
  missing: string[];
  channels?: Float32Array[];
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
};

export async function runPass(
  browser: Browser,
  bundlePath: string,
  cache: FileCache,
  req: RenderRequest,
  onLog: (msg: string) => void,
): Promise<PassResult> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const missing = new Set<string>();
  const bundle = await readFile(bundlePath);

  page.on('pageerror', (err) => onLog(`[page] ${err.message}`));

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(ORIGIN)) {
      const path = new URL(url).pathname;
      if (path === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script type="module" src="/renderer.js"></script>' });
      }
      if (path === '/renderer.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    const cached = await cache.get(url);
    if (cached) {
      return route.fulfill({ status: cached.status, headers: { ...CORS, 'content-type': cached.contentType }, body: cached.body });
    }
    // Never touch the network from the browser: record it and fail the request.
    missing.add(url);
    return route.abort('blockedbyclient');
  });

  try {
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => (window as any).strudel2wavReady === true, null, { timeout: 30_000 });
    const result: RenderResult = await page.evaluate((r) => (window as any).strudel2wav.render(r), req);

    let channels: Float32Array[] | undefined;
    if (result.ok && !req.dryRun && result.frames && result.channels) {
      channels = [];
      const CHUNK = 1 << 20; // frames per transfer
      for (let c = 0; c < result.channels; c++) {
        const data = new Float32Array(result.frames);
        for (let start = 0; start < result.frames; start += CHUNK) {
          const b64: string = await page.evaluate(
            ([ch, s, n]) => (window as any).strudel2wav.readChunk(ch, s, n),
            [c, start, CHUNK] as const,
          );
          const bytes = Buffer.from(b64, 'base64');
          // copy: pooled Buffers may not be 4-byte aligned
          const aligned = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          data.set(new Float32Array(aligned), start);
        }
        channels.push(data);
      }
    }
    return { result, missing: [...missing], channels };
  } finally {
    await context.close();
  }
}
