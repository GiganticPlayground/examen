import chalk from 'chalk'
import type { HttpResponse } from './steps/http.js'
import type { CliResponse } from './steps/cli.js'
import type { AssertionResult } from './eval/expect.js'

export type CaseStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'

export interface HttpRequestInfo {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
}

export interface CliRequestInfo {
  command: string
  args: string[]
  stdin?: string
  timeoutMs: number
}

export interface CaseResult {
  index: number
  total: number
  testName: string
  label: string
  status: CaseStatus
  httpRequest?: HttpRequestInfo
  httpResponse?: HttpResponse
  cliRequest?: CliRequestInfo
  cliResponse?: CliResponse
  assertions?: AssertionResult[]
  skipReason?: string
  errorMessage?: string
  seed: number | string
  suiteFile: string
  testId?: string
}

const REDACT_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'])
const REDACT_BODY_RE = /token|secret|password|bearer/i
const BODY_TRUNCATE = 8192
const CLI_TRUNCATE = 4096
const DIVIDER = chalk.dim('─'.repeat(80))
const HEAVY = chalk.dim('═'.repeat(80))

export function redactHeader(key: string, value: string, noRedact: boolean): string {
  if (noRedact) return value
  if (REDACT_HEADERS.has(key.toLowerCase())) {
    if (value.length <= 8) return '****'
    return value.slice(0, 4) + '****' + value.slice(-4)
  }
  return value
}

export function redactBody(obj: unknown, noRedact: boolean): unknown {
  if (noRedact || obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(v => redactBody(v, noRedact))
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
      k,
      REDACT_BODY_RE.test(k) ? '****' : redactBody(v, noRedact),
    ])
  )
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s
  return s.slice(0, limit) + `\n... (${s.length - limit} more bytes)`
}

function formatBody(body: unknown, noRedact: boolean, indent: string): string {
  const redacted = redactBody(body, noRedact)
  const s = typeof redacted === 'string' ? redacted : JSON.stringify(redacted, null, 2)
  const truncated = truncate(s, BODY_TRUNCATE)
  return truncated.split('\n').map(l => indent + l).join('\n')
}

export function printCase(r: CaseResult, noRedact: boolean): void {
  console.log(DIVIDER)
  const label = r.label ? ` / ${r.label}` : ''
  console.log(chalk.bold(`[${r.index}/${r.total}] ${r.testName}${label}`))
  console.log()

  if (r.status === 'SKIP') {
    console.log(chalk.yellow('  SKIP') + (r.skipReason ? chalk.dim(`  (${r.skipReason})`) : ''))
    console.log()
    return
  }

  if (r.status === 'ERROR') {
    console.log(chalk.red(`  ERROR: ${r.errorMessage}`))
    console.log()
    return
  }

  if (r.httpRequest !== undefined && r.httpResponse !== undefined) {
    printHttpBlock(r.httpRequest, r.httpResponse, noRedact)
  } else if (r.cliRequest !== undefined && r.cliResponse !== undefined) {
    printCliBlock(r.cliRequest, r.cliResponse)
  }

  if (r.assertions !== undefined && r.assertions.length > 0) {
    for (const a of r.assertions) {
      const icon = a.passed ? chalk.green('  ✓') : chalk.red('  ✗')
      console.log(`${icon} ${describeAssertion(a)}`)
      if (!a.passed && a.actual !== undefined) {
        console.log(chalk.dim(`      actual: ${JSON.stringify(a.actual)}`))
      }
    }
    console.log()
  }

  const statusStr = r.httpResponse !== undefined
    ? `${r.httpResponse.status} ${httpStatusText(r.httpResponse.status)}, ${r.httpResponse.duration_ms}ms`
    : r.cliResponse !== undefined
    ? `exit=${r.cliResponse.exitCode}, ${r.cliResponse.duration_ms}ms`
    : ''

  if (r.status === 'PASS') {
    console.log(chalk.green('  PASS') + chalk.dim(`  (${statusStr})`))
  } else {
    console.log(chalk.red('  FAIL') + chalk.dim(`  (${statusStr})`))
    console.log(chalk.dim(`  Reproduce: examen run ${r.suiteFile} --seed ${r.seed} --only ${r.testId ?? r.testName}`))
  }
  console.log()
}

function printHttpBlock(req: HttpRequestInfo, res: HttpResponse, noRedact: boolean): void {
  console.log(`  ${chalk.cyan('→')} ${req.method} ${req.url}`)
  for (const [k, v] of Object.entries(req.headers)) {
    console.log(`    ${k}: ${redactHeader(k, v, noRedact)}`)
  }
  console.log(`    timeout:       ${req.timeoutMs}ms`)
  if (req.body !== undefined) {
    console.log(`    body:`)
    console.log(formatBody(req.body, noRedact, '      '))
  }
  console.log()

  const timedOut = (res as unknown as { timedOut?: boolean }).timedOut
  if (timedOut === true) {
    console.log(`  ${chalk.yellow('←')} TIMEOUT  (${res.duration_ms}ms)`)
  } else {
    console.log(`  ${chalk.cyan('←')} ${res.status} ${httpStatusText(res.status)}  (${res.duration_ms}ms)`)
  }
  for (const [k, v] of Object.entries(res.headers)) {
    console.log(`    ${k}: ${v}`)
  }
  if (res.body !== undefined) {
    console.log(`    body:`)
    console.log(formatBody(res.body, noRedact, '      '))
  }
  console.log()
}

