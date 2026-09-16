import type { AppConfig } from '../config/types.js'
import type { LiquidsoapClient } from '../liquidsoap/telnet-client.js'
import type { Logger } from '../logger/logger.js'
import type { PlaylistManager } from '../playlist/playlist-manager.js'
import type { PlaylistEntry, TrackMetadata } from '../types/track.js'

import { persistPlaylistUrl } from '../config/load-config.js'
import { errorMessage, formatDuration } from '../util/format.js'
import { withRetry } from '../util/retry.js'
import { fetchPlaylistEntries, fetchTrackDetails } from '../ytdlp/client.js'

/**
 * Cap on `pushedQueue` (below). Under normal operation it holds 0-2 entries
 * — this only matters if `on_track` was never wired up on the Liquidsoap
 * side, in which case nothing ever shifts it and it would otherwise grow by
 * one small object per track for as long as this daemon runs. Oldest
 * entries are dropped past this; harmless, since a webhook this far behind
 * would already be well into "stale, ignore it" territory anyway (see
 * `handleTrackStarted()`).
 */
const MAX_PUSHED_QUEUE = 8

interface CurrentPlayback {
  track: TrackMetadata
  /** When this track is believed to have started, epoch ms. */
  startedAtMs: number
}

export interface PlaybackStatusTrack {
  title: string
  artist: string | null
  durationSec: number
  thumbnailUrl: string | null
  /** Canonical watch URL — the dashboard links the track title to this. */
  videoUrl: string
}

export interface PlaybackStatus {
  playlistUrl: string
  current: (PlaybackStatusTrack & { elapsedSec: number }) | null
  next: PlaybackStatusTrack | null
}

/**
 * Drives gapless playback.
 *
 * The actual gapless join is Liquidsoap's job: once a track's request is
 * sitting in its `request.queue`, Liquidsoap resolves/buffers it and starts
 * it the instant the current track ends, with no gap. This class's only
 * responsibility is keeping exactly one track ahead resolved and queued at
 * all times.
 *
 * That "one ahead, always" invariant is maintained the same way in every
 * case — right after a track is committed as current (at startup, at a
 * normal boundary, or on a manual skip), the *next* one is immediately
 * resolved and pushed, rather than waiting until the current track is
 * nearly over. There's no downside to doing it this early: Gaplex pushes a
 * Liquidsoap `process:` URI, not a resolved stream URL (see
 * `liquidsoap/telnet-client.ts`), so nothing here can go stale sitting in
 * Liquidsoap's queue for a while — the actual yt-dlp fetch happens fresh,
 * on Liquidsoap's side, at play time. Resolving early only buys headroom:
 * a whole track's worth of time to retry if the next track's metadata
 * lookup is slow or fails, instead of the few seconds a threshold-based
 * prefetch would leave. It's also the only way the dashboard can reliably
 * show an "up next" track — that information now exists almost as soon as
 * the current one starts, not only near its end.
 *
 * "Current track" bookkeeping has two independent sources that both feed
 * `this.playback`, and are designed to coexist without conflict rather than
 * one replacing the other:
 *
 * - The clock (`tick()`/`advance()`, above): always runs, seeded from each
 *   track's *known* duration, not polled from Liquidsoap. This alone is
 *   enough to keep playback moving even if nothing on the Liquidsoap side
 *   is configured to call back.
 * - `handleTrackStarted()`: an optional webhook Liquidsoap can be scripted
 *   to call (via `on_track` + `http.post`, see AGENTS.md Installation step
 *   4) the instant it genuinely starts a track. When wired up, this is
 *   authoritative and typically fires *before* the clock would have —
 *   `elapsedSec` gets resynced to the real start time on every track
 *   instead of drifting further with each guess, which is what actually
 *   fixes both "the dashboard doesn't know what Liquidsoap is really
 *   playing" and "elapsed time is wrong after enough tracks/a while." If
 *   nothing calls it, it just never fires and the clock alone still works
 *   exactly as before — this is additive, not a replacement.
 *
 * Both paths funnel through `commitPlayback()`, and `handleTrackStarted()`
 * cross-checks against `pushedQueue` before trusting a confirmation, so
 * whichever one notices a transition first "wins" and the other becomes a
 * harmless no-op (a resync, not a double-advance) — see that method's own
 * comment for exactly how.
 */
