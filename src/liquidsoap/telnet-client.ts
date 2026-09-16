import type { LiquidsoapConfig } from '../config/types.js'
import type { Logger } from '../logger/logger.js'

import { connect } from 'node:net'

/** The two things needed to have Liquidsoap fetch a track's audio itself. */
export interface YtdlpQueueRequest {
  /** Canonical watch URL yt-dlp will resolve and download fresh. */
  videoUrl: string
  /** Container extension `-f bestaudio` will produce, e.g. "webm". */
  audioExt: string
}

/**
 * Minimal client for Liquidsoap's telnet/socket command server. Opens a
 * fresh connection per command instead of pooling one — commands are
 * infrequent (roughly once per track), so a persistent connection would add
 * reconnect/keepalive complexity for no real benefit here.
 */
export class LiquidsoapClient {
  constructor(
    private readonly config: LiquidsoapConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Pushes a request onto the named `request.queue` source's queue — not a
   * direct stream URL, but a `process:` URI that tells Liquidsoap to run
   * yt-dlp itself and treat its stdout-produced file as the audio source.
   *
   * Why: handing Liquidsoap a raw signed googlevideo.com URL made its
   * built-in HTTP client hang and time out against YouTube's CDN, even
   * though the exact same URL fetched instantly via curl or yt-dlp from the
   * same host. Routing the fetch through yt-dlp's own downloader (which is
   * what resolved the URL in the first place, and is battle-tested against
   * this CDN) sidesteps whatever Liquidsoap's client was tripping on — and
   * as a bonus, yt-dlp resolves fresh at play time, so there's no signed URL
   * sitting around that could expire before Liquidsoap gets to it.
   */
  async pushRequest(queueId: string, request: YtdlpQueueRequest): Promise<void> {
    const uri = this.buildProcessUri(request)
    const response = await this.sendCommand(`${queueId}.push ${uri}`)
    this.log.debug(`Liquidsoap response: ${response.trim() || '(empty)'}`)
  }

  /**
   * Builds a Liquidsoap `process:` protocol URI: `process:<extname>,<cmd>`.
   * Liquidsoap creates an empty temp file with the `.<extname>` extension,
   * substitutes `$(output)` in `<cmd>` with that file's path, runs `<cmd>`
   * via the shell, and (if it exits 0) plays the resulting file.
   *
   * One easy-to-miss rule (found in Liquidsoap's own source, not the
   * published docs, which don't mention it): the whole `process:` URI is
   * split on `:` first, to separate `<cmd>` from an optional trailing child
   * request. So any literal `:` inside our command — and our yt-dlp
   * command has one in `https://...` — has to be replaced with the literal
   * placeholder text `$(colon)`, which Liquidsoap substitutes back to `:`
   * right before running it. Skipping this would silently truncate the
   * command at "https" and leave Liquidsoap trying to run garbage.
   */
  /**
   * Ends the current track immediately via Liquidsoap's `<id>.skip` server
   * command (inherited by `request.queue` from the base source), moving on
   * to whatever's already sitting in the queue. If nothing's queued yet this
   * leaves dead air until the next `pushRequest` — callers should push a
   * replacement request before skipping, not after.
   */
  async skipCurrent(queueId: string): Promise<void> {
    const response = await this.sendCommand(`${queueId}.skip`)
    this.log.debug(`Liquidsoap response: ${response.trim() || '(empty)'}`)
  }

  private buildProcessUri({ videoUrl, audioExt }: YtdlpQueueRequest): string {
    const command = [
      this.config.ytdlpBinary,
      '-f',
      'bestaudio',
      '--no-continue',
      '--no-playlist',
      '-o',
      '$(output)',
      '--',
      shellQuoteSingle(videoUrl),
    ].join(' ')

    const escapedCommand = command.replaceAll(':', '$(colon)')
    return `process:timeout=${this.config.processTimeoutSec},${audioExt},${escapedCommand}`
  }

  private sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.config.host, port: this.config.port })
      let buffer = ''
      let settled = false

      const finish = (run: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        run()
      }

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `Timed out waiting for Liquidsoap at ${this.config.host}:${this.config.port}`,
            ),
          ),
        )
      }, this.config.commandTimeoutMs)

      socket.on('connect', () => {
        if (this.config.password) {
          socket.write(`${this.config.password}\n`)
        }
        socket.write(`${command}\n`)
        socket.write('quit\n')
      })

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8')
      })

      socket.on('end', () => finish(() => resolve(buffer)))

      socket.on('error', error => {
        finish(() =>
          reject(
            new Error(
              `Liquidsoap connection error (${this.config.host}:${this.config.port}): ${error.message}`,
            ),
          ),
        )
      })
    })
  }
}

/**
 * POSIX single-quote shell escaping (same approach as Liquidsoap's own
 * `process.quote`, which wraps `Filename.quote`): wrap in `'...'`, and turn
 * any embedded `'` into `'\''` (close the quote, an escaped literal quote,
 * reopen it). Video URLs never contain a `'`, but this stays correct even if
 * a title or future argument does.
 */
function shellQuoteSingle(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
