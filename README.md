# strudel2wav

Render a [Strudel](https://strudel.cc) script to a WAV file from the command line.

It runs the real Strudel packages (`@strudel/*`, `superdough`) in headless Chromium and renders
faster than real time into an `OfflineAudioContext`, so the result sounds the same as on strudel.cc.

## Requirements

A Chromium-based browser: Chrome, Chromium, Edge or Brave. It is auto-detected in its standard
install location; otherwise pass `--browser <path>` or set `STRUDEL2WAV_BROWSER`. The browser
runs headless and is used only to run Strudel's audio engine.

## Install: download an executable

Download the file for your platform from the [Releases](../../releases) page. No Node.js is
needed.

| Platform | File |
|---|---|
| macOS, Apple silicon | `strudel2wav-macos-arm64` |
| macOS, Intel | `strudel2wav-macos-x64` |
| Linux x64 / arm64 | `strudel2wav-linux-x64` / `strudel2wav-linux-arm64` |
| Windows x64 | `strudel2wav-windows-x64.exe` |

```sh
chmod +x strudel2wav-macos-arm64
# macOS only: the binary is not notarized, so remove the download quarantine first
xattr -d com.apple.quarantine strudel2wav-macos-arm64
./strudel2wav-macos-arm64 --version
```

Optionally rename it to `strudel2wav` and move it into a folder on your PATH
(e.g. `~/.local/bin` or `/usr/local/bin`). To uninstall, delete the file.
`SHA256SUMS.txt` on the release page lists checksums to verify the download.

On Windows, SmartScreen may warn about an unrecognized app: choose "More info" → "Run anyway".

## Install: from source

Needs Node 22+.

```sh
npm install        # also builds dist/cli.cjs
npm link           # optional: puts `strudel2wav` on your PATH
```

You don't need `npm link`: from the project directory you can always run the CLI directly
with `node dist/cli.cjs` in place of `strudel2wav`, e.g.

```sh
node dist/cli.cjs song.js -d 60 --fade-out 8
```

To remove `strudel2wav` from your PATH again:

```sh
npm unlink -g strudel2wav   # removes the global link (run from any directory)
which strudel2wav           # should print nothing now
```

If your shell still finds it, run `hash -r` (bash/zsh) or open a new terminal: the shell caches
command locations.

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
| `--browser <path>` | browser to use (default: auto-detect) |
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

In Docker or other sandboxes where Chrome's sandbox can't start, set
`STRUDEL2WAV_CHROME_ARGS="--no-sandbox"` (extra flags passed to the browser).

## Development

```sh
npm run build       # esbuild: dist/cli.cjs, one self-contained file with the browser bundle inlined
npm run typecheck
npm test            # end-to-end tests; no internet needed (a local server simulates sample hosts)
npm run build:exe   # standalone executable for this OS/arch -> release/
STRUDEL2WAV_EXE=release/strudel2wav-macos-arm64 node --test test/e2e.test.mjs   # test the executable
```

- `src/cli.ts`: arguments, the discovery/consent loop, fades, WAV output
- `src/browser.ts`: browser detection, request interception, PCM transfer
- `src/cdp.ts`: a minimal Chrome DevTools Protocol client (launches and drives headless Chromium)
- `src/page/main.ts`: runs in the browser: evaluates the script with Strudel's REPL and renders with superdough
- `src/cache.ts`, `src/wav.ts`: the download cache and the WAV encoder/fades
- `scripts/build-exe.mjs`: packs `dist/cli.cjs` with Node's
  [single executable applications](https://nodejs.org/api/single-executable-applications.html) feature

### Releasing

GitHub Actions builds the executables (`.github/workflows/release.yml`):

```sh
npm version 0.2.0          # bumps package.json and creates the tag v0.2.0
git push --follow-tags     # the tag triggers the build and creates the GitHub Release
```

Every platform is built on its own runner, and every executable runs the end-to-end tests
before the release is published. The Linux arm64 build only gets a `--version` check, because
that runner has no Chrome. Running the workflow by hand ("Run workflow" in the Actions tab)
builds the executables as downloadable artifacts without creating a release.
`.github/workflows/ci.yml` runs the tests on every push and pull request.

## License

Strudel is AGPL-3.0, and `dist/cli.cjs` and the executables bundle it, so this project is AGPL-3.0-or-later too.
