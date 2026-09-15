import type { LogLevel } from '../config/types.js'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Simple timestamped console logger, filtered by a minimum level. */
export class Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  debug(message: string): void {
    this.write('debug', message)
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return

    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`
    switch (level) {
      case 'debug':
        console.debug(line)
        break
      case 'info':
        console.info(line)
        break
      case 'warn':
        console.warn(line)
        break
      case 'error':
        console.error(line)
        break
    }
  }
}