export class PrefetchScheduler {
  private playback: CurrentPlayback | null = null
  private prefetched: TrackMetadata | null = null
  private prefetchPromise: Promise<void> | null = null
  private tickHandle: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = false
  private currentPlaylistUrl: string
  /**
   * FIFO of tracks pushed to Liquidsoap whose `on_track` confirmation
   * hasn't arrived yet. Liquidsoap's `request.queue` consumes requests in
   * the exact order they were pushed (confirmed against `request.liq`'s
   * `next()`), and `on_track` fires in that same real order, so shifting
   * this on each webhook call is a reliable way to know *which* track just
   * started without needing to smuggle an id through Liquidsoap's metadata.
   */
  private pushedQueue: TrackMetadata[] = []

  constructor(
    private readonly playlist: PlaylistManager,
    private readonly liquidsoap: LiquidsoapClient,
    private readonly config: AppConfig,
    private readonly log: Logger,
    /** Where `config` was loaded from — a playlist switch writes back here. */
    private readonly configPath: string,
  ) {
    this.currentPlaylistUrl = config.playlistUrl
  }

  async start(): Promise<void> {
    const firstTrack = await this.resolveNextPlayable(() => this.playlist.peekFirst())
    if (!firstTrack) {
      throw new Error('No playable tracks found in the playlist')
    }

    await this.liquidsoap.pushRequest(this.config.liquidsoap.queueId, {
      videoUrl: firstTrack.videoUrl,
      audioExt: firstTrack.audioExt,
    })
    this.trackPushed(firstTrack)
    this.commitPlayback(firstTrack, Date.now())
    this.beginPrefetch()

    this.tickHandle = setInterval(() => {
      this.tick().catch(error => this.log.error(`Scheduler tick failed: ${errorMessage(error)}`))
    }, this.config.scheduler.tickIntervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.tickHandle) {
      clearInterval(this.tickHandle)
      this.tickHandle = null
    }
  }

  /** Snapshot of what's currently playing and what's queued next, for the dashboard. */
  getStatus(): PlaybackStatus {
    if (!this.playback) return { playlistUrl: this.currentPlaylistUrl, current: null, next: null }

    return {
      playlistUrl: this.currentPlaylistUrl,
      current: {
        title: this.playback.track.title,
        artist: this.playback.track.artist,
        durationSec: this.playback.track.durationSec,
        thumbnailUrl: this.playback.track.thumbnailUrl,
        videoUrl: this.playback.track.videoUrl,
        elapsedSec: Math.max(0, (Date.now() - this.playback.startedAtMs) / 1000),
      },
      next: this.prefetched
        ? {
            title: this.prefetched.title,
            artist: this.prefetched.artist,
            durationSec: this.prefetched.durationSec,
            thumbnailUrl: this.prefetched.thumbnailUrl,
            videoUrl: this.prefetched.videoUrl,
          }
        : null,
    }
  }

  /**
   * Manually ends the current track right now (dashboard "skip" button).
   * Makes sure a replacement is queued in Liquidsoap *before* sending the
   * skip command — skipping first would leave dead air if nothing was
   * prefetched yet, same failure mode as a late automatic advance.
   */
  async skip(): Promise<void> {
    if (this.stopped || !this.playback || this.ticking) return
    this.ticking = true
    try {
      if (this.prefetchPromise) {
        await this.prefetchPromise
      }
      if (!this.prefetched) {
        await this.prefetchNext()
      }
      if (!this.prefetched) {
        this.log.error('Skip requested but no playable track is queued — ignoring')
        return
      }

      await this.liquidsoap.skipCurrent(this.config.liquidsoap.queueId)
      this.commitPlayback(this.prefetched, Date.now())
      this.beginPrefetch()
    } finally {
      this.ticking = false
    }
  }

