import type { AppConfig } from '../config/types.js'
import type { Logger } from '../logger/logger.js'
import type { PrefetchScheduler } from '../scheduler/prefetch-scheduler.js'
import type { ServerResponse } from 'node:http'

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorMessage } from '../util/format.js'

/**
 * Static assets live as real `.html`/`.css`/`.js` files under `public/`
 * rather than an inline template string — easier to edit than a giant JS
 * string, and a browser-side script gets syntax highlighting/linting as
 * actual JS. `tsc` doesn't copy non-`.ts` files (see tsconfig.json
 * `rootDir`/`outDir`), so `pnpm build` copies this directory into `dist/web`
 * afterwards (see `scripts/copy-assets.mjs`) — resolving it relative to
 * *this* compiled module's own directory means the same code finds the
 * right copy whether it's running from `src/` (via `tsx`) or `dist/`.
 */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public')

const STATIC_ASSETS: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
}

/**
 * Serves the now-playing dashboard: the static page/assets above, plus the
 * small JSON API it polls (`/api/status`, `/api/config`) and posts to
 * (`/api/skip`). Kept as a plain `node:http` server rather than pulling in a
 * framework — a handful of fixed routes don't need one.
 */
export async function startWebServer(config: AppConfig, scheduler: PrefetchScheduler, log: Logger) {
  const assets = new Map<string, { body: string; contentType: string }>()
  for (const [route, { file, contentType }] of Object.entries(STATIC_ASSETS)) {
    const body = await readFile(join(PUBLIC_DIR, file), 'utf8')
    assets.set(route, { body, contentType })
  }

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    const asset = method === 'GET' ? assets.get(url) : undefined
    if (asset) {
      res.writeHead(200, { 'content-type': asset.contentType })
      res.end(asset.body)
      return
    }

    if (method === 'GET' && url === '/api/config') {
      sendJson(res, 200, { radioStreamUrl: config.web.radioStreamUrl })
      return
    }

    if (method === 'GET' && url === '/api/status') {
      sendJson(res, 200, scheduler.getStatus())
      return
    }

    if (method === 'POST' && url === '/api/skip') {
      scheduler
        .skip()
        .then(() => sendJson(res, 200, { ok: true }))
        .catch(error => {
          log.error(`Dashboard skip request failed: ${errorMessage(error)}`)
          sendJson(res, 500, { ok: false, error: errorMessage(error) })
        })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  })

  server.on('error', error => log.error(`Web server error: ${errorMessage(error)}`))
  server.listen(config.web.port, config.web.host, () => {
    log.info(`Dashboard listening on http://${config.web.host}:${config.web.port}`)
  })

  return server
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
