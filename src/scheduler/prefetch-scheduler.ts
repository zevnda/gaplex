import type { AppConfig } from '../config/types.js'
import type { LiquidsoapClient } from '../liquidsoap/telnet-client.js'
import type { Logger } from '../logger/logger.js'
import type { PlaylistManager } from '../playlist/playlist-manager.js'
import type { PlaylistEntry, TrackMetadata } from '../types/track.js'

import { errorMessage, formatDuration } from '../util/format.js'
import { withRetry } from '../util/retry.js'
import { fetchTrackDetails } from '../ytdlp/client.js'

interface CurrentPlayback {
  track: TrackMetadata
  /** When this track is believed to have started, epoch ms. */
  startedAtMs: number
}

export interface PlaybackStatusTrack {
  title: string
  durationSec: number
  thumbnailUrl: string | null
}

export interface PlaybackStatus {
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
 */
export class PrefetchScheduler {
  private playback: CurrentPlayback | null = null
  private prefetched: TrackMetadata | null = null
  private prefetchPromise: Promise<void> | null = null
  private tickHandle: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = false

  constructor(
    private readonly playlist: PlaylistManager,
    private readonly liquidsoap: LiquidsoapClient,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    const firstTrack = await this.resolveNextPlayable(() => this.playlist.peekFirst())
    if (!firstTrack) {
      throw new Error('No playable tracks found in the playlist')
    }

    await this.liquidsoap.pushRequest(this.config.liquidsoap.queueId, {
      videoUrl: firstTrack.videoUrl,
      audioExt: firstTrack.audioExt,
    })
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
    if (!this.playback) return { current: null, next: null }

    return {
      current: {
        title: this.playback.track.title,
        durationSec: this.playback.track.durationSec,
        thumbnailUrl: this.playback.track.thumbnailUrl,
        elapsedSec: Math.max(0, (Date.now() - this.playback.startedAtMs) / 1000),
      },
      next: this.prefetched
        ? {
            title: this.prefetched.title,
            durationSec: this.prefetched.durationSec,
            thumbnailUrl: this.prefetched.thumbnailUrl,
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
