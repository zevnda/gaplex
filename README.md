# Gaplex

Gaplex provides gapless internet radio from a YouTube Music playlist. Gaplex resolves each track with `yt-dlp` and keeps Liquidsoap's queue fed just ahead of time, so tracks play back-to-back with no dead air.

> [!NOTE]
> This is the scheduler only. It assumes Icecast and Liquidsoap are already running and just tells Liquidsoap what to play next.

## Installation

Both options below use an AI coding agent (Claude Code, Cursor, or similar). Fill in your own values before pasting either prompt in.

### Have your agent do it for you

```
Clone https://github.com/zevnda/gaplex.git and follow the installation
steps in AGENTS.md to set it up and run it, start to finish.

My YouTube Music playlist URL: <paste here>
My Liquidsoap telnet host and port: <e.g. 127.0.0.1:1234>
My Liquidsoap request.queue id: <e.g. gaplex_queue, or leave blank to use that default>
```

### Have your agent walk you through it

```
Clone https://github.com/zevnda/gaplex.git and read AGENTS.md. Don't run
the installation steps yourself. Instead, walk me through them one at a
time in plain language: explain what each step does and why, give me the
exact command to run myself, wait for me to confirm it worked, then move
on to the next step.

My YouTube Music playlist URL: <paste here>
My Liquidsoap telnet host and port: <e.g. 127.0.0.1:1234>
My Liquidsoap request.queue id: <e.g. gaplex_queue, or leave blank to use that default>
```

If you leave a value blank, the agent will ask you for it before continuing rather than guessing.

## License

[MIT](LICENSE)
