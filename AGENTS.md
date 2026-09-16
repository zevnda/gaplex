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

Optionally, also ask for:

- `RADIO_STREAM_URL`: the Icecast mount URL listeners hit directly (e.g.
  `http://your-icecast-host:8000/mount.mp3`) — used only as the dashboard's
  default stream source (see step 5). Not required: if left blank, every
  visitor just enters their own in the dashboard, so don't block on this one.

### 3. Clone and configure

```bash
git clone https://github.com/zevnda/gaplex.git
cd gaplex
cp config/config.example.json config/config.json
```

Edit `config/config.json`, setting only these values (leave everything else
at its default):

```json
{
  "playlistUrl": "PLAYLIST_URL",
  "liquidsoap": {
    "host": "LIQUIDSOAP_HOST",
    "port": LIQUIDSOAP_PORT,
    "queueId": "QUEUE_ID"
  },
  "web": {
    "radioStreamUrl": "RADIO_STREAM_URL"
  }
}
```

Drop the `web` block entirely if `RADIO_STREAM_URL` wasn't provided (step 2) —
`radioStreamUrl` defaults to `null`, which just means the dashboard asks each
visitor for their own stream URL instead of pre-filling one.

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

### 5. Build and run (via Docker Compose)

Gaplex should be deployed the same way as everything else in this stack —
via `docker-compose.yml`, not standalone `docker run` — so that future
updates are a single `docker compose up -d --build` rather than manual
stop/rm/rebuild/run steps.

Add a `gaplex` service to the same `docker-compose.yml` that already defines
your Liquidsoap and Icecast services (this keeps all three on the same
Docker network automatically, so `liquidsoap.host` in step 3 can just be the
Liquidsoap service's name — no manual `--network` flag needed):

```yaml
  gaplex:
    build: ./gaplex
    container_name: gaplex
    restart: unless-stopped
    depends_on:
      - liquidsoap
    ports:
      - 4242:4242
    volumes:
      - ./gaplex/config:/app/config
```

Then:

```bash
docker compose up -d --build gaplex
```

The `-p 4242:4242` (via the `ports:` block above) publishes the now-playing
dashboard (see "Dashboard" below) at `http://<docker-host>:4242`. Drop it, or
set `web.enabled` to `false` in the config, if you don't want it reachable.

If Liquidsoap runs in the same `docker-compose.yml` (recommended, and how
this doc assumes things are set up), use that service's name as
`liquidsoap.host` — Docker Compose resolves service names to the right
internal address automatically. If Liquidsoap runs on the Docker host
itself rather than in a container, use `host.docker.internal` instead. If
Liquidsoap runs in a separate `docker-compose.yml` project entirely, you'll
need to either merge them into one file, or set up a shared external Docker
network so both projects' containers can reach each other by name.

**Updating Gaplex later:** pull the latest code, then re-run the build:

```bash
git pull
docker compose up -d --build gaplex
```

This rebuilds the image and replaces the running container in one step — no
need to manually stop, remove, or re-run anything.

### 6. Verify it worked

```bash
docker compose logs -f gaplex
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

If `web.enabled` wasn't set to `false`, also open `http://<docker-host>:4242`
and confirm the dashboard loads, shows a "Now playing" title, and that the
Skip button changes it. If the page loads but the "Now playing" title never
appears, that also points back at the ECONNREFUSED/yt-dlp checks above —
the dashboard only reflects Gaplex's own scheduler state, it doesn't add a
new failure mode of its own.

The installation is complete once step 6 shows a `Now playing` line, audio is
actually audible on the Icecast stream, and (if enabled) the dashboard loads.

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
  web/          Now-playing dashboard: HTTP server + static HTML/CSS/JS page
  ytdlp/        yt-dlp process invocation and output parsing
```

### The prefetch scheduler (`src/scheduler/prefetch-scheduler.ts`)

The scheduler tracks playback with its own clock, seeded from each track's
known duration — it does **not** poll Liquidsoap's actual playhead. When the
internal clock reaches the boundary, it just does local bookkeeping: hands
off to the already-queued track and starts the next clock from
`previous start time + previous duration`, not `Date.now()`, to avoid
drifting from tick-interval rounding.

It keeps exactly one track ahead resolved and queued at all times, and does
so immediately after every commit (`beginPrefetch()`, called right after
`commitPlayback()` at startup, at a normal boundary, and on a manual skip) —
not on a countdown threshold as an earlier version of this scheduler did.
There's no reason to wait: Gaplex pushes a Liquidsoap `process:` URI, not a
resolved stream URL (see `liquidsoap/telnet-client.ts`), so nothing sitting
in Liquidsoap's queue can go stale — the actual yt-dlp fetch happens fresh,
on Liquidsoap's side, at play time. Resolving immediately instead of near
the end just buys headroom (most of a track's duration to retry, instead of
a few seconds) and is also what lets the dashboard show an "up next" track
almost as soon as the current one starts, rather than only near its end.

If that resolution is still slow enough to still be in flight at the track
boundary (or failed every retry), there's a fallback in `advance()` that
waits for it, then resolves synchronously if it still came up empty — logged
as a warning, since this is the one path that can cause an audible gap.

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

A small `node:http` server (`server.ts`) serves the static page under
`public/` (`index.html`/`styles.css`/`app.js` — real files, not an inline
template string, so the browser-side script gets normal JS tooling) plus the
JSON API it polls/posts to: `GET /api/status` (current + next track, each
with a `thumbnailUrl`), `GET /api/config` (the configured default stream
URL), `POST /api/skip`. `public/` isn't `.ts`, so `tsc` never touches it;
`pnpm build` copies it into `dist/web/public` afterwards
(`scripts/copy-assets.mjs`) — `server.ts` resolves it relative to its own
compiled location so the same code works run from `src/` (`tsx`) or `dist/`.
It's excluded from the root ESLint config (`eslint.config.ts`) since it's
browser JS with browser globals, not part of the Node/TS ruleset.

The page embeds the actual Icecast stream in an `<audio>` element and tries
to autoplay it; the play/pause button only controls that local `<audio>`
element — it's a listening control, not a broadcast control. The progress
bar under the track title is informational, not a seek control: a live
Icecast stream has no seekable timeline, so it just visualizes the current
track's known elapsed/remaining time (from `PrefetchScheduler.getStatus()`),
interpolated client-side once a second between 4-second status polls so it
moves smoothly without polling that often. "Skip" is the only control that
reaches back into Liquidsoap.

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
