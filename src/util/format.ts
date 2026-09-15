/** Formats seconds as "m:ss" for log output. */
export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
