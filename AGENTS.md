# AGENTS.md

Reference for coding agents (and maintainers) working on or installing this
project. This file covers both: how to install and run Gaplex (below), and
how the codebase itself is built and why (further down).

## Project overview

Gaplex is a Node/TypeScript daemon that reads a YouTube Music playlist and
drives Liquidsoap's request queue so tracks play back-to-back with no gap.
It does not touch audio itself. It resolves track metadata via `yt-dlp` and
issues Liquidsoap telnet commands. Liquidsoap and Icecast do the actual
streaming and are out of scope for this repository (see Installation step 4
below for the exact interface boundary).

## Installation

This section is written as a literal runbook: a human or an AI agent should
be able to follow it top to bottom and end up with a running Gaplex. A few
steps are marked **REQUIRES INPUT** because they need information only the
project's user can provide. If you are an agent acting on someone's behalf
and that information wasn't given to you, stop and ask for it. Do not invent
a playlist URL, host, or port and proceed as if it were real.

### 1. Confirm prerequisites

```bash
docker --version
```

If this fails, Docker needs to be installed first
(https://docs.docker.com/get-docker/) — installing Docker itself is outside
this project's scope.

You also need a Liquidsoap + Icecast radio stack already running somewhere
reachable from wherever Gaplex will run. This project does not create that
stack. If one doesn't exist yet, that has to be set up first (a separate
project); pause and confirm with the user rather than assuming one exists.

### 2. REQUIRES INPUT: collect configuration values

Before continuing you need:

- `PLAYLIST_URL`: a YouTube Music playlist URL to stream
- `LIQUIDSOAP_HOST` and `LIQUIDSOAP_PORT`: where the target Liquidsoap
  instance's telnet interface is reachable
- `QUEUE_ID`: the `request.queue` id used in that Liquidsoap's script
  (suggest `gaplex_queue` if the user has no preference and is setting one
  up fresh)

### 3. Clone and configure

```bash
git clone https://github.com/zevnda/gaplex.git
cd gaplex
cp config/config.example.json config/config.json
```

Edit `config/config.json`, setting only these three values (leave everything
else at its default):

```json
{
  "playlistUrl": "PLAYLIST_URL",
  "liquidsoap": {
    "host": "LIQUIDSOAP_HOST",
    "port": LIQUIDSOAP_PORT,
    "queueId": "QUEUE_ID"
  }
}
```

### 4. Make sure Liquidsoap exposes what Gaplex needs

Gaplex doesn't set this up; it has to already exist on the Liquidsoap side.
It needs, at minimum, a queue and telnet enabled:

```liquidsoap
server.telnet(port=LIQUIDSOAP_PORT)
radio = request.queue(id="QUEUE_ID")
# use `radio` as the source feeding the existing Icecast output
```

And the machine/container Liquidsoap itself runs in needs yt-dlp and Deno
installed too, since Liquidsoap invokes yt-dlp directly as a subprocess to
fetch audio (see "Why Liquidsoap runs yt-dlp itself" below for why):

```bash
pip install -U yt-dlp
curl -fsSL https://deno.land/install.sh | sh
```

If you (the agent) don't have access to modify wherever Liquidsoap is
deployed, tell the user this step is required and confirm it's done before
continuing. Skipping it doesn't break Gaplex's own setup, it just means
nothing will actually play once you're done.

### 5. Build and run

```bash
docker build -t gaplex .
docker run -d \
  --name gaplex \
  --restart unless-stopped \
  -p 4242:4242 \
  -v "$(pwd)/config/config.json:/app/config/config.json:ro" \
  gaplex
```

The `-p 4242:4242` publishes the now-playing dashboard (see "Dashboard" below).
Drop it, or set `web.enabled` to `false` in the config, if you don't want it
reachable.

If Liquidsoap runs on the Docker host itself rather than in a container, use
`host.docker.internal` as `liquidsoap.host` instead of `127.0.0.1`, since
`127.0.0.1` inside a container resolves to the container, not the host. If
Liquidsoap runs in another container, put both containers on the same Docker
network and use the Liquidsoap container's name as `liquidsoap.host`.

