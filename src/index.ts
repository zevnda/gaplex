import { loadConfig } from './config/load-config.js'
import { LiquidsoapClient } from './liquidsoap/telnet-client.js'
import { Logger } from './logger/logger.js'
import { PlaylistManager } from './playlist/playlist-manager.js'
import { PrefetchScheduler } from './scheduler/prefetch-scheduler.js'
import { errorMessage } from './util/format.js'
import { startWebServer } from './web/server.js'
import { fetchPlaylistEntries } from './ytdlp/client.js'

async function main() {
  const config = await loadConfig(process.argv.slice(2))
  const log = new Logger(config.logLevel)

  log.info(`Loading playlist: ${config.playlistUrl}`)
  const entries = await fetchPlaylistEntries(config.playlistUrl, config.ytdlp, log)
  if (entries.length === 0) {
    throw new Error('Playlist contained no available tracks')
  }
  log.info(`Loaded ${entries.length} track(s) from playlist (loop: ${config.loop})`)

  const playlist = new PlaylistManager(entries, config.loop)
  const liquidsoap = new LiquidsoapClient(config.liquidsoap, log)
  const scheduler = new PrefetchScheduler(playlist, liquidsoap, config, log)
  const webServer = config.web.enabled ? await startWebServer(config, scheduler, log) : null

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down`)
    scheduler.stop()
    webServer?.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await scheduler.start()
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${errorMessage(error)}`)
  process.exitCode = 1
})
