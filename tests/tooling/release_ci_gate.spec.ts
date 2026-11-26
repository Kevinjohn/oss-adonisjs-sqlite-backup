import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from '@japa/runner'

const workflow = new URL('../../.github/workflows/release.yml', import.meta.url)
const sha = 'a'.repeat(40)
const requiredJobs = ['checks']
const successfulJobs = requiredJobs.map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
}))

interface Evidence {
  ref?: string
  runs?: { databaseId: number; headSha: string; event: string }[]
  watch?: 'success' | 'failure' | 'cancelled'
  jobs?: { name: string; status: string; conclusion: string }[]
  apiFailure?: 'list' | 'jobs'
}

async function runGate(evidence: Evidence = {}) {
  const source = await readFile(workflow, 'utf8')
  const guard = source.match(/^ {6}- name: Only main releases\n {8}run: (.*)$/m)?.[1]
  const gate = source
    .match(
      /^ {6}- name: Verify checks for this commit\n(?: {8}[^\n]*\n| {10}GH_TOKEN:[^\n]*\n)*? {8}run: \|\n((?: {10}[^\n]*\n)+)/m
    )?.[1]
    ?.replace(/^ {10}/gm, '')
  if (!guard || !gate) throw new Error('Could not read the main guard and CI gate from release.yml')

  const directory = await mkdtemp(join(tmpdir(), 'release-ci-gate-'))
  try {
    const callsPath = join(directory, 'calls')
    await writeFile(callsPath, '')
    await writeFile(
      join(directory, 'gh'),
      `#!/bin/bash
set -eu
case "$1 $2" in
  "run list")
    printf '%s\\n' 'run list' >> "$CALLS_PATH"
    test "$*" = "run list --repo example/repository --workflow checks.yml --branch main --commit $GITHUB_SHA --limit 1 --json databaseId,headSha,event"
    if [ "\${API_FAILURE:-}" = list ]; then exit 1; fi
    printf '%s\\n' "$RUNS"
    ;;
  "run watch")
    printf '%s\\n' 'run watch' >> "$CALLS_PATH"
    test "$*" = "run watch 42 --repo example/repository --interval 30 --exit-status"
    if [ "$WATCH" != success ]; then echo "$WATCH" >&2; exit 1; fi
    ;;
  "api "*)
    printf '%s\\n' api >> "$CALLS_PATH"
    test "$*" = "api repos/example/repository/actions/runs/42/jobs?filter=latest&per_page=100"
    if [ "\${API_FAILURE:-}" = jobs ]; then exit 1; fi
    printf '%s\\n' "$JOBS"
    ;;
  *) exit 98 ;;
esac
`,
      { mode: 0o755 }
    )
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', guard + '\n' + gate],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: directory + delimiter + process.env.PATH,
          GITHUB_SHA: sha,
          GITHUB_REF: evidence.ref ?? 'refs/heads/main',
          GITHUB_REPOSITORY: 'example/repository',
          CALLS_PATH: callsPath,
          RUNS: JSON.stringify(evidence.runs ?? [{ databaseId: 42, headSha: sha, event: 'push' }]),
          WATCH: evidence.watch ?? 'success',
          JOBS: JSON.stringify({ jobs: evidence.jobs ?? successfulJobs }),
          API_FAILURE: evidence.apiFailure,
        },
      }
    )
    if (result.error) throw result.error
    const calls = await readFile(callsPath, 'utf8')
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: calls.trim().split('\n').filter(Boolean),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test.group('release CI gate', () => {
  test('waits for the exact main push run and accepts every successful check job', async ({
    assert,
  }) => {
    const result = await runGate()
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.calls, ['run list', 'run watch', 'api'])
  })

  test('accepts a manually dispatched checks run for the exact commit', async ({ assert }) => {
    const result = await runGate({
      runs: [{ databaseId: 42, headSha: sha, event: 'workflow_dispatch' }],
    })
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.calls, ['run list', 'run watch', 'api'])
  })

  test('refuses other refs before looking up a run', async ({ assert }) => {
    const result = await runGate({ ref: 'refs/heads/topic' })
    assert.equal(result.status, 1)
    assert.include(result.output, 'release runs on main only')
    assert.deepEqual(result.calls, [])
  })

  test('refuses missing or wrong-commit evidence, including lookup failures', async ({
    assert,
  }) => {
    for (const evidence of [
      { runs: [] },
      { runs: [{ databaseId: 42, headSha: 'wrong', event: 'push' }] },
      { runs: [{ databaseId: 42, headSha: sha, event: 'pull_request' }] },
      { apiFailure: 'list' },
    ] satisfies Evidence[]) {
      const result = await runGate(evidence)
      assert.equal(result.status, 1)
      assert.include(result.output, 'Could not find checks.yml CI')
      assert.deepEqual(result.calls, ['run list'])
    }
  })

  test('stops when a watched run fails or is cancelled', async ({ assert }) => {
    for (const watch of ['failure', 'cancelled'] as const) {
      const result = await runGate({ watch })
      assert.equal(result.status, 1)
      assert.include(result.output, watch)
      assert.deepEqual(result.calls, ['run list', 'run watch'])
    }
  })

  test('refuses unavailable job results and any missing, skipped, unfinished or failed check', async ({
    assert,
  }) => {
    const evidence: Evidence[] = [{ apiFailure: 'jobs' }]
    for (const job of successfulJobs) {
      const otherJobs = successfulJobs.filter(({ name }) => name !== job.name)
      evidence.push({ jobs: otherJobs })
      for (const conclusion of ['skipped', 'failure']) {
        evidence.push({ jobs: [...otherJobs, { ...job, conclusion }] })
      }
      evidence.push({ jobs: [...otherJobs, { ...job, status: 'in_progress', conclusion: '' }] })
    }
    for (const item of evidence) {
      const result = await runGate(item)
      assert.equal(result.status, 1)
      assert.include(result.output, 'Could not verify every required check succeeded')
      assert.deepEqual(result.calls, ['run list', 'run watch', 'api'])
    }
  })
})
