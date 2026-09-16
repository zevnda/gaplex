import type { YtdlpConfig } from '../config/types.js'
import type { Logger } from '../logger/logger.js'
import type { PlaylistEntry, TrackMetadata } from '../types/track.js'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * We shell out to the yt-dlp binary rather than using a Node wrapper package.
 * yt-dlp ships frequent releases to keep up with YouTube's anti-bot changes,
 * and wrapper packages tend to lag behind — invoking the CLI directly means
 * `pip install -U yt-dlp` (or swapping the binary) is all that's needed to
 * pick up a fix, with no dependency on a wrapper being updated in turn.
 */

interface FlatPlaylistEntryRaw {
  id?: string
  title?: string
}

interface VideoInfoRaw {
  id?: string
  title?: string
  duration?: number
  /** Container extension of the resolved format, e.g. "webm", "m4a". */
  ext?: string
  thumbnail?: string
}

/**
 * Lists a playlist's entries without resolving each video's formats
 * (`--flat-playlist` keeps this fast even for large playlists). Unavailable
 * or errored entries are skipped and logged rather than failing the whole
 * listing — `--ignore-errors` lets yt-dlp keep going past them.
 */
export async function fetchPlaylistEntries(playlistUrl: string, config: YtdlpConfig, log: Logger) {
  const args = [
    '-j',
    '--flat-playlist',
    '--ignore-errors',
    '--no-warnings',
    ...config.extraArgs,
    playlistUrl,
  ]
  const { stdout, stderr } = await runYtdlp(config.binaryPath, args, config.playlistTimeoutMs)

  logStderrWarnings(stderr, log)

  const entries: PlaylistEntry[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let raw: FlatPlaylistEntryRaw
    try {
      raw = JSON.parse(trimmed) as FlatPlaylistEntryRaw
    } catch {
      log.warn(`Skipping unparseable playlist entry: ${trimmed.slice(0, 120)}`)
      continue
    }

    if (!raw.id) {
      log.warn('Skipping playlist entry with no video id (likely unavailable)')
      continue
    }

    entries.push({
      id: raw.id,
      title: raw.title ?? raw.id,
      url: `https://www.youtube.com/watch?v=${raw.id}`,
    })
  }

  return entries
}

/**
 * Resolves a single track's duration, title, and the audio container
 * extension `-f bestaudio` would produce for it (e.g. "webm", "m4a").
 *
 * This does NOT download anything or return a stream URL — it's `-j` only
 * (metadata dump). Liquidsoap does the actual audio fetch itself, as a
 * yt-dlp subprocess, right before playback (see `liquidsoap/telnet-client.ts`
 * for why: its built-in HTTP client was found to hang against YouTube's CDN,
 * even though the same URLs work fine via curl or yt-dlp's own downloader).
 * We still resolve `-f bestaudio` here first because it's the cheapest way
 * to learn the real output extension ahead of time — without it, Liquidsoap
 * would need a second yt-dlp round-trip just to probe that.
 */
export async function fetchTrackDetails(entry: PlaylistEntry, config: YtdlpConfig) {
  const args = [
    '-j',
    '-f',
    'bestaudio',
    '--no-playlist',
    '--no-warnings',
    ...config.extraArgs,
    entry.url,
  ]
  const { stdout } = await runYtdlp(config.binaryPath, args, config.metadataTimeoutMs)

  const lastLine = stdout.trim().split('\n').pop()
  if (!lastLine) {
    throw new Error(`yt-dlp produced no output for "${entry.title}" (${entry.id})`)
  }

  const raw = JSON.parse(lastLine) as VideoInfoRaw
  if (!raw.ext) {
    throw new Error(`yt-dlp did not return a format extension for "${entry.title}" (${entry.id})`)
  }
  if (typeof raw.duration !== 'number' || raw.duration <= 0) {
    throw new Error(`yt-dlp did not return a valid duration for "${entry.title}" (${entry.id})`)
  }

  const track: TrackMetadata = {
    id: entry.id,
    title: raw.title || entry.title,
    durationSec: raw.duration,
    videoUrl: entry.url,
    audioExt: raw.ext,
    thumbnailUrl: raw.thumbnail ?? null,
    resolvedAt: Date.now(),
  }
  return track
}

async function runYtdlp(binaryPath: string, args: string[], timeoutMs: number) {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      killSignal: 'SIGKILL',
    })
    return { stdout, stderr }
  } catch (error) {
    throw describeYtdlpFailure(error, binaryPath, args)
  }
}

interface ExecFileError extends Error {
  code?: string | number
  killed?: boolean
  stderr?: string | Buffer
}

function describeYtdlpFailure(error: unknown, binaryPath: string, args: string[]) {
  if (!(error instanceof Error)) {
    return new Error(String(error))
  }

  const command = `${binaryPath} ${args.join(' ')}`
  const execError = error as ExecFileError

  if (execError.code === 'ENOENT') {
    return new Error(`yt-dlp binary not found ("${binaryPath}"). Is it installed and on PATH?`)
  }
  if (execError.killed) {
    return new Error(`yt-dlp timed out after ${command}`)
  }

  const stderrTail = execError.stderr?.toString().trim().split('\n').slice(-5).join('\n')
  return new Error(
    `yt-dlp failed (${command})${stderrTail ? `: ${stderrTail}` : `: ${error.message}`}`,
  )
}

function logStderrWarnings(stderr: string, log: Logger) {
  const trimmed = stderr.trim()
  if (!trimmed) return
  for (const line of trimmed.split('\n')) {
    log.warn(`yt-dlp: ${line}`)
  }
}
