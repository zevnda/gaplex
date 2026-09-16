;(function () {
  var STORAGE_URL_KEY = 'gaplex.radioStreamUrl'
  var STORAGE_VOLUME_KEY = 'gaplex.volume'
  var STATUS_POLL_MS = 4000
  var TICK_MS = 1000

  var audio = document.getElementById('player')
  var playPauseBtn = document.getElementById('play-pause')
  var iconPlay = document.getElementById('icon-play')
  var iconPause = document.getElementById('icon-pause')
  var volumeInput = document.getElementById('volume')
  var skipBtn = document.getElementById('skip')
  var urlInput = document.getElementById('stream-url')
  var saveUrlBtn = document.getElementById('save-url')
  var statusLine = document.getElementById('status-line')
  var currentTitleEl = document.getElementById('current-title')
  var art = document.getElementById('art')
  var artPlaceholder = document.getElementById('art-placeholder')
  var progressFill = document.getElementById('progress-fill')
  var timeElapsedEl = document.getElementById('time-elapsed')
  var timeRemainingEl = document.getElementById('time-remaining')
  var nextTitleEl = document.getElementById('next-title')
  var nextDurationEl = document.getElementById('next-duration')
  var nextArt = document.getElementById('next-art')
  var nextArtPlaceholder = document.getElementById('next-art-placeholder')

  // Local copy of the last /api/status response, plus when we fetched it —
  // the 1s tick below interpolates elapsed time between polls so the
  // countdown moves smoothly without hitting the server every second.
  var lastStatus = null
  var lastStatusAtMs = 0

  function formatClock(totalSeconds) {
    var seconds = Math.max(0, Math.round(totalSeconds))
    var minutes = Math.floor(seconds / 60)
    var remaining = seconds % 60
    return minutes + ':' + String(remaining).padStart(2, '0')
  }

  function setArt(imgEl, placeholderEl, url) {
    if (!url) {
      imgEl.hidden = true
      placeholderEl.hidden = false
      return
    }
    imgEl.onerror = function () {
      imgEl.hidden = true
      placeholderEl.hidden = false
    }
    imgEl.onload = function () {
      imgEl.hidden = false
      placeholderEl.hidden = true
    }
    imgEl.src = url
  }

  function setPlayingIcon(isPlaying) {
    iconPlay.hidden = isPlaying
    iconPause.hidden = !isPlaying
    playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play')
  }

  function setStreamUrl(url) {
    audio.src = url
    playPauseBtn.disabled = false
    audio.play().catch(function () {
      statusLine.textContent = 'Autoplay blocked by your browser — press play to start listening.'
    })
  }

  function loadStreamUrl() {
    var saved = localStorage.getItem(STORAGE_URL_KEY)
    if (saved) {
      urlInput.value = saved
      setStreamUrl(saved)
      return
    }
    fetch('/api/config')
      .then(function (res) {
        return res.json()
      })
      .then(function (data) {
        if (data.radioStreamUrl) {
          urlInput.value = data.radioStreamUrl
          setStreamUrl(data.radioStreamUrl)
        }
      })
      .catch(function () {})
  }

  function loadVolume() {
    var saved = localStorage.getItem(STORAGE_VOLUME_KEY)
    var volume = saved !== null ? Number(saved) : 1
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) volume = 1
    audio.volume = volume
    volumeInput.value = String(volume)
  }

  saveUrlBtn.addEventListener('click', function () {
    var value = urlInput.value.trim()
    if (!value) return
    localStorage.setItem(STORAGE_URL_KEY, value)
    statusLine.textContent = 'Saved. Streaming from ' + value
    setStreamUrl(value)
  })

  volumeInput.addEventListener('input', function () {
    var volume = Number(volumeInput.value)
    audio.volume = volume
    localStorage.setItem(STORAGE_VOLUME_KEY, String(volume))
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
    setPlayingIcon(true)
    statusLine.textContent = ''
  })
  audio.addEventListener('pause', function () {
    setPlayingIcon(false)
  })
  audio.addEventListener('error', function () {
    statusLine.textContent = 'Could not load that stream URL.'
  })

  skipBtn.addEventListener('click', function () {
    skipBtn.disabled = true
    fetch('/api/skip', { method: 'POST' })
      .then(function () {
        // Don't wait for the next scheduled poll — the track just changed.
        refreshStatus()
      })
      .catch(function () {})
      .finally(function () {
        setTimeout(function () {
          skipBtn.disabled = false
        }, 1000)
      })
  })

  function applyStatus(data) {
    lastStatus = data
    lastStatusAtMs = Date.now()

    if (data.current) {
      currentTitleEl.textContent = data.current.title
      setArt(art, artPlaceholder, data.current.thumbnailUrl)
    } else {
      currentTitleEl.textContent = 'Waiting for playback…'
      setArt(art, artPlaceholder, null)
    }

    if (data.next) {
      nextTitleEl.textContent = data.next.title
      nextTitleEl.classList.remove('empty')
      nextDurationEl.textContent = formatClock(data.next.durationSec)
      setArt(nextArt, nextArtPlaceholder, data.next.thumbnailUrl)
    } else {
      nextTitleEl.textContent = 'Not queued yet'
      nextTitleEl.classList.add('empty')
      nextDurationEl.textContent = ''
      setArt(nextArt, nextArtPlaceholder, null)
    }

    renderProgress()
  }

  // Runs every second between polls: extrapolates "elapsed" from the last
  // known server value plus wall-clock time since that poll, so the
  // countdown and progress bar move smoothly without polling every second.
  function renderProgress() {
    if (!lastStatus || !lastStatus.current) {
      progressFill.style.width = '0%'
      timeElapsedEl.textContent = '0:00'
      timeRemainingEl.textContent = '−0:00'
      return
    }

    var current = lastStatus.current
    var driftSec = (Date.now() - lastStatusAtMs) / 1000
    var elapsedSec = Math.min(current.durationSec, current.elapsedSec + driftSec)
    var remainingSec = Math.max(0, current.durationSec - elapsedSec)
    var pct = current.durationSec > 0 ? (elapsedSec / current.durationSec) * 100 : 0

    progressFill.style.width = Math.min(100, pct) + '%'
    timeElapsedEl.textContent = formatClock(elapsedSec)
    timeRemainingEl.textContent = '−' + formatClock(remainingSec)
  }

  function refreshStatus() {
    fetch('/api/status')
      .then(function (res) {
        return res.json()
      })
      .then(applyStatus)
      .catch(function () {})
  }

  loadStreamUrl()
  loadVolume()
  refreshStatus()
  setInterval(refreshStatus, STATUS_POLL_MS)
  setInterval(renderProgress, TICK_MS)
})()
