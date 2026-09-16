import type { AppConfig } from '../config/types.js'
import type { Logger } from '../logger/logger.js'
import type { PrefetchScheduler } from '../scheduler/prefetch-scheduler.js'
import type { ServerResponse } from 'node:http'

import { createServer } from 'node:http'

import { errorMessage } from '../util/format.js'
import { DASHBOARD_HTML } from './dashboard-page.js'

/**
 * Serves the now-playing dashboard: the page itself, plus the small JSON API
 * it polls (`/api/status`, `/api/config`) and posts to (`/api/skip`). Kept as
 * a plain `node:http` server rather than pulling in a framework — three
 * routes don't need one.
 */
export function startWebServer(config: AppConfig, scheduler: PrefetchScheduler, log: Logger) {
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    if (method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(DASHBOARD_HTML)
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