### 6. Verify it worked

```bash
docker logs -f gaplex
```

Success looks like:

```
[...] [INFO] Loaded N track(s) from playlist (loop: true)
[...] [INFO] Now playing: "..."
```

- `Liquidsoap connection error ... ECONNREFUSED` means Gaplex can't reach
  the telnet interface at all. Recheck step 3's host/port and that step 4's
  `server.telnet(...)` is actually active.
- Playlist/track resolution logging looks fine, but nothing audible plays:
  step 4's yt-dlp/Deno install on the Liquidsoap side was likely skipped or
  failed. Check Liquidsoap's own logs, not Gaplex's, for the real error.

The installation is complete once step 6 shows a `Now playing` line and
audio is actually audible on the Icecast stream.

## Commands

- `pnpm install` — install dependencies
- `pnpm dev` — run from source with auto-restart (`tsx watch`)
- `pnpm build` — compile to `dist/`
- `pnpm start` — run the compiled output (`node dist/index.js`)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — `eslint .`
- `pnpm prettier` — `prettier --write .`

There is no automated test suite (see Testing below). Before considering a
change done, run `typecheck`, `lint`, and `prettier --check .` — all three
are expected to pass clean.

## Code style / conventions

- Strict TypeScript (`tsconfig.json`): `NodeNext` module resolution, so
  relative imports use explicit `.js` extensions even though the source is
  `.ts`. This is intentional, standard modern Node/TS practice — both `tsx`
  (dev) and `tsc` (build) resolve it correctly. Don't "fix" it by dropping
  the extensions.
- ESLint's `no-restricted-syntax` rule (in `eslint.config.ts`) forbids
  explicit return type annotations on function declarations and on arrow
  functions assigned via `const` — rely on inference instead. This matches
  the author's other projects' convention. It does **not** apply to class
  methods (the selector only matches `FunctionDeclaration` and
  `VariableDeclarator > ArrowFunctionExpression`), so methods keep explicit
  return types freely. Where an explicit return type is genuinely required
  (a type predicate, e.g. `isNodeError` in `src/config/load-config.ts`), it's
  annotated with an inline `// eslint-disable-next-line no-restricted-syntax`
  and a one-line reason — don't remove the annotation to satisfy the linter
  in cases like that.
- No semicolons, single quotes, trailing commas, 100-char print width — see
  `prettier.config.mjs`. Import order is enforced by
  `@ianvs/prettier-plugin-sort-imports`: types first, then Node builtins,
  then third-party, then relative, each group separated by a blank line.
- `no-console` is deliberately **off**, unlike a typical app — this is a
  long-running daemon whose entire interface is console output (see
  `src/logger/logger.ts`).
- No husky/lint-staged, by explicit request — don't reintroduce them without
  being asked.
- Markdown files (`*.md`) are excluded from Prettier (`.prettierignore`) —
  hand-format them.

## Architecture

```
src/
  config/       Config file loading, defaults, validation, and types
  index.ts      Entrypoint: wires config → playlist → scheduler together
  liquidsoap/   Telnet client; builds the process: URI Liquidsoap uses to
                run yt-dlp itself, and pushes it into the request queue
  logger/       Minimal timestamped console logger
  playlist/     Ordered playlist state (current track, next-up, looping)
  scheduler/    The prefetch scheduler — the core gapless-playback logic
  types/        Shared domain types (PlaylistEntry, TrackMetadata)
  util/         Small standalone helpers (retry/backoff, CLI args, formatting)
  web/          Now-playing dashboard: HTTP server + inline HTML/CSS/JS page
  ytdlp/        yt-dlp process invocation and output parsing
```

### The prefetch scheduler (`src/scheduler/prefetch-scheduler.ts`)

