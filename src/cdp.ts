// Minimal Chrome DevTools Protocol client: just enough to drive one headless
// Chromium without Playwright, so the CLI can ship as a single executable.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Handler = (params: any, sessionId?: string) => void;

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`browser connection closed (${p.method})`));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new CdpConnection(ws);
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, handler: Handler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(handler);
    return () => this.handlers.get(method)!.delete(handler);
  }

  close() {
    this.ws.close();
  }
}

export interface Browser {
  cdp: CdpConnection;
  close(): Promise<void>;
}

export async function launchChromium(executablePath: string): Promise<Browser> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'strudel2wav-chrome-'));
  const proc: ChildProcess = spawn(
    executablePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      // e.g. STRUDEL2WAV_CHROME_ARGS="--no-sandbox" in containers/CI without user namespaces
      ...(process.env.STRUDEL2WAV_CHROME_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`browser did not start in time.\n${stderr.slice(-2000)}`)), 30_000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${code}.\n${stderr.slice(-2000)}`));
    });
    proc.stderr!.on('data', (chunk) => {
      stderr += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  proc.removeAllListeners('exit');
  proc.stderr!.resume(); // keep draining so the browser never blocks on a full pipe

  const cdp = await CdpConnection.connect(wsUrl);
  return {
    cdp,
    async close() {
      await cdp.send('Browser.close').catch(() => {});
      cdp.close();
      if (proc.exitCode === null) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
          }, 5000);
          proc.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    },
  };
}

/** A fresh page in its own browser context (no shared cache/state between passes). */
export class Page {
  private off: (() => void)[] = [];

  private constructor(
    private cdp: CdpConnection,
    private contextId: string,
    private sessionId: string,
  ) {}

  static async create(cdp: CdpConnection): Promise<Page> {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, browserContextId, sessionId);
    await page.send('Runtime.enable');
    return page;
  }

  send(method: string, params: object = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  on(method: string, handler: (params: any) => void) {
    this.off.push(this.cdp.on(method, (p, sid) => sid === this.sessionId && handler(p)));
  }

  /** Evaluate an expression in the page, awaiting promises; returns the JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? 'evaluation failed');
    }
    return res.result.value as T;
  }

  async waitFor(expression: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await this.evaluate<boolean>(`!!(${expression})`))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async close() {
    this.off.forEach((f) => f());
    await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {});
  }
}
