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

/**
 * Drives gapless playback.
 *
 * The actual gapless join is Liquidsoap's job: once a track's request is
 * sitting in its `request.queue`, Liquidsoap resolves/buffers it and starts
 * it the instant the current track ends, with no gap. This class's only
 * responsibility is making sure that request is queued well before that
 * moment — resolving too early risks the signed stream URL going stale,
 * resolving too late risks missing the deadline, so it's driven by an
 * internal clock (seeded from known durations, not polled from Liquidsoap)
 * checked on a regular tick.
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

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking || !this.playback) return
    this.ticking = true
    try {
      const elapsedSec = (Date.now() - this.playback.startedAtMs) / 1000
      const remainingSec = this.playback.track.durationSec - elapsedSec

      const shouldPrefetch =
        !this.prefetched &&
        !this.prefetchPromise &&
        remainingSec <= this.config.prefetchThresholdSec
      if (shouldPrefetch) {
        this.log.info(
          `"${this.playback.track.title}" has ~${Math.max(0, Math.round(remainingSec))}s left — prefetching next track`,
        )
        this.prefetchPromise = this.prefetchNext().finally(() => {
          this.prefetchPromise = null
        })
      }

      if (remainingSec <= 0) {
        await this.advance()
      }
    } finally {
      this.ticking = false
    }
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

  /** Called once the current track's known duration has elapsed. */
  private async advance(): Promise<void> {
    if (!this.playback) return
    const finished = this.playback.track
    const plannedStartMs = this.playback.startedAtMs + finished.durationSec * 1000

    // If a prefetch is already in flight, wait for it rather than starting a
    // second, redundant resolution.
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
