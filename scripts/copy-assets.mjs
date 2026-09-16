// tsc only compiles .ts files (see tsconfig.json rootDir/outDir) and never
// touches the dashboard's static .html/.css/.js under src/web/public — this
// mirrors that directory into dist/web/public after every build so
// src/web/server.ts finds it at the same relative path either way.
import { cp } from 'node:fs/promises'

await cp('src/web/public', 'dist/web/public', { recursive: true })