The scheduler tracks playback with its own clock, seeded from each track's
known duration — it does **not** poll Liquidsoap's actual playhead. On a
timer tick, once the time remaining on the current track drops below
`prefetchThresholdSec`, it resolves the next track's metadata and pushes its
request into Liquidsoap's queue immediately (not at the track boundary —
that would defeat the purpose of prefetching). When the internal clock
reaches the boundary, it just does local bookkeeping: hands off to the
already-queued track and starts the next clock from
`previous start time + previous duration`, not `Date.now()`, to avoid
drifting from tick-interval rounding.

If prefetch didn't finish in time (slow resolution, retries eating the
buffer), there's a synchronous fallback at the boundary that resolves and
pushes immediately — logged as a warning, since this is the one path that
can cause an audible gap.

Failed resolutions are retried with backoff (`util/retry.ts`); an entry that
exhausts its retry budget is permanently dropped from the playlist for the
rest of that run (`PlaylistManager.dropEntry`), so it isn't retried forever
on future loops.

### `PlaylistManager` (`src/playlist/playlist-manager.ts`)

Tracks the current position by track **id**, not array index. This matters:
dropping a failed *upcoming* entry mutates the underlying array, and an
index-based "current position" pointer would need careful off-by-one
adjustment depending on where the dropped entry sat relative to it —
especially across a `loop` wraparound, where "upcoming" can wrap to index 0
while "current" sits at the end of the array. Tracking by id sidesteps that
class of bug entirely.

### Dashboard (`src/web/`)

A small `node:http` server (`server.ts`) serves one page (`dashboard-page.ts`,
inline HTML/CSS/JS — no bundler, since `tsc`'s build has no asset-copy step)
plus the JSON API it polls/posts to: `GET /api/status` (current + next track),
`GET /api/config` (the configured default stream URL), `POST /api/skip`.

The page embeds the actual Icecast stream in an `<audio>` element and tries
to autoplay it; the play/pause button only controls that local `<audio>`
element — it's a listening control, not a broadcast control. "Skip" is the
only control that reaches back into Liquidsoap.

The Icecast stream URL is reachable from each listener's browser, not from
wherever Gaplex runs, so it can't be a fixed server value: `web.radioStreamUrl`
in config is only a *default* the page offers on first load. Once a visitor
saves a URL, the page stores it in that browser's `localStorage` and prefers
it over the config default from then on — no server-side write path, no
per-user account system, just the one thing every browser already gives you
for exactly this kind of per-visitor preference.

`PrefetchScheduler.skip()` (used by `POST /api/skip`) queues a replacement
track in Liquidsoap *before* sending `<queueId>.skip`, not after — sending
skip first would leave dead air if nothing had been prefetched yet, the same
failure mode already accepted for a late automatic advance (see below).

### Why Liquidsoap runs yt-dlp itself (`src/liquidsoap/telnet-client.ts`)

This wasn't the original design. Gaplex used to resolve a direct, signed
`googlevideo.com` stream URL via `yt-dlp -f bestaudio -j` and hand that URL
straight to Liquidsoap's `request.queue`, letting Liquidsoap's own HTTP
client fetch it. In practice, that fetch would hang and eventually time out
against YouTube's CDN — confirmed, via extensive manual testing, that this
was specific to Liquidsoap's HTTP client: the identical URL, from the same
Docker network, fetched instantly via `curl` or yt-dlp's own downloader. The
exact root cause inside Liquidsoap's client was never pinned down beyond
that.

The fix: Gaplex pushes a Liquidsoap **`process:` URI** instead, which tells
Liquidsoap to run `yt-dlp` itself, as a subprocess, and play whatever it
downloads — never touching the CDN via Liquidsoap's own HTTP client. As a
side benefit, the download now happens fresh at play time, so there's no
signed URL sitting around that could expire before Liquidsoap gets to it.

This was verified against Liquidsoap **v2.4.5's actual source**
(`savonet/liquidsoap` on GitHub), not the published docs, which are
incomplete here. Two things that only showed up in source:

1. **Colon escaping.** The `process:<extname>,<cmd>[:uri]` URI is parsed by
   first splitting the whole string on `:` to separate `<cmd>` from an
   optional trailing child request (`src/libs/protocols.liq`,
   `protocol.process.parse`). Our command necessarily contains a literal
   `:` (the `https://` in the video URL) — if it isn't escaped, Liquidsoap
   silently truncates the command at that colon. Every literal `:` in the
   constructed command is replaced with the placeholder text `$(colon)`,
   which Liquidsoap substitutes back to `:` right before running the
   command. See `buildProcessUri` for the exact logic — this is not
   optional, and was confirmed by generating a URI and running the resulting
   shell command directly via `sh -c` to verify it matches what Liquidsoap
   would actually execute.
2. **Failure doesn't fall back.** Checked `request_dynamic.ml` directly: if
   the pushed request fails to resolve (yt-dlp exits non-zero, or the
   process hits `liquidsoap.processTimeoutSec`), Liquidsoap destroys the
   failed request and checks its own internal queue array for the next
   item — it does **not** ask Gaplex for a replacement. Since Gaplex only
   ever pushes one track ahead at a time, a failure here leaves the queue
   empty at that boundary: dead air, not an automatic skip to a different
   track. There's also no default Liquidsoap telnet command to observe an
   individual request's resolve outcome after the fact (only a deprecated
   `request.on_air` listing) — Gaplex has no visibility into this failure
   mode. This is a real, accepted limitation, not an oversight.

