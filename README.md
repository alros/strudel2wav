# strudel2wav

Render a [Strudel](https://strudel.cc) script to a WAV file from the command line.

It runs the real Strudel packages (`@strudel/*`, `superdough`) in headless Chromium and renders
faster than real time into an `OfflineAudioContext`, so the result sounds the same as on strudel.cc.

## Install

```sh
npm install        # also builds dist/
npm link           # optional: puts `strudel2wav` on your PATH
```

You don't need `npm link`: from the project directory you can always run the CLI directly
with `node dist/cli.js` in place of `strudel2wav`, e.g.

```sh
node dist/cli.js song.js -d 60 --fade-out 8
```

To remove `strudel2wav` from your PATH again:

```sh
npm unlink -g strudel2wav   # removes the global link (run from any directory)
which strudel2wav           # should print nothing now
```

If your shell still finds it, run `hash -r` (bash/zsh) or open a new terminal: the shell caches
command locations.

Needs Node 20+ and a Chromium-based browser. Chrome, Chromium, Edge and Brave are auto-detected;
otherwise pass `--browser <path>` or run `npx playwright install chromium`.

## Usage

```sh
strudel2wav song.js -d 60                         # 60 s -> song.wav
strudel2wav song.js -d 1:30 --fade-out 8          # 90 s, fade out over the last 8 s
strudel2wav song.js -c 16 --tail 3 -o out.wav     # 16 cycles + 3 s of reverb tail
cat song.js | strudel2wav - -d 30 -y -o out.wav   # from stdin
```

| Option | Meaning |
|---|---|
| `-d, --duration <time>` | length in seconds or `m:ss` (events scheduled in `[0, duration)`) |
| `-c, --cycles <n>` | length in cycles instead of seconds |
| `--cps <n>` | override the tempo (default: script's `setcps`/`setcpm`, else 0.5) |
| `--tail <s>` | extra seconds rendered after the end so notes/effects ring out (default 0) |
| `--fade-out <s>` / `--fade-in <s>` | fade over the last / first N seconds of the file |
| `--fade-curve linear\|exp` | `exp` (default) is an even-sounding fade from −60 dB, `linear` fades amplitude |
| `-r, --sample-rate <hz>` | default 44100 |
| `-b, --bit-depth 16\|24\|32` | 32 = float, never clips (default 16) |
| `--no-prebake` | don't load Strudel's default sample library |
| `--samples <url>` | extra sample map, e.g. `github:user/repo` (repeatable); `samples(...)` in the script also works |
| `-y, --yes` / `--offline` | download without asking / never download |
| `--cache-dir <dir>` | default `~/.cache/strudel2wav` |
| `-v, --verbose` | show Strudel's log |

File length = duration + tail. The fade always ends at the very end of the file.

## Network and downloads

The browser never accesses the network itself. All its requests are intercepted:

1. Files already in the cache are served from disk.
2. Anything else is blocked and recorded during a dry run of the script.
3. strudel2wav lists the files it needs, grouped by host, and asks:
   `[y]es / [n]o, render without them / [l]ist all / [q]uit`.
4. Approved files are downloaded into the cache, and the dry run is repeated. Loading a sample map
   reveals the sample files it needs, so this takes a couple of rounds the first time.
5. The final render runs entirely from the cache.

Strudel's default library (the same set strudel.cc preloads) is a handful of small JSON maps.
Only the audio files your script actually plays are downloaded. Without a terminal (CI, pipes),
pass `--yes` or `--offline`.

## Development

```sh
npm run build       # esbuild: dist/cli.js (Node) + dist/renderer.js (browser bundle)
npm run typecheck
npm test            # end-to-end tests; no internet needed (a local server simulates sample hosts)
```

- `src/cli.ts`: arguments, the discovery/consent loop, fades, WAV output
- `src/browser.ts`: Playwright, request interception, PCM transfer
- `src/page/main.ts`: runs in the browser: evaluates the script with Strudel's REPL and renders with superdough
- `src/cache.ts`, `src/wav.ts`: the download cache and the WAV encoder/fades

## License

Strudel is AGPL-3.0, and `dist/renderer.js` bundles it, so this project is AGPL-3.0-or-later too.
