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

export class InternalHooks {
  static #step?: (step: HookStep, detail: string) => void
  static #durability?: (event: 'sync' | 'write', path: string) => void

  static get step(): ((step: HookStep, detail: string) => void) | undefined {
    return this.#step
  }

  static set step(handler: ((step: HookStep, detail: string) => void) | undefined) {
    this.#step = handler
  }

  static get durability(): ((event: 'sync' | 'write', path: string) => void) | undefined {
    return this.#durability
  }

  static set durability(handler: ((event: 'sync' | 'write', path: string) => void) | undefined) {
    this.#durability = handler
  }
}
