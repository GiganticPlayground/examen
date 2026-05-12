import { resolvePath } from './context.js'
import vm from 'node:vm'

export interface AssertionResult {
  path: string
  matcher: string
  passed: boolean
  actual?: unknown
  expected?: unknown
  message?: string
}

type Response = Record<string, unknown>

export function resolveAssertionPath(
  path: string,
  response: Response
): { values: unknown[]; isWildcard: boolean } {
  if (path.includes('[*]')) {
    const parts = path.split('[*]')
    const before = parts[0] ?? ''
    const after = parts[1] ?? ''
    const arr = resolvePath(response, before)
    if (!Array.isArray(arr)) return { values: [], isWildcard: true }
    if (after) {
      const suffix = after.startsWith('.') ? after.slice(1) : after
      return { values: arr.map(el => resolvePath(el as Record<string, unknown>, suffix)), isWildcard: true }
    }
    return { values: arr, isWildcard: true }
  }
  return { values: [resolvePath(response, path)], isWildcard: false }
}

export function evaluateExpect(
  assertions: Record<string, unknown>[],
  response: Response,
  ctx: Record<string, unknown>
): AssertionResult[] {
  const results: AssertionResult[] = []

  for (const assertion of assertions) {
    const entries = Object.entries(assertion)
    if (entries.length === 0) continue
    const [path, matcherOrShorthand] = entries[0] as [string, unknown]
    const { values, isWildcard } = resolveAssertionPath(path, response)

    if (isWildcard) {
      const nestedMatcher = (matcherOrShorthand as Record<string, unknown>)['all']
      if (nestedMatcher === undefined) {
        results.push({ path, matcher: 'all', passed: false, message: '[*] requires { all: <matcher> }' })
        continue
      }
      let allPass = true
      for (let i = 0; i < values.length; i++) {
        const r = runMatcher(nestedMatcher, values[i], ctx)
        if (!r.passed) {
          const failResult: AssertionResult = {
            path: `${path}[${i}]`,
            matcher: 'all',
            passed: false,
            actual: values[i],
          }
          if (r.message !== undefined) failResult.message = r.message
          results.push(failResult)
          allPass = false
          break // fail fast, report index
        }
      }
      if (allPass) results.push({ path, matcher: 'all', passed: true })
    } else {
      const value = values[0]
      const r = runMatcher(matcherOrShorthand, value, ctx)
      const matcherName = matcherOrShorthand === null || typeof matcherOrShorthand !== 'object'
        ? 'equals'
        : Object.keys(matcherOrShorthand as object)[0] ?? 'equals'
      const expectedVal = matcherOrShorthand === null || typeof matcherOrShorthand !== 'object'
        ? matcherOrShorthand
        : Object.values(matcherOrShorthand as object)[0]
      results.push({
        path,
        matcher: matcherName,
        passed: r.passed,
        ...(expectedVal !== undefined ? { expected: expectedVal } : {}),
        ...(r.passed ? {} : { actual: value }),
        ...(r.message !== undefined ? { message: r.message } : {}),
      })
    }
  }

  return results
}

export function runMatcher(
  matcherObj: unknown,
  value: unknown,
  ctx: Record<string, unknown>
): { passed: boolean; message?: string } {
  // Shorthand: primitive → { equals: value }
  if (matcherObj === null || typeof matcherObj !== 'object') {
    const passed = deepEqual(value, matcherObj)
    return { passed, ...(passed ? {} : { message: `expected ${fmt(matcherObj)}, got ${fmt(value)}` }) }
  }

  const entries = Object.entries(matcherObj as Record<string, unknown>)
  if (entries.length === 0) return { passed: false, message: 'Empty matcher object' }
  const [keyword, expected] = entries[0] as [string, unknown]

  switch (keyword) {
    case 'equals': return mkEq(value, expected)
    case 'notEquals': return mkNeq(value, expected)
    case 'exists':
      return { passed: expected ? value !== undefined : value === undefined }
    case 'type': return checkType(value, expected as string)
    case 'matches': return checkRegex(value, expected as string, false)
    case 'notMatches': return checkRegex(value, expected as string, true)
    case 'contains': return checkContains(value, expected, false)
    case 'notContains': return checkContains(value, expected, true)
    case 'in': return checkIn(value, expected as unknown[], false)
    case 'notIn': return checkIn(value, expected as unknown[], true)
    case 'lengthEquals': return checkLength(value, expected as number, 'eq')
    case 'lengthGte': return checkLength(value, expected as number, 'gte')
    case 'lengthLte': return checkLength(value, expected as number, 'lte')
    case 'gt': return numCmp(value, expected as number, (a, b) => a > b, '>')
    case 'gte': return numCmp(value, expected as number, (a, b) => a >= b, '>=')
    case 'lt': return numCmp(value, expected as number, (a, b) => a < b, '<')
    case 'lte': return numCmp(value, expected as number, (a, b) => a <= b, '<=')
    case 'all':
      return { passed: false, message: 'all: must be used with [*] wildcard path' }
    case 'js':
      return runJs(value, expected as string, ctx)
    default:
      return { passed: false, message: `Unknown matcher keyword: ${keyword}` }
  }
}

