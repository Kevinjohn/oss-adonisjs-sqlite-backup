/** A file changed since the merge-base. Deleted files select checks but are never passed to tools. */
export interface ChangedFile {
  path: string
  deleted: boolean
}

/** One `pnpm` command run by `pnpm check:changed`. */
export interface ChangedCheckStep {
  label: string
  command: string[]
  /** Report the number of tests the step executed. */
  countsTests?: boolean
  /** Fail when the step executes no tests: its file filter is wrong. */
  requiresTests?: boolean
  /** Fail when the step leaves the worktree dirty. */
  requiresCleanTree?: boolean
}

export interface SkippedCheckStep {
  label: string
  skip: string
}

export type PlannedCheckStep = ChangedCheckStep | SkippedCheckStep

const dependencyFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
// Formatter configuration (and package.json, which pins Prettier) can change any file's format.
const formatterInputs = [
  /^\.prettierrc/,
  /^\.prettierignore$/,
  /^\.editorconfig$/,
  /^package\.json$/,
]

const isSpec = (path: string) => /^tests\/.+\.spec\.ts$/.test(path)
const isTypeScript = (path: string) => /\.[cm]?tsx?$/.test(path)
const isEslintIgnored = (path: string) => /^(stubs|examples|tmp)\//.test(path)
const isLintable = (path: string) =>
  (/\.[cm]?[jt]sx?$/.test(path) && !isEslintIgnored(path)) || dependencyFiles.includes(path)

/** Files that cannot change the built package. Specs also read docs, workflows and examples. */
function isOutsidePackage(path: string): boolean {
  return /^(docs|examples|tests|user-stories|\.github)\//.test(path) || /^[^/]+\.md$/.test(path)
}

export interface PlanOptions {
  /** Leave out every whole suite and the package build: one shared run covers them for a batch. */
  static?: boolean
}

/** Map the changed files to the repository scripts that check them. */
export function planChangedChecks(
  changes: ChangedFile[],
  { static: staticOnly = false }: PlanOptions = {}
): PlannedCheckStep[] {
  const paths = changes.map((change) => change.path)
  const present = changes.filter((change) => !change.deleted).map((change) => change.path)
  const formattable = present.filter((path) => path !== 'pnpm-lock.yaml')
  const specs = present.filter(isSpec)
  const suite = specs.length < changes.length
  const packageChanged = paths.some((path) => !isOutsidePackage(path))
  const formatAll = paths.some((path) => formatterInputs.some((input) => input.test(path)))

  type CheckStepOptions = Omit<ChangedCheckStep, 'label'> & {
    when: boolean
    skip: string
  }
  const buildCheckStep = (
    label: string,
    { when, skip, ...stepOptions }: CheckStepOptions
  ): PlannedCheckStep => (when ? { label, ...stepOptions } : { label, skip })
  // Under --static a suite the files select is named in a skip line instead of run.
  const buildSuiteStep = (label: string, options: CheckStepOptions): PlannedCheckStep =>
    options.when && staticOnly
      ? { label, skip: `--static leaves out ${options.command.join(' ')}` }
      : buildCheckStep(label, options)
  const specsOnly = buildCheckStep('tests', {
    when: specs.length > 0,
    skip: changes.length > 0 ? 'no test files changed' : 'no files changed',
    command: ['pnpm', 'quick:test', ...specs.map((path) => `--files=${path}`)],
    countsTests: true,
    requiresTests: true,
  })

  return [
    formatAll
      ? { label: 'format', command: ['pnpm', 'format:check'] }
      : buildCheckStep('format', {
          when: formattable.length > 0,
          skip: 'no changed files to format',
          command: [
            'pnpm',
            'exec',
            'prettier',
            '--check',
            '--ignore-unknown',
            '--no-error-on-unmatched-pattern',
            ...formattable,
          ],
        }),
    // The repository's own lint script carries the zero-warning limit for every caller.
    buildCheckStep('lint', {
      when: paths.some(isLintable),
      skip: 'no lintable files changed',
      command: ['pnpm', 'lint'],
    }),
    buildCheckStep('typecheck', {
      when: paths.some(
        (path) =>
          (isTypeScript(path) && !isEslintIgnored(path)) ||
          path === 'tsconfig.json' ||
          dependencyFiles.includes(path)
      ),
      skip: 'no TypeScript or type configuration changed',
      command: ['pnpm', 'typecheck'],
    }),
    ...(!suite
      ? [specsOnly]
      : staticOnly
        ? [{ label: 'test suite', skip: '--static leaves out pnpm quick:test' }, specsOnly]
        : [
            {
              label: 'tests',
              command: ['pnpm', 'quick:test'],
              countsTests: true,
              requiresTests: true,
            },
          ]),
    buildSuiteStep('build', {
      when: packageChanged,
      skip: 'no package source changed',
      command: ['pnpm', 'build'],
    }),
  ]
}

/** Count the tests a Japa run executed from its summary line; 0 when none ran. */
export function executedTests(output: string): number {
  // eslint-disable-next-line no-control-regex
  const summary = output.replace(/\u001b\[[0-9;]*m/g, '').match(/^\s*Tests\s+(.+)$/m)?.[1] ?? ''
  return [...summary.matchAll(/(\d+) (passed|failed|regression)/g)].reduce(
    (total, match) => total + Number(match[1]),
    0
  )
}
