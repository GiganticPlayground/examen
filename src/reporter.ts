import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { CaseResult } from './output.js'
import type { AssertionResult } from './eval/expect.js'
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

  const suiteName = suite.name ?? basename(suiteFile, '.yaml')
  const ts = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = suiteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const runDir = join(outputDir, `${ts}-${slug}`)
  const casesDir = join(runDir, 'cases')

  mkdirSync(casesDir, { recursive: true })

  const summary = {
    suite: suiteName,
    file: suiteFile,
    seed,
    startedAt: startedAt.toISOString(),
    duration_ms,
    summary: { total: results.length, passed, failed, skipped, errored },
    cases: results.map(r => ({
      index: r.index,
      ...(r.testId !== undefined ? { id: r.testId } : {}),
      name: r.testName,
      ...(r.label ? { label: r.label } : {}),
      status: r.status,
      duration_ms: r.httpResponse?.duration_ms ?? r.cliResponse?.duration_ms,
      file: caseFilename(r),
    })),
  }

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  for (const r of results) {
    const caseData = {
      index: r.index,
      ...(r.testId !== undefined ? { id: r.testId } : {}),
      name: r.testName,
      ...(r.label ? { label: r.label } : {}),
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
    }
    writeFileSync(join(casesDir, caseFilename(r)), JSON.stringify(caseData, null, 2))
  }

  writeFileSync(join(runDir, 'run.md'), buildMarkdown(suiteName, suiteFile, seed, startedAt, duration_ms, results, { passed, failed, skipped, errored }))

  return runDir
}

function caseFilename(r: CaseResult): string {
  const idx = String(r.index).padStart(2, '0')
  const id = r.testId ?? r.testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const label = r.label ? '-' + r.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : ''
  const status = r.status !== 'PASS' ? `-${r.status}` : ''
  return `${idx}-${id}${label}${status}.json`
}

function buildMarkdown(
  suiteName: string,
  suiteFile: string,
  seed: number | string,
  startedAt: Date,
  duration_ms: number,
  results: CaseResult[],
  counts: { passed: number; failed: number; skipped: number; errored: number }
): string {
  const lines: string[] = []

  lines.push(`# ${suiteName}`, '')
  lines.push(`| | |`)
  lines.push(`|---|---|`)
  lines.push(`| **File** | \`${suiteFile}\` |`)
  lines.push(`| **Seed** | ${seed} |`)
  lines.push(`| **Started** | ${startedAt.toISOString()} |`)
  lines.push(`| **Duration** | ${duration_ms}ms |`)
  lines.push('')

  lines.push('## Summary', '')
  lines.push('| Status | Count |')
  lines.push('|---|---|')
  lines.push(`| ✅ Passed | ${counts.passed} |`)
  lines.push(`| ❌ Failed | ${counts.failed} |`)
  lines.push(`| ⏭ Skipped | ${counts.skipped} |`)
  if (counts.errored > 0) lines.push(`| 💥 Errored | ${counts.errored} |`)
  lines.push(`| **Total** | **${results.length}** |`)
  lines.push('')

  lines.push('---', '')

  for (const r of results) {
    const label = r.label ? ` / ${r.label}` : ''
    const icon = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭' : r.status === 'ERROR' ? '💥' : '❌'
    lines.push(`## [${r.index}/${r.total}] ${r.testName}${label}`, '')
    lines.push(`**Status:** ${icon} ${r.status}`, '')

    if (r.status === 'SKIP') {
      if (r.skipReason) lines.push(`*${r.skipReason}*`, '')
      lines.push('---', '')
      continue
    }

    if (r.status === 'ERROR') {
      lines.push(`**Error:** ${r.errorMessage}`, '')
      lines.push('---', '')
      continue
    }

    if (r.httpRequest !== undefined && r.httpResponse !== undefined) {
      lines.push('### Request', '')
      lines.push('```')
      lines.push(`${r.httpRequest.method} ${r.httpRequest.url}`)
      for (const [k, v] of Object.entries(r.httpRequest.headers)) {
        lines.push(`${k}: ${v}`)
      }
      lines.push('```', '')
      if (r.httpRequest.body !== undefined) {
        lines.push('**Body:**', '')
        lines.push('```json')
        lines.push(JSON.stringify(r.httpRequest.body, null, 2))
        lines.push('```', '')
      }

      lines.push('### Response', '')
      lines.push(`**Status:** ${r.httpResponse.status}  **Duration:** ${r.httpResponse.duration_ms}ms`, '')
      if (r.httpResponse.body !== undefined) {
        lines.push('```json')
        lines.push(JSON.stringify(r.httpResponse.body, null, 2))
        lines.push('```', '')
      }
    } else if (r.cliRequest !== undefined && r.cliResponse !== undefined) {
      lines.push('### Command', '')
      lines.push('```')
      lines.push(`$ ${r.cliRequest.command} ${r.cliRequest.args.join(' ')}`)
      lines.push('```', '')
      lines.push('### Output', '')
      lines.push(`**Exit code:** ${r.cliResponse.exitCode}  **Duration:** ${r.cliResponse.duration_ms}ms`, '')
      if (r.cliResponse.stdout) {
        lines.push('**stdout:**', '```')
        lines.push(r.cliResponse.stdout)
        lines.push('```', '')
      }
      if (r.cliResponse.stderr) {
        lines.push('**stderr:**', '```')
        lines.push(r.cliResponse.stderr)
        lines.push('```', '')
      }
    }

    if (r.assertions && r.assertions.length > 0) {
      lines.push('### Assertions', '')
      for (const a of r.assertions) {
        lines.push(formatAssertion(a))
      }
      lines.push('')
    }

    lines.push('---', '')
  }

  return lines.join('\n')
}

function formatAssertion(a: AssertionResult): string {
  const icon = a.passed ? '✅' : '❌'
  const e = a.expected !== undefined ? ` ${JSON.stringify(a.expected)}` : ''
  let desc: string
  switch (a.matcher) {
    case 'equals':    desc = `${a.path} equals${e}`; break
    case 'notEquals': desc = `${a.path} not equals${e}`; break
    case 'exists':    desc = `${a.path} exists`; break
    case 'type':      desc = `${a.path} is${e}`; break
    case 'matches':   desc = `${a.path} matches /${a.expected}/`; break
    case 'notMatches':desc = `${a.path} does not match /${a.expected}/`; break
    case 'contains':  desc = `${a.path} contains${e}`; break
    case 'notContains':desc = `${a.path} does not contain${e}`; break
    case 'all':       desc = `${a.path} all match`; break
    default:          desc = `${a.path} ${a.matcher}${e}`
  }
  const detail = !a.passed && a.message ? ` — ${a.message}` : ''
  return `- ${icon} ${desc}${detail}`
}
