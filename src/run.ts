import type { ExamenTestSuite } from './types.js'
import type { Scope } from './context.js'
import type { CaseResult, HttpRequestInfo, CliRequestInfo } from './output.js'
import { createLookup, evalSuiteVars } from './context.js'
import { createRng } from './generators.js'
import { buildPlan, normalizeDeps } from './plan.js'
import { runHttpStep } from './steps/http.js'
import { runCliStep } from './steps/cli.js'
import { applyCapture } from './capture.js'
import { evaluateExpect } from './expect.js'
import { renderTemplate, renderValue } from './template.js'

export interface RunOptions {
  only?: string[]
  seed?: number | string
  noRedact?: boolean
  suiteFile: string
}

export async function runSuite(
  suite: ExamenTestSuite,
  opts: RunOptions
): Promise<CaseResult[]> {
  const seed = opts.seed ?? suite.seed
  const rng = createRng(seed)
  const defaultTimeoutMs = suite.defaultTimeoutMs ?? 30000

  const generatorDefs: Record<string, string> = {}
  if (suite.generators) {
    for (const [k, v] of Object.entries(suite.generators)) {
      generatorDefs[k] = v
    }
  }

  const rawVars = (suite.vars ?? {}) as Record<string, unknown>
  const vars = evalSuiteVars(rawVars, generatorDefs, rng)

  const globalScope: Scope = {
    vars,
    let: {},
    captures: {},
    testCaptures: {},
    testCaptureKeys: {},
    generatorDefs,
    rng,
  }

  const plan = buildPlan(suite, globalScope)

  let cases = plan.cases
  if (opts.only && opts.only.length > 0) {
    const onlySet = new Set(opts.only)
    cases = cases.filter(c => c.test.id !== undefined && onlySet.has(c.test.id))
  }

  const failedIds = new Set<string>()
  const results: CaseResult[] = []
  const total = cases.length

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!
    const test = tc.test

    // Build the display label for this case
    let label = ''
    if (tc.forEachAs !== undefined && tc.forEachItem !== undefined) {
      const item = tc.forEachItem
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        // For object items, show key=value pairs
        label = Object.entries(item as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ')
      } else {
        label = `${tc.forEachAs}=${String(item)}`
      }
    }

    const baseResult = {
      index: i + 1,
      total,
      testName: test.name,
      label,
      seed: seed ?? 'random',
      suiteFile: opts.suiteFile,
      ...(test.id !== undefined ? { testId: test.id } : {}),
    }

    // Check dependsOn — skip if any dependency failed
    const deps = normalizeDeps(test.dependsOn)
    const failedDep = deps.find(d => failedIds.has(d))
    if (failedDep) {
      results.push({ ...baseResult, status: 'SKIP', skipReason: `dependency "${failedDep}" failed` })
      continue
    }

    // Build per-case scope
    const caseScope: Scope = {
      ...globalScope,
      let: {},
      captures: {},
      ...(tc.forEachItem !== undefined ? { forEachItem: tc.forEachItem } : {}),
      ...(tc.forEachAs !== undefined ? { forEachAs: tc.forEachAs } : {}),
    }

    // Evaluate skipIf
    if (test.skipIf) {
      const skip = evaluateSkipIf(test.skipIf, caseScope)
      if (skip) {
        results.push({ ...baseResult, status: 'SKIP', skipReason: `skipIf: ${test.skipIf}` })
        continue
      }
    }

    // Evaluate let bindings
    if (test.let) {
      const lookup = createLookup(caseScope)
      for (const [k, v] of Object.entries(test.let as Record<string, unknown>)) {
        caseScope.let[k] = renderValue(v, lookup)
      }
    }

    let caseStatus: 'PASS' | 'FAIL' | 'ERROR' = 'PASS'
    let caseResult: CaseResult

    try {
      // Run setup step if present
      if (test.setup) {
        if (test.setup.http) {
          const setupResp = await runHttpStep(test.setup.http, caseScope, defaultTimeoutMs)
          if (test.setup.capture) {
            applyCapture(test.setup.capture as Record<string, unknown>, setupResp, caseScope)
          }
        } else if (test.setup.cli) {
          const setupResp = await runCliStep(test.setup.cli, caseScope, defaultTimeoutMs)
          if (test.setup.capture) {
            applyCapture(test.setup.capture as Record<string, unknown>, setupResp, caseScope)
          }
        }
      }

      const maxAttempts = test.retry?.count ?? 1
      const retryDelay = test.retry?.delayMs ?? 0

      let assertions: import('./expect.js').AssertionResult[] = []
      let httpResp: import('./steps/http.js').HttpResponse | undefined
      let cliResp: import('./steps/cli.js').CliResponse | undefined
      let httpReq: HttpRequestInfo | undefined
      let cliReq: CliRequestInfo | undefined

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0 && retryDelay > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, retryDelay))
        }

        if (test.http) {
          const lookup = createLookup(caseScope)
          // Capture request details for output before execution
          httpReq = {
            method: test.http.method,
            url: renderTemplate(test.http.url, lookup),
            headers: Object.fromEntries(
              Object.entries(test.http.headers ?? {}).map(([k, v]) => [k, renderTemplate(v, lookup)])
            ),
            ...(test.http.body !== undefined ? { body: renderValue(test.http.body as unknown, lookup) } : {}),
            timeoutMs: test.http.timeoutMs ?? defaultTimeoutMs,
          }
          httpResp = await runHttpStep(test.http, caseScope, defaultTimeoutMs)
          if (test.capture) {
            applyCapture(test.capture as Record<string, unknown>, httpResp, caseScope)
          }
          if (test.expect) {
            const lookup = createLookup(caseScope)
            const rendered = (test.expect as Record<string, unknown>[]).map(
              a => renderValue(a, lookup) as Record<string, unknown>
            )
            assertions = evaluateExpect(rendered, httpResp as unknown as Record<string, unknown>, {})
          }
        } else if (test.cli) {
          const lookup = createLookup(caseScope)
          cliReq = {
            command: renderTemplate(test.cli.command, lookup),
            args: (test.cli.args ?? []).map(a => renderTemplate(a, lookup)),
            timeoutMs: test.cli.timeoutMs ?? defaultTimeoutMs,
            ...(test.cli.stdin !== undefined ? { stdin: test.cli.stdin } : {}),
          }
          cliResp = await runCliStep(test.cli, caseScope, defaultTimeoutMs)
          if (test.capture) {
            applyCapture(test.capture as Record<string, unknown>, cliResp, caseScope)
          }
          if (test.expect) {
            const lookup = createLookup(caseScope)
            const rendered = (test.expect as Record<string, unknown>[]).map(
              a => renderValue(a, lookup) as Record<string, unknown>
            )
            assertions = evaluateExpect(rendered, cliResp as unknown as Record<string, unknown>, {})
          }
        }

        const anyFailed = assertions.some(a => !a.passed)
        if (!anyFailed) break
        if (attempt === maxAttempts - 1) caseStatus = 'FAIL'
      }

      // Store captures globally for later tests
      if (test.id && Object.keys(caseScope.captures).length > 0) {
        const captureEntry = { ...caseScope.captures }
        const existing = globalScope.testCaptures[test.id] ?? []
        existing.push(captureEntry)
        globalScope.testCaptures[test.id] = existing

        if (tc.keyByValue !== undefined) {
          const keyedMap = globalScope.testCaptureKeys[test.id] ?? {}
          keyedMap[tc.keyByValue] = captureEntry
          globalScope.testCaptureKeys[test.id] = keyedMap
        }
      }

      caseResult = {
        ...baseResult,
        status: caseStatus,
        ...(httpReq !== undefined ? { httpRequest: httpReq } : {}),
        ...(httpResp !== undefined ? { httpResponse: httpResp } : {}),
        ...(cliReq !== undefined ? { cliRequest: cliReq } : {}),
        ...(cliResp !== undefined ? { cliResponse: cliResp } : {}),
        assertions,
      }
    } catch (err) {
      caseStatus = 'ERROR'
      caseResult = {
        ...baseResult,
        status: 'ERROR',
        errorMessage: (err as Error).message,
      }
    }

    // Teardown always runs (failures don't change caseStatus)
    if (test.teardown) {
      try {
        if (test.teardown.http) {
          await runHttpStep(test.teardown.http, caseScope, defaultTimeoutMs)
        } else if (test.teardown.cli) {
          await runCliStep(test.teardown.cli, caseScope, defaultTimeoutMs)
        }
      } catch {
        // teardown failures are reported but don't affect pass/fail
      }
    }

    if ((caseStatus === 'FAIL' || caseStatus === 'ERROR') && test.id) {
      failedIds.add(test.id)
    }

    results.push(caseResult)
  }

  return results
}

function evaluateSkipIf(expr: string, scope: Scope): boolean {
  const lookup = createLookup(scope)
  // Supports: 'name == "value"' and 'name != "value"'
  const eqMatch = expr.match(/^(.+?)\s*==\s*['"](.+?)['"]\s*$/)
  if (eqMatch) {
    const lhs = eqMatch[1]?.trim() ?? ''
    const rhs = eqMatch[2] ?? ''
    return String(lookup(lhs)) === rhs
  }
  const neqMatch = expr.match(/^(.+?)\s*!=\s*['"](.+?)['"]\s*$/)
  if (neqMatch) {
    const lhs = neqMatch[1]?.trim() ?? ''
    const rhs = neqMatch[2] ?? ''
    return String(lookup(lhs)) !== rhs
  }
  return false
}