  /**
   * Liquidsoap confirming (via the dashboard's `POST
   * /api/liquidsoap/track-started` webhook — see this class's own doc
   * comment, and AGENTS.md Installation step 4 for the Liquidsoap-side
   * `on_track` script) that a track *genuinely* just started. The request
   * carries no payload identifying which one; `pushedQueue`'s FIFO order
   * does that instead (see its own comment).
   *
   * Three outcomes, depending on how the confirmed track relates to what
   * this scheduler already believes:
   *
   * 1. It matches `this.playback` (the clock already advanced here, and
   *    this is just confirming it) — resync `startedAtMs` to the real
   *    value and stop; nothing else changed, so nothing else should move.
   * 2. It matches `this.prefetched` (the clock hasn't caught up yet — the
   *    normal case, and the whole reason this exists) — commit it as
   *    current for real, right now, instead of waiting for the clock.
   * 3. Neither — a stale confirmation for a track that's already been
   *    superseded (e.g. arrived late after a skip or playlist switch).
   *    Committing it would *rewind* playback state, which is worse than
   *    just dropping it: the clock already has the real current track
   *    covered.
   */
  handleTrackStarted(): void {
    const started = this.pushedQueue.shift()
    if (!started) {
      this.log.warn('Liquidsoap reported a track start, but nothing was pending — ignoring')
      return
    }

    if (this.playback && this.playback.track.id === started.id) {
      this.playback.startedAtMs = Date.now()
      this.log.debug(`Liquidsoap confirmed "${started.title}" — resynced start time`)
      return
    }

    if (this.prefetched && this.prefetched.id === started.id) {
      this.commitPlayback(started, Date.now())
      this.beginPrefetch()
      return
    }

    this.log.warn(
      `Liquidsoap confirmed "${started.title}" started, but it no longer matches local ` +
        'state (a stale confirmation, likely after a skip or playlist switch) — ignoring',
    )
  }

