export interface RetryOptions {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  backoffFactor: number
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void
}

/**
 * Retries `fn` with exponential backoff (plus a little jitter, so repeated
 * failures across tracks don't all retry in lockstep) until it succeeds or
 * `maxAttempts` is reached, in which case the last error is rethrown.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions) {
  let delay = options.initialDelayMs
  let attempt = 0

  for (;;) {
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      if (attempt >= options.maxAttempts) {
        throw error
      }
      const delayWithJitter = withJitter(delay)
      options.onRetry?.(attempt, error, delayWithJitter)
      await sleep(delayWithJitter)
      delay = Math.min(delay * options.backoffFactor, options.maxDelayMs)
    }
  }
}

function withJitter(delayMs: number) {
  const jitterRatio = 0.2
  return delayMs + delayMs * jitterRatio * Math.random()
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}
