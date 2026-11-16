import type { ChildProcess } from 'node:child_process'
import type { Worker } from 'node:worker_threads'

export type WriterStats = { max: number; writes: number; busy: number }

const stopGraceMs = 1000
const killGraceMs = 1000
const closeSeen = new WeakSet<ChildProcess>()

export class ResourceCleanupError extends Error {
  constructor(resource: string, cause: unknown) {
    super(`Could not confirm ${resource} cleanup`, { cause })
    this.name = 'ResourceCleanupError'
  }
}

export function hasCleanupFailure(error: unknown): boolean {
  if (error instanceof ResourceCleanupError) return true
  if (error instanceof AggregateError) return [...error.errors].some(hasCleanupFailure)
  if (error instanceof Error && error.cause !== undefined) return hasCleanupFailure(error.cause)
  return false
}

function observeClose(child: ChildProcess): void {
  if (closeSeen.has(child)) return
  child.once('close', () => closeSeen.add(child))
}

function onceMessage<T>(
  resource: ChildProcess | Worker,
  select: (message: unknown) => T | undefined,
  label: string,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs
    )
    const cleanup = () => {
      clearTimeout(timer)
      resource.off('message', onMessage)
      resource.off('error', onError)
      resource.off('exit', onExit)
    }
    const finish = (error?: Error, value?: T) => {
      cleanup()
      if (error) reject(error)
      else resolve(value as T)
    }
    const onMessage = (message: unknown) => {
      try {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'error'
        ) {
          throw new Error('message' in message ? String(message.message) : `${label} failed`)
        }
        const value = select(message)
        if (value !== undefined) finish(undefined, value)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null, signal?: NodeJS.Signals) =>
      finish(
        new Error(`${label} exited before responding (code ${code}, signal ${signal ?? 'none'})`)
      )
    resource.on('message', onMessage)
    resource.once('error', onError)
    resource.once('exit', onExit)
  })
}

function closed(child: ChildProcess, timeoutMs: number): Promise<void> {
  observeClose(child)
  if (closeSeen.has(child)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      reject(new Error(`Writer did not close within ${timeoutMs} ms`))
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('close', onClose)
  })
}

async function terminateWriter(child: ChildProcess): Promise<void> {
  observeClose(child)
  if (closeSeen.has(child)) return
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed(child, killGraceMs)
    return
  }
  const wait = closed(child, stopGraceMs)
  child.kill('SIGTERM')
  try {
    await wait
    return
  } catch {
    // Escalate below when the writer does not stop on SIGTERM.
  }
  const killed = closed(child, killGraceMs)
  child.kill('SIGKILL')
  await killed
}

export async function waitForWriterReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  observeClose(child)
  await onceMessage(
    child,
    (message) => {
      if (message === 'ready') return true
      if (message instanceof Error) throw message
      return undefined
    },
    'Writer readiness',
    timeoutMs
  )
}

export async function stopWriter(child: ChildProcess, timeoutMs = 10_000): Promise<WriterStats> {
  observeClose(child)
  const response = onceMessage(
    child,
    (message) => {
      if (typeof message !== 'string') return undefined
      const stats = JSON.parse(message) as WriterStats
      if (
        typeof stats.max !== 'number' ||
        typeof stats.writes !== 'number' ||
        typeof stats.busy !== 'number'
      ) {
        throw new Error('Writer returned invalid stats')
      }
      return stats
    },
    'Writer stats',
    timeoutMs
  )
  try {
    child.send('stop')
    const stats = await response
    await closed(child, timeoutMs)
    return stats
  } catch (error) {
    try {
      await terminateWriter(child)
    } catch (cleanupError) {
      throw new ResourceCleanupError('writer', new AggregateError([error, cleanupError]))
    }
    throw error
  }
}

export async function waitForSamplerPeak(worker: Worker, timeoutMs = 10_000): Promise<number> {
  const response = onceMessage(
    worker,
    (message) => {
      if (typeof message !== 'number') return undefined
      return message
    },
    'Sampler stats',
    timeoutMs
  )
  try {
    worker.postMessage('stop')
    return await response
  } catch (error) {
    await worker.terminate()
    throw error
  }
}

export async function stopSampler(worker: Worker): Promise<void> {
  await worker.terminate()
}

export async function withWriter<T>(child: ChildProcess, operation: () => Promise<T>): Promise<T> {
  let result: T | undefined
  let operationError: unknown
  try {
    await waitForWriterReady(child)
    result = await operation()
  } catch (error) {
    operationError = error
  }
  try {
    await terminateWriter(child)
  } catch (cleanupError) {
    if (operationError !== undefined) {
      throw new ResourceCleanupError(
        'writer',
        new AggregateError(
          [operationError, cleanupError],
          'Benchmark operation and writer cleanup failed'
        )
      )
    }
    throw new ResourceCleanupError('writer', cleanupError)
  }
  if (operationError !== undefined) throw operationError
  return result as T
}

export async function withSampler<T>(worker: Worker, operation: () => Promise<T>): Promise<T> {
  let rejectFailure!: (error: Error) => void
  const failure = new Promise<never>((_, reject) => (rejectFailure = reject))
  const onError = (error: Error) => rejectFailure(error)
  const onExit = (code: number) =>
    rejectFailure(new Error(`Sampler exited unexpectedly (code ${code})`))
  worker.once('error', onError)
  worker.once('exit', onExit)
  let result: T | undefined
  let operationError: unknown
  try {
    result = await Promise.race([operation(), failure])
  } catch (error) {
    operationError = error
  }
  worker.off('error', onError)
  worker.off('exit', onExit)
  try {
    await stopSampler(worker)
  } catch (cleanupError) {
    if (operationError !== undefined) {
      throw new ResourceCleanupError(
        'sampler',
        new AggregateError(
          [operationError, cleanupError],
          'Benchmark operation and sampler cleanup failed'
        )
      )
    }
    throw new ResourceCleanupError('sampler', cleanupError)
  }
  if (operationError !== undefined) throw operationError
  return result as T
}
