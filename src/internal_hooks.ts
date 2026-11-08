/**
 * Test seam. Not exported from index.ts or the package exports map, so consumers cannot reach it.
 * Crash and race tests set `step` to act at a named point; the fsync test sets
 * `durability` to record every fsync and durable write in order.
 */
export type HookStep =
  | 'create:copying'
  | 'create:cleanup'
  | 'list:ready'
  | 'create:copied'
  | 'create:checked'
  | 'create:manifest'
  | 'prune:unpublished'
  | 'list:read'
  | 'verify:selected'
  | 'create:naming'
  | 'verify:listed'
  | 'lock:damaged'
  | 'restore:checked'
  | 'restore:copied'

export const internalHooks: {
  step?: (step: HookStep, detail: string) => void
  durability?: (event: 'sync' | 'write', path: string) => void
} = {}
