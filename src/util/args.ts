export interface CliArgs {
  configPath?: string
  playlistUrl?: string
}

/** Tiny hand-rolled parser for our two flags — not worth a dependency. */
export function parseCliArgs(argv: string[]) {
  const args: CliArgs = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config' || arg === '-c') {
      args.configPath = argv[i + 1]
      i += 1
    } else if (arg === '--playlist' || arg === '-p') {
      args.playlistUrl = argv[i + 1]
      i += 1
    }
  }

  return args
}