**Telnet has no built-in authentication.** Confirmed directly in Liquidsoap's
source (`src/core/base/tools/server.ml`, `conf_telnet` doc string): *"Since
there is currently no authentication, you should be careful."* `LiquidsoapConfig.password`
(if set) is sent as the first line of each connection on the assumption you've
added your own auth wrapper in front of Liquidsoap's telnet port — stock
Liquidsoap does nothing with it. The safe default is binding telnet to
localhost or an internal network only, not exposing it publicly.

Liquidsoap does ship a built-in `youtube-dl:` protocol, which was considered
and rejected: it hardcodes `-f best` (downloads video too, not audio-only)
and runs yt-dlp *twice* (once to probe title/extension, once to download).
Gaplex already resolves `-f bestaudio` metadata itself and that response
includes the exact output extension (`ext`, e.g. `"webm"`) yt-dlp will
produce — so the custom `process:` URI needs only one yt-dlp invocation on
the Liquidsoap side, not two.

## Testing

There is no automated test suite. Changes to the yt-dlp/Liquidsoap
integration were verified manually, and this is the expected standard for
future changes in this area too:

- Ran `pnpm dev` and `pnpm build && pnpm start` against a real YouTube
  playlist URL end-to-end (not a mock), confirming playlist parsing, metadata
  resolution, and retry paths all execute correctly.
- Stood up a throwaway TCP listener in place of Liquidsoap to capture the
  *exact* wire command Gaplex sends, then ran that exact string as a real
  shell command via `sh -c` (with `$(output)` substituted for a real path) to
  confirm it downloads correctly — not just that the string "looks right".

When touching yt-dlp invocation or the `process:` URI construction: don't
assume Liquidsoap protocol syntax from its published docs, which are
frequently incomplete or stale — check against Liquidsoap's own source
(`savonet/liquidsoap` on GitHub, pinned to the deployed version) the way the
work above did, and re-verify the generated command actually runs.

## Deployment

The [Dockerfile](Dockerfile) builds Gaplex's own container (yt-dlp + Deno +
compiled JS) and is the only infrastructure this repository owns — Icecast
and Liquidsoap are deployed separately, elsewhere.

**Liquidsoap's own container/host also needs yt-dlp + Deno installed**, since
it now invokes yt-dlp itself as a subprocess (see above). This repository's
Dockerfile does not and cannot cover that — it's a separate deployment
concern, easy to forget, and covered in Installation step 4 above.
