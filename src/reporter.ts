import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { CaseResult } from './output.js'
import type { ExamenTestSuite } from './types.js'

export interface ReportOptions {
  suite: ExamenTestSuite
  suiteFile: string
  seed: number | string
  startedAt: Date
  duration_ms: number
  results: CaseResult[]
  outputDir: string
}

export function writeReport(opts: ReportOptions): string {
  const { suite, suiteFile, seed, startedAt, duration_ms, results, outputDir } = opts

  let passed = 0, failed = 0, skipped = 0, errored = 0
  for (const r of results) {
    if (r.status === 'PASS') passed++
    else if (r.status === 'FAIL') failed++
    else if (r.status === 'SKIP') skipped++
    else errored++
  }

  const report = {
    suite: suite.name ?? basename(suiteFile, '.yaml'),
    file: suiteFile,
    seed,
    startedAt: startedAt.toISOString(),
    duration_ms,
    summary: { total: results.length, passed, failed, skipped, errored },
    cases: results.map(r => ({
      index: r.index,
      id: r.testId,
      name: r.testName,
      label: r.label || undefined,
      status: r.status,
      ...(r.skipReason !== undefined ? { skipReason: r.skipReason } : {}),
      ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
      ...(r.httpRequest !== undefined ? { request: r.httpRequest } : {}),
      ...(r.httpResponse !== undefined ? {
        response: {
          status: r.httpResponse.status,
          headers: r.httpResponse.headers,
          body: r.httpResponse.body,
          duration_ms: r.httpResponse.duration_ms,
        }
      } : {}),
      ...(r.cliRequest !== undefined ? { request: r.cliRequest } : {}),
      ...(r.cliResponse !== undefined ? {
        response: {
          exitCode: r.cliResponse.exitCode,
          stdout: r.cliResponse.stdout,
          stderr: r.cliResponse.stderr,
          duration_ms: r.cliResponse.duration_ms,
          timedOut: r.cliResponse.timedOut,
        }
      } : {}),
      ...(r.assertions !== undefined ? { assertions: r.assertions } : {}),
    })),
  }

  mkdirSync(outputDir, { recursive: true })

  const ts = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = (suite.name ?? basename(suiteFile, '.yaml'))
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const filename = `${ts}-${name}.json`
  const filePath = join(outputDir, filename)

  writeFileSync(filePath, JSON.stringify(report, null, 2))
  return filePath
}
