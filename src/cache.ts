import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CachedResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'strudel2wav');
}

/** Content-addressed on-disk cache of remote files (samples, sample maps, soundfonts). */
export class FileCache {
  constructor(readonly dir: string) {}

  private paths(url: string) {
    const key = createHash('sha256').update(url).digest('hex');
    const base = join(this.dir, key.slice(0, 2), key);
    return { body: `${base}.bin`, meta: `${base}.json` };
  }

  has(url: string): boolean {
    return existsSync(this.paths(url).meta);
  }

  async get(url: string): Promise<CachedResponse | undefined> {
    const p = this.paths(url);
    if (!existsSync(p.meta)) return undefined;
    const meta = JSON.parse(await readFile(p.meta, 'utf8'));
    return { status: meta.status, contentType: meta.contentType, body: await readFile(p.body) };
  }

  async put(url: string, res: CachedResponse): Promise<void> {
    const p = this.paths(url);
    await mkdir(join(p.body, '..'), { recursive: true });
    await writeFile(`${p.body}.tmp`, res.body);
    await rename(`${p.body}.tmp`, p.body);
    // meta is written last: its presence marks the entry as complete.
    await writeFile(p.meta, JSON.stringify({ url, status: res.status, contentType: res.contentType, size: res.body.length, fetchedAt: new Date().toISOString() }));
  }
}

export async function download(url: string): Promise<CachedResponse> {
  const res = await fetch(url, { headers: { 'User-Agent': 'strudel2wav' } });
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, contentType: res.headers.get('content-type') ?? 'application/octet-stream', body };
}