function mkEq(v: unknown, e: unknown): { passed: boolean; message?: string } {
  const passed = deepEqual(v, e)
  return { passed, ...(passed ? {} : { message: `expected ${fmt(e)}, got ${fmt(v)}` }) }
}
function mkNeq(v: unknown, e: unknown): { passed: boolean; message?: string } {
  const passed = !deepEqual(v, e)
  return { passed, ...(passed ? {} : { message: `expected not ${fmt(e)}` }) }
}
function checkType(v: unknown, t: string): { passed: boolean; message?: string } {
  const actual = v === null ? 'null'
    : Array.isArray(v) ? 'array'
    : (t === 'integer' && typeof v === 'number' && Number.isInteger(v)) ? 'integer'
    : typeof v
  const passed = actual === t
  return { passed, ...(passed ? {} : { message: `expected type ${t}, got ${actual}` }) }
}
function checkRegex(v: unknown, pattern: string, negate: boolean): { passed: boolean; message?: string } {
  const str = String(v)
  const matches = new RegExp(pattern).test(str)
  const passed = negate ? !matches : matches
  return { passed, ...(passed ? {} : { message: `expected ${negate ? 'not ' : ''}match /${pattern}/, got ${fmt(str)}` }) }
}
function checkContains(v: unknown, needle: unknown, negate: boolean): { passed: boolean; message?: string } {
  let found: boolean
  if (Array.isArray(v)) found = v.some(e => deepEqual(e, needle))
  else if (typeof v === 'string') found = v.includes(String(needle))
  else return { passed: false, message: `contains: value must be string or array, got ${typeof v}` }
  const passed = negate ? !found : found
  return { passed, ...(passed ? {} : { message: `expected ${negate ? 'not ' : ''}to contain ${fmt(needle)}` }) }
}
function checkIn(v: unknown, arr: unknown[], negate: boolean): { passed: boolean; message?: string } {
  const found = arr.some(e => deepEqual(e, v))
  const passed = negate ? !found : found
  return { passed, ...(passed ? {} : { message: `expected value ${negate ? 'not ' : ''}in ${fmt(arr)}` }) }
}
function checkLength(v: unknown, n: number, op: 'eq' | 'gte' | 'lte'): { passed: boolean; message?: string } {
  const len = Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : undefined
  if (len === undefined) return { passed: false, message: `length check: value has no length (got ${typeof v})` }
  const passed = op === 'eq' ? len === n : op === 'gte' ? len >= n : len <= n
  return { passed, ...(passed ? {} : { message: `expected length ${op === 'eq' ? '==' : op === 'gte' ? '>=' : '<='} ${n}, got ${len}` }) }
}
function numCmp(v: unknown, n: number, cmp: (a: number, b: number) => boolean, op: string): { passed: boolean; message?: string } {
  if (typeof v !== 'number') return { passed: false, message: `expected number for ${op} comparison, got ${typeof v}` }
  const passed = cmp(v, n)
  return { passed, ...(passed ? {} : { message: `expected ${op} ${n}, got ${v}` }) }
}
function runJs(v: unknown, expr: string, ctx: Record<string, unknown>): { passed: boolean; message?: string } {
  try {
    const fn = vm.runInNewContext(`(value, ctx) => (${expr})`, Object.freeze({})) as (v: unknown, c: unknown) => boolean
    const result = fn(v, Object.freeze({ ...ctx }))
    return { passed: Boolean(result) }
  } catch (err) {
    return { passed: false, message: `js: ${(err as Error).message}` }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (Array.isArray(a) || Array.isArray(b)) return false
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>
    const bObj = b as Record<string, unknown>
    const ak = Object.keys(aObj)
    const bk = Object.keys(bObj)
    if (ak.length !== bk.length) return false
    return ak.every(k => deepEqual(aObj[k], bObj[k]))
  }
  return false
}

function fmt(v: unknown): string {
  return JSON.stringify(v) ?? String(v)
}
