import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/** Collect a child's stdout and stderr as it runs. */
export async function readChildOutput(child: ChildProcess): Promise<{ text: () => string }> {
  let output = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  return { text: () => output }
}

/** Wait for streams to close and return the complete captured output. */
export async function collectExit(
  child: ChildProcess,
  output: { text: () => string }
): Promise<{ code: number | null; signal: NodeJS.Signals | null; text: string }> {
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once('close', (status, terminationSignal) => resolve([status, terminationSignal]))
      child.once('error', reject)
    }
  )
  return { code, signal, text: output.text() }
}

/** Whether a process is still running; a zombie counts as gone. */
export async function isAlive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z'
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}

/** Poll for a complete positive PID record written by a child. */
export async function waitForFile(filePath: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const record = await readFile(filePath, 'utf8')
      if (/^[1-9]\d*\n$/.test(record)) {
        const pid = Number(record.trim())
        if (Number.isSafeInteger(pid)) return pid
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}
