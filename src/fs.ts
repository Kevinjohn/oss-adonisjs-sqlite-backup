import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'
import { internalHooks } from './internal_hooks.js'

/** fsync a file or directory by path. */
export function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
    internalHooks.durability?.('sync', path)
  } finally {
    closeSync(fd)
  }
}

/**
 * Write every byte of `data`, however many calls that takes. A single write may stop short
 * (disk full, signal) without throwing; publishing after one would leave a truncated file.
 */
export function writeAll(
  fd: number,
  data: Buffer,
  write: (fd: number, data: Buffer, offset: number) => number = writeSync
): void {
  for (let offset = 0; offset < data.length;) {
    const written = write(fd, data, offset)
    if (written <= 0) throw new Error(`write stopped after ${offset} of ${data.length} bytes`)
    offset += written
  }
}

/** Create `path` exclusively with read-only mode, write `data`, fsync. */
export function writeDurable(path: string, data: string): void {
  const fd = openSync(path, 'wx', 0o400)
  try {
    writeAll(fd, Buffer.from(data))
    fsyncSync(fd)
    internalHooks.durability?.('write', path)
  } finally {
    closeSync(fd)
  }
}

/** SHA-256 of a file, read in 1 MiB chunks: constant memory, no 2 GiB limit. */
export function sha256File(path: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1 << 20)
  const fd = openSync(path, 'r')
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
