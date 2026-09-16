/** A single entry from the source playlist, before its stream has been resolved. */
export interface PlaylistEntry {
  /** YouTube video id, e.g. "dQw4w9WgXcQ". */
  id: string
  title: string
  /** Canonical watch URL, used to re-resolve full metadata via yt-dlp. */
  url: string
}

/**
 * Fully resolved track, ready to hand to Liquidsoap.
 *
 * Deliberately does NOT carry a direct/signed stream URL: Liquidsoap fetches
 * the audio itself, at play time, by re-invoking yt-dlp as a subprocess (see
 * `liquidsoap/telnet-client.ts`). This sidesteps two problems in one move —
 * Liquidsoap's own HTTP client was found to hang against YouTube's CDN, and
 * a signed URL resolved here could otherwise go stale before it's played.
 */
export interface TrackMetadata {
  id: string
  title: string
  durationSec: number
  /** Canonical watch URL — what Liquidsoap's yt-dlp subprocess will fetch. */
  videoUrl: string
  /** Audio container extension `-f bestaudio` will produce (e.g. "webm",
   *  "m4a") — Liquidsoap needs this upfront to name its output file before
   *  running the download command. */
  audioExt: string
  /** Thumbnail URL yt-dlp reported, if any — cosmetic only (dashboard art). */
  thumbnailUrl: string | null
  /** When this metadata was resolved (epoch ms), for debugging/logging. */
  resolvedAt: number
}