  /**
   * Dashboard "switch playlist": resolves the new playlist's entries, flushes
   * whatever was already queued from the *old* one out of Liquidsoap
   * (`LiquidsoapClient.flushQueue` — removes only what's still pending, never
   * whatever's actively playing), and swaps the new entries into the live
   * `PlaylistManager`. Whatever's playing right now keeps playing —
   * interrupting live audio just to switch a moment sooner isn't worth it —
   * but nothing else from the old playlist gets a chance to play after it:
   * the very next track is pulled from the new one.
   *
   * If a prefetch from the old playlist was still in flight when this was
   * called, it's awaited first rather than left to race the flush below —
   * otherwise it could finish and push its (stale) result *after* the flush,
   * putting old-playlist content right back in the queue.
   *
   * Also persists the new URL to `config/config.json` (`persistPlaylistUrl`)
   * so it survives a restart — but that's a separate concern from the switch
   * itself, and this is a personal radio config file, not something to leave
   * silently out of sync: a failed write (read-only mount, permissions) is
   * reported back via `persisted: false` rather than failing the whole
   * switch, which already took effect live regardless.
   */
  async switchPlaylist(playlistUrl: string): Promise<{ trackCount: number; persisted: boolean }> {
    const entries = await fetchPlaylistEntries(playlistUrl, this.config.ytdlp, this.log)
    if (entries.length === 0) {
      throw new Error('Playlist contained no available tracks')
    }

    if (this.prefetchPromise) {
      await this.prefetchPromise
    }
    await this.liquidsoap.flushQueue(this.config.liquidsoap.queueId)
    this.prefetched = null
    // Mirrors the flush: anything still waiting on a confirmation from the
    // old playlist just got removed from Liquidsoap's real queue, so it'll
    // never arrive. (In the rare case a track was still "current" but not
    // yet confirmed at this exact instant, its confirmation is simply lost
    // — harmless, `handleTrackStarted()` just won't get to resync that one
    // track's elapsed time; the clock still has it covered.)
    this.pushedQueue = []

    this.playlist.replaceEntries(entries)
    this.currentPlaylistUrl = playlistUrl
    this.log.info(`Switched playlist to ${playlistUrl} (${entries.length} track(s))`)

    this.beginPrefetch()
    if (this.prefetchPromise) {
      await this.prefetchPromise
    }

    let persisted = true
    try {
      await persistPlaylistUrl(this.configPath, playlistUrl)
    } catch (error) {
      persisted = false
      this.log.warn(
        `Playlist switched live, but couldn't save it to "${this.configPath}" — ` +
          `a restart will revert to the old one: ${errorMessage(error)}`,
      )
    }

    return { trackCount: entries.length, persisted }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking || !this.playback) return
    this.ticking = true
    try {
      const elapsedSec = (Date.now() - this.playback.startedAtMs) / 1000
      const remainingSec = this.playback.track.durationSec - elapsedSec

      if (remainingSec <= 0) {
        await this.advance()
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Kicks off resolving+queuing whatever comes after the current track, if
   * that isn't already done or already in flight. Fire-and-forget: callers
   * that need to know it's finished (`advance`, `skip`) await
   * `this.prefetchPromise` instead of this method's own return value.
   */
  private beginPrefetch(): void {
    if (this.prefetched || this.prefetchPromise) return
    this.prefetchPromise = this.prefetchNext().finally(() => {
      this.prefetchPromise = null
    })
  }

  /** Resolves the next track and pushes it into Liquidsoap's queue ahead of time. */
  private async prefetchNext(): Promise<void> {
    const next = await this.resolveNextPlayable(() => this.playlist.peekNext())
    if (!next) {
      this.log.warn('No next track to prefetch (end of playlist reached)')
      return
    }

    try {
      await this.liquidsoap.pushRequest(this.config.liquidsoap.queueId, {
        videoUrl: next.videoUrl,
        audioExt: next.audioExt,
      })
    } catch (error) {
      this.log.error(`Failed to queue "${next.title}" in Liquidsoap: ${errorMessage(error)}`)
      return
    }

    this.trackPushed(next)
    this.prefetched = next
    this.log.info(`Queued next: "${next.title}" (${formatDuration(next.durationSec)})`)
  }

  /**
   * Called once the current track's known duration has elapsed. Under normal
   * operation `this.prefetched` is already populated — it was resolved right
   * after the current track started, not near its end — so this is usually
   * just local bookkeeping. The wait/fallback below only matters if that
   * resolution was unusually slow (retries eating a whole track's buffer) or
   * still failed after every retry.
   */
  private async advance(): Promise<void> {
    if (!this.playback) return
    const finished = this.playback.track
    const plannedStartMs = this.playback.startedAtMs + finished.durationSec * 1000

    if (this.prefetchPromise) {
      await this.prefetchPromise
    }

    if (!this.prefetched) {
      this.log.warn(
        `Next track wasn't queued in time after "${finished.title}" ended — ` +
          'resolving now (this may cause an audible gap)',
      )
      await this.prefetchNext()
    }

    if (!this.prefetched) {
      this.log.error('No playable track available — stopping')
      this.stop()
      return
    }

    this.commitPlayback(this.prefetched, plannedStartMs)
    this.beginPrefetch()
  }

  private trackPushed(track: TrackMetadata): void {
    this.pushedQueue.push(track)
    if (this.pushedQueue.length > MAX_PUSHED_QUEUE) {
      this.pushedQueue.splice(0, this.pushedQueue.length - MAX_PUSHED_QUEUE)
    }
  }

  private commitPlayback(track: TrackMetadata, startedAtMs: number): void {
    this.playlist.commitCurrent(track.id)
    this.playback = { track, startedAtMs }
    this.prefetched = null
    this.log.info(`Now playing: "${track.title}" (${formatDuration(track.durationSec)})`)
  }

  /**
   * Resolves entries yielded by `peekFn` (with retry+backoff) until one
   * succeeds. Any entry that fails every retry is permanently dropped from
   * the playlist so it isn't retried again on the next loop.
   */
  private async resolveNextPlayable(
    peekFn: () => PlaylistEntry | undefined,
  ): Promise<TrackMetadata | null> {
    const attemptBudget = Math.max(this.playlist.size, 1)

    for (let i = 0; i < attemptBudget; i += 1) {
      const entry = peekFn()
      if (!entry) return null

      try {
        return await withRetry(() => fetchTrackDetails(entry, this.config.ytdlp), {
          ...this.config.retry,
          onRetry: (attempt, error, nextDelayMs) =>
            this.log.warn(
              `Retry ${attempt}/${this.config.retry.maxAttempts - 1} for "${entry.title}": ` +
                `${errorMessage(error)} (next attempt in ${Math.round(nextDelayMs)}ms)`,
            ),
        })
      } catch (error) {
        this.log.error(
          `Giving up on "${entry.title}" (${entry.id}) after ${this.config.retry.maxAttempts} ` +
            `attempt(s): ${errorMessage(error)}`,
        )
        this.playlist.dropEntry(entry.id)
      }
    }

    this.log.error('Exhausted the entire playlist without finding a playable track')
    return null
  }
}