function printCliBlock(req: CliRequestInfo, res: CliResponse): void {
  const argStr = req.args.map(a => `'${a}'`).join(' ')
  console.log(`  ${chalk.cyan('$')} ${req.command}${argStr ? ' ' + argStr : ''}`)
  console.log(`    timeout: ${req.timeoutMs}ms`)
  if (req.stdin !== undefined) {
    console.log(`    stdin:`)
    console.log(`      ${req.stdin}`)
  }
  console.log()

  if (res.timedOut) {
    console.log(`  ${chalk.yellow('←')} TIMEOUT  (${res.duration_ms}ms)`)
  } else {
    console.log(`  ${chalk.cyan('←')} exit ${res.exitCode}  (${res.duration_ms}ms)`)
  }

  const stdout = truncate(res.stdout, CLI_TRUNCATE)
  const stderr = truncate(res.stderr, CLI_TRUNCATE)
  console.log(`    stdout:`)
  if (stdout) {
    for (const line of stdout.split('\n')) console.log(`      ${line}`)
  } else {
    console.log(chalk.dim(`      (empty)`))
  }
  console.log(`    stderr:`)
  if (stderr) {
    for (const line of stderr.split('\n')) console.log(`      ${line}`)
  } else {
    console.log(chalk.dim(`      (empty)`))
  }
  console.log()
}

export function printSummary(results: CaseResult[], seed: number | string, totalMs: number): void {
  console.log(HEAVY)
  const seedStr = `seed=${seed}`
  console.log(chalk.bold('SUMMARY') + chalk.dim(' '.repeat(Math.max(1, 73 - seedStr.length)) + seedStr))
  console.log(HEAVY)

  let passed = 0, skipped = 0, failed = 0

  for (const r of results) {
    const label = r.label ? ` / ${r.label}` : ''
    const name = `${r.testName}${label}`.padEnd(48)
    const statusStr = r.httpResponse !== undefined
      ? String(r.httpResponse.status).padEnd(10)
      : r.cliResponse !== undefined
      ? `exit=${r.cliResponse.exitCode}`.padEnd(10)
      : '—'.padEnd(10)
    const dur = r.httpResponse !== undefined
      ? `${r.httpResponse.duration_ms}ms`
      : r.cliResponse !== undefined
      ? `${r.cliResponse.duration_ms}ms`
      : '—'

    if (r.status === 'PASS') {
      passed++
      console.log(chalk.green('  PASS') + `   ${name} ${statusStr} ${dur}`)
    } else if (r.status === 'SKIP') {
      skipped++
      console.log(chalk.yellow('  SKIP') + `   ${name} ${'—'.padEnd(10)} —`)
    } else {
      failed++
      console.log(chalk.red('  FAIL') + `   ${name} ${statusStr} ${dur}`)
    }
  }

  console.log(DIVIDER)
  const summary = `  ${passed} passed · ${skipped} skipped · ${failed} failed`
  const timeStr = `${totalMs}ms`
  const padding = ' '.repeat(Math.max(1, 79 - summary.length - timeStr.length))
  const summaryLine = summary + padding + timeStr
  console.log(failed > 0 ? chalk.red(summaryLine) : chalk.green(summaryLine))
  console.log(HEAVY)

  if (failed > 0) {
    console.log()
    console.log('Failures:')
    for (const r of results.filter(x => x.status === 'FAIL')) {
      const label = r.label ? ` / ${r.label}` : ''
      const failedAssert = r.assertions?.find(a => !a.passed)
      const reason = failedAssert !== undefined
        ? `${failedAssert.path} ${failedAssert.message ?? ''}`
        : r.errorMessage ?? '(unknown)'
      console.log(`  ${r.testName}${label}  →  ${reason}`)
    }
    console.log()
    console.log('Reproduce a failing case:')
    const first = results.find(r => r.status === 'FAIL')
    if (first !== undefined) {
      console.log(`  examen run ${first.suiteFile} --seed ${first.seed} --only ${first.testId ?? first.testName}`)
    }
  }
}

function describeAssertion(a: AssertionResult): string {
  const e = a.expected !== undefined ? ` ${fmt(a.expected)}` : ''
  switch (a.matcher) {
    case 'equals': return `${a.path} equals${e}`
    case 'notEquals': return `${a.path} not equals${e}`
    case 'exists': return `${a.path} exists`
    case 'type': return `${a.path} is${e}`
    case 'matches': return `${a.path} matches /${a.expected}/`
    case 'notMatches': return `${a.path} does not match /${a.expected}/`
    case 'contains': return `${a.path} contains${e}`
    case 'notContains': return `${a.path} does not contain${e}`
    case 'in': return `${a.path} in${e}`
    case 'notIn': return `${a.path} not in${e}`
    case 'all': return `${a.path} all match`
    default: return `${a.path} ${a.matcher}${e}`
  }
}

function fmt(v: unknown): string {
  return JSON.stringify(v) ?? String(v)
}

function httpStatusText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
    422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    504: 'Gateway Timeout',
  }
  return texts[status] ?? ''
}
