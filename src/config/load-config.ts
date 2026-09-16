import type { AppConfig, ConfigFileInput } from './types.js'

import { readFile, writeFile } from 'node:fs/promises'

import { parseCliArgs } from '../util/args.js'
import { errorMessage } from '../util/format.js'

const DEFAULT_CONFIG_PATH = 'config/config.json'

/** Defaults for everything except `playlistUrl`, which has no sane default. */
const DEFAULTS: Omit<AppConfig, 'playlistUrl'> = {
  loop: true,
  ytdlp: {
    binaryPath: 'yt-dlp',
    extraArgs: [],
    metadataTimeoutMs: 20_000,
    playlistTimeoutMs: 60_000,
  },
  retry: {
    maxAttempts: 4,
    initialDelayMs: 2_000,
    maxDelayMs: 20_000,
    backoffFactor: 2,
  },
  liquidsoap: {
    host: '127.0.0.1',
    port: 1234,
    password: null,
    queueId: 'queue',
    commandTimeoutMs: 5_000,
    ytdlpBinary: 'yt-dlp',
    processTimeoutSec: 120,
  },
  scheduler: {
    tickIntervalMs: 1_000,
  },
  web: {
    enabled: true,
    host: '0.0.0.0',
    port: 4242,
    radioStreamUrl: null,
  },
  logLevel: 'info',
}

/**
 * Loads and validates the app config: a JSON file merged with defaults, with
 * `--config`/`--playlist` CLI args applied on top. Returns `configPath`
 * alongside it so callers that later persist a live change (e.g. the
 * dashboard's playlist switch, see `persistPlaylistUrl`) write back to the
 * same file this was loaded from, `--config` override included.
 */
export async function loadConfig(argv: string[]) {
  const cli = parseCliArgs(argv)
  const configPath = cli.configPath ?? DEFAULT_CONFIG_PATH
  const fileInput = await readConfigFile(configPath)

  const merged: AppConfig = {
    playlistUrl: fileInput.playlistUrl ?? '',
    loop: fileInput.loop ?? DEFAULTS.loop,
    ytdlp: { ...DEFAULTS.ytdlp, ...fileInput.ytdlp },
    retry: { ...DEFAULTS.retry, ...fileInput.retry },
    liquidsoap: { ...DEFAULTS.liquidsoap, ...fileInput.liquidsoap },
    scheduler: { ...DEFAULTS.scheduler, ...fileInput.scheduler },
    web: { ...DEFAULTS.web, ...fileInput.web },
    logLevel: fileInput.logLevel ?? DEFAULTS.logLevel,
  }

  if (cli.playlistUrl) {
    merged.playlistUrl = cli.playlistUrl
  }

  validateConfig(merged)
  return { config: merged, configPath }
}

/**
 * Rewrites just `playlistUrl` in the config file at `configPath`, preserving
 * every other field — used so a dashboard playlist switch survives a
 * restart. Re-reads the file rather than reusing the already-parsed config
 * in memory, so it doesn't clobber other fields someone may have hand-edited
 * on disk since startup. Failure here (e.g. a read-only config mount) is the
 * caller's to decide how to report — this only throws, it doesn't log.
 */
export async function persistPlaylistUrl(configPath: string, playlistUrl: string) {
  let fileInput: ConfigFileInput
  try {
    fileInput = await readConfigFile(configPath)
  } catch (error) {
    throw new Error(`Could not read "${configPath}" to persist playlist: ${errorMessage(error)}`, {
      cause: error,
    })
  }

  fileInput.playlistUrl = playlistUrl

  try {
    await writeFile(configPath, `${JSON.stringify(fileInput, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new Error(`Could not write "${configPath}" to persist playlist: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

async function readConfigFile(path: string) {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as ConfigFileInput
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(
        `Config file not found at "${path}". Copy config/config.example.json to ` +
          'config/config.json and set your playlist URL, or pass --config <path>.',
        { cause: error },
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read config file "${path}": ${message}`, { cause: error })
  }
}

// eslint-disable-next-line no-restricted-syntax -- type predicate, can't be inferred
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function validateConfig(config: AppConfig) {
  const problems: string[] = []

  if (!config.playlistUrl) {
    problems.push('playlistUrl is required (set it in the config file or pass --playlist <url>)')
  } else if (!/^https?:\/\//.test(config.playlistUrl)) {
    problems.push(`playlistUrl does not look like a URL: "${config.playlistUrl}"`)
  }
  if (config.retry.maxAttempts < 1) {
    problems.push('retry.maxAttempts must be at least 1')
  }
  if (config.liquidsoap.port <= 0 || config.liquidsoap.port > 65_535) {
    problems.push(`liquidsoap.port is out of range: ${config.liquidsoap.port}`)
  }
  if (!config.liquidsoap.ytdlpBinary) {
    problems.push('liquidsoap.ytdlpBinary must not be empty')
  }
  if (config.liquidsoap.processTimeoutSec <= 0) {
    problems.push('liquidsoap.processTimeoutSec must be greater than 0')
  }
  if (config.scheduler.tickIntervalMs <= 0) {
    problems.push('scheduler.tickIntervalMs must be greater than 0')
  }
  if (config.web.port <= 0 || config.web.port > 65_535) {
    problems.push(`web.port is out of range: ${config.web.port}`)
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
}
