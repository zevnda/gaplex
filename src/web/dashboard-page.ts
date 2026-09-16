/**
 * The dashboard is a single self-contained HTML document (inline CSS/JS)
 * rather than a separate static-asset bundle. Gaplex's build is a plain
 * `tsc` compile with no asset-copy step (see tsconfig.json `rootDir`/`outDir`
 * and the Dockerfile, which only copies `dist`) — a template string served
 * straight from compiled JS avoids adding one just for a single page.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gaplex</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #101014;
    color: #eee;
    font: 15px/1.5 system-ui, sans-serif;
  }
  main {
    width: 100%;
    max-width: 420px;
    padding: 32px 24px;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 24px;
    letter-spacing: 0.02em;
  }
  .track {
    margin-bottom: 20px;
  }
  .track .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #888;
    margin-bottom: 4px;
  }
  .track .title {
    font-size: 16px;
    word-break: break-word;
  }
  .track .title.empty {
    color: #666;
    font-style: italic;
  }
  .controls {
    display: flex;
    gap: 10px;
    margin: 24px 0;
  }
  button {
    flex: 1;
    padding: 12px;
    border: 1px solid #333;
    border-radius: 8px;
    background: #1b1b21;
    color: #eee;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover { background: #26262e; }
  button:disabled { opacity: 0.5; cursor: default; }
  details {
    margin-top: 28px;
    border-top: 1px solid #262626;
    padding-top: 16px;
  }
  summary {
    cursor: pointer;
    color: #999;
    font-size: 13px;
  }
  .url-row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  input[type="text"] {
    flex: 1;
    padding: 10px;
    border-radius: 8px;
    border: 1px solid #333;
    background: #1b1b21;
    color: #eee;
    font-size: 13px;
  }
  #status-line {
    margin-top: 10px;
    font-size: 12px;
    color: #777;
    min-height: 1.4em;
  }
</style>
</head>
<body>
<main>
  <h1>Gaplex</h1>

  <div class="track">
    <div class="label">Now playing</div>
    <div class="title empty" id="current-title">&mdash;</div>
  </div>
  <div class="track">
    <div class="label">Up next</div>
    <div class="title empty" id="next-title">&mdash;</div>
  </div>

  <audio id="player" preload="none"></audio>

  <div class="controls">
    <button id="play-pause" disabled>Play</button>
    <button id="skip">Skip</button>
  </div>

  <details>
    <summary>Stream settings</summary>
    <div class="url-row">
      <input type="text" id="stream-url" placeholder="http://your-icecast-host:8000/mount.mp3" />
      <button id="save-url">Save</button>
    </div>
    <div id="status-line"></div>
  </details>
</main>
<script>
(function () {
  var STORAGE_KEY = 'gaplex.radioStreamUrl'
  var audio = document.getElementById('player')
  var playPauseBtn = document.getElementById('play-pause')
  var skipBtn = document.getElementById('skip')
  var urlInput = document.getElementById('stream-url')
  var saveUrlBtn = document.getElementById('save-url')
  var statusLine = document.getElementById('status-line')
  var currentTitle = document.getElementById('current-title')
  var nextTitle = document.getElementById('next-title')

  function formatDuration(totalSeconds) {
    var seconds = Math.max(0, Math.round(totalSeconds))
    var minutes = Math.floor(seconds / 60)
    var remaining = seconds % 60
    return minutes + ':' + String(remaining).padStart(2, '0')
  }

  function setStreamUrl(url) {
    audio.src = url
    playPauseBtn.disabled = false
    audio.play().catch(function () {
      statusLine.textContent = 'Autoplay blocked by browser — press Play to start listening.'
    })
  }

  function loadStreamUrl() {
    var saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      urlInput.value = saved
      setStreamUrl(saved)
      return
    }
    fetch('/api/config')
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (data.radioStreamUrl) {
          urlInput.value = data.radioStreamUrl
          setStreamUrl(data.radioStreamUrl)
        }
      })
      .catch(function () {})
  }

  saveUrlBtn.addEventListener('click', function () {
    var value = urlInput.value.trim()
    if (!value) return
    localStorage.setItem(STORAGE_KEY, value)
    statusLine.textContent = 'Saved. Streaming from ' + value
    setStreamUrl(value)
  })

  playPauseBtn.addEventListener('click', function () {
    if (audio.paused) {
      audio.play().catch(function () {
        statusLine.textContent = 'Could not start playback.'
      })
    } else {
      audio.pause()
    }
  })

  audio.addEventListener('play', function () {
    playPauseBtn.textContent = 'Pause'
    statusLine.textContent = ''
  })
  audio.addEventListener('pause', function () {
    playPauseBtn.textContent = 'Play'
  })
  audio.addEventListener('error', function () {
    statusLine.textContent = 'Could not load that stream URL.'
  })

  skipBtn.addEventListener('click', function () {
    skipBtn.disabled = true
    fetch('/api/skip', { method: 'POST' })
      .catch(function () {})
      .finally(function () {
        setTimeout(function () { skipBtn.disabled = false }, 1000)
      })
  })

  function refreshStatus() {
    fetch('/api/status')
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (data.current) {
          currentTitle.textContent =
            data.current.title + ' (' + formatDuration(data.current.durationSec - data.current.elapsedSec) + ' left)'
          currentTitle.classList.remove('empty')
        } else {
          currentTitle.textContent = '—'
          currentTitle.classList.add('empty')
        }
        if (data.next) {
          nextTitle.textContent = data.next.title + ' (' + formatDuration(data.next.durationSec) + ')'
          nextTitle.classList.remove('empty')
        } else {
          nextTitle.textContent = 'Not queued yet'
          nextTitle.classList.add('empty')
        }
      })
      .catch(function () {})
  }

  loadStreamUrl()
  refreshStatus()
  setInterval(refreshStatus, 5000)
})()
</script>
</body>
</html>
`
