export interface RetryConfig {
  /** Total attempts before giving up on a track, including the first try. */
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  /** Multiplier applied to the delay after each failed attempt. */
  backoffFactor: number
}

export interface YtdlpConfig {
  /** Path to the yt-dlp binary, or just "yt-dlp" if it's on PATH. */
  binaryPath: string
  /** Extra CLI args appended to every yt-dlp invocation (e.g. cookies, proxy). */
  extraArgs: string[]
  /** Timeout for resolving a single track's metadata + stream URL. */
  metadataTimeoutMs: number
  /** Timeout for the initial playlist listing, which can be much larger. */
  playlistTimeoutMs: number
}

export interface LiquidsoapConfig {
  host: string
  port: number
  /** Sent as the first line of each connection if set; most stock Liquidsoap
   *  telnet servers have no auth, so this only matters if yours does. */
  password: string | null
  /** Name of the `request.queue` source in your Liquidsoap script. */
  queueId: string
  /** Timeout for the telnet round-trip of a single command (push/response). */
  commandTimeoutMs: number
  /**
   * Path to the yt-dlp binary as seen *inside the Liquidsoap container* —
   * this is a separate machine/filesystem from the one running Gaplex, and
   * needs its own yt-dlp (+ Deno) install. See AGENTS.md "Installation".
   */
  ytdlpBinary: string
  /**
   * How long Liquidsoap will let the yt-dlp subprocess it spawns run before
   * killing it, via the `process:` protocol's own `timeout=` argument. This
   * has to cover a full track download (not just metadata resolution), so
   * it's deliberately generous.
   */
  processTimeoutSec: number
}

export interface SchedulerConfig {
  /** How often the internal playback clock is checked, in ms. */
  tickIntervalMs: number
}

export interface WebConfig {
  /** Serves the now-playing dashboard when true. */
  enabled: boolean
  host: string
  port: number
  /**
   * Default Icecast (or other) stream URL the dashboard embeds and autoplays.
   * This is only a starting value — every listener's browser is reachable at
   * a different address than wherever Gaplex itself runs, so the dashboard
   * lets each visitor override it, stored in that browser's localStorage.
   * Leave null if you'd rather every visitor enter their own.
   */
  radioStreamUrl: string | null
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AppConfig {
  playlistUrl: string
  /** Restart from the beginning once the playlist ends. */
  loop: boolean
  /** Seconds of remaining playback at which the next track is prefetched. */
  prefetchThresholdSec: number
  ytdlp: YtdlpConfig
  retry: RetryConfig
  liquidsoap: LiquidsoapConfig
  scheduler: SchedulerConfig
  web: WebConfig
  logLevel: LogLevel
}

/** Shape of the user-provided JSON config file — every field optional, merged onto defaults. */
export interface ConfigFileInput {
  playlistUrl?: string
  loop?: boolean
  prefetchThresholdSec?: number
  ytdlp?: Partial<YtdlpConfig>
  retry?: Partial<RetryConfig>
  liquidsoap?: Partial<LiquidsoapConfig>
  scheduler?: Partial<SchedulerConfig>
  web?: Partial<WebConfig>
  logLevel?: LogLevel
}
