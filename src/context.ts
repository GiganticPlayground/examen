import type { Rng } from './generators.js'
import { evalBuiltin } from './generators.js'
import { renderTemplate, renderValue } from './template.js'

export interface Scope {
  vars: Record<string, unknown>
  let: Record<string, unknown>
  captures: Record<string, unknown>
  testCaptures: Record<string, unknown[]>          // id → array of capture objects (indexed)
  testCaptureKeys: Record<string, Record<string, unknown>>  // id → key → capture object
  generatorDefs: Record<string, string>
  rng: Rng
  forEachItem?: unknown
  forEachAs?: string
}

export function createLookup(scope: Scope): (path: string) => unknown {
  return function lookup(path: string): unknown {
    // gen. — evaluate generator fresh each time
    if (path.startsWith('gen.')) {
      const name = path.slice(4)
      const tmpl = scope.generatorDefs[name]
      if (tmpl === undefined) throw new Error(`Unknown generator: ${name}`)
      return renderTemplate(tmpl, makeBuiltinLookup(scope.rng))
    }
    // tests.<id>... cross-test captures
    if (path.startsWith('tests.')) {
      return resolveTestCapture(path.slice(6), scope)
    }
    // vars.<name> or vars.path.to.value
    if (path.startsWith('vars.')) {
      return resolvePath(scope.vars, path.slice(5))
    }
    // forEach binding (exact match or path prefix)
    if (scope.forEachAs && path === scope.forEachAs) return scope.forEachItem
    if (scope.forEachAs && path.startsWith(scope.forEachAs + '.')) {
      return resolvePath(scope.forEachItem, path.slice(scope.forEachAs.length + 1))
    }
    // let / captures (case scope) — short names
    if (path in scope.let) return scope.let[path]
    if (path in scope.captures) return scope.captures[path]
    // vars fallback (short form: ${name} instead of ${vars.name})
    if (path in scope.vars) return scope.vars[path]
    return undefined
  }
}

function makeBuiltinLookup(rng: Rng): (path: string) => unknown {
  return (path: string) => {
    const colonIdx = path.indexOf(':')
    const name = colonIdx === -1 ? path : path.slice(0, colonIdx)
    const arg = colonIdx === -1 ? undefined : path.slice(colonIdx + 1)
    return evalBuiltin(name, arg, rng)
  }
}

function resolveTestCapture(rest: string, scope: Scope): unknown {
  // rest = '<id>.<name>' or '<id>[key].<name>' or '<id>[0].<name>'
  const bracketIdx = rest.indexOf('[')
  const dotIdx = rest.indexOf('.')

  if (bracketIdx !== -1 && (dotIdx === -1 || bracketIdx < dotIdx)) {
    // keyed or indexed: id[key].name
    const id = rest.slice(0, bracketIdx)
    const closeIdx = rest.indexOf(']', bracketIdx)
    const rawKey = rest.slice(bracketIdx + 1, closeIdx)
    const afterBracket = rest.slice(closeIdx + 2) // skip '].'

    // numeric index → indexed captures
    if (/^\d+$/.test(rawKey)) {
      const idx = parseInt(rawKey, 10)
      const arr = scope.testCaptures[id]
      if (!arr || arr.length === 0) throw new Error(`No captures for test id: ${id}`)
      const entry = arr[idx]
      if (entry === undefined) throw new Error(`No capture at index ${idx} for test id: ${id}`)
      return afterBracket ? resolvePath(entry, afterBracket) : entry
    }

    // string key — may reference current forEach binding
    const key = scope.forEachAs && rawKey === scope.forEachAs
      ? String(scope.forEachItem)
      : rawKey
    const byKey = scope.testCaptureKeys[id]
    if (!byKey) throw new Error(`No keyed captures for test id: ${id}`)
    const capture = byKey[key]
    if (capture === undefined) throw new Error(`No capture keyed '${key}' for test id: ${id}`)
    return afterBracket ? resolvePath(capture, afterBracket) : capture
  }

  if (dotIdx !== -1) {
    const id = rest.slice(0, dotIdx)
    const name = rest.slice(dotIdx + 1)
    const arr = scope.testCaptures[id]
    if (!arr || arr.length === 0) throw new Error(`No captures for test id: ${id}`)
    return resolvePath(arr[0], name)
  }

  throw new Error(`Invalid test capture reference: tests.${rest}`)
}

export function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return obj
  const parts = tokenizePath(path)
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof part === 'number') {
      cur = (cur as unknown[])[part]
    } else {
      cur = (cur as Record<string, unknown>)[part]
    }
  }
  return cur
}

function tokenizePath(path: string): (string | number)[] {
  const parts: (string | number)[] = []
  // Matches: plain identifiers, [N] numeric indices, ["key"] quoted keys
  const re = /([^.["\]]+)|\[(\d+)\]|\["([^"]+)"\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) parts.push(m[1])
    else if (m[2] !== undefined) parts.push(parseInt(m[2], 10))
    else if (m[3] !== undefined) parts.push(m[3])
  }
  return parts
}

export function evalSuiteVars(
  rawVars: Record<string, unknown>,
  generatorDefs: Record<string, string>,
  rng: Rng
): Record<string, unknown> {
  const scope: Scope = {
    vars: {},
    let: {},
    captures: {},
    testCaptures: {},
    testCaptureKeys: {},
    generatorDefs,
    rng,
  }
  const lookup = createLookup(scope)
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rawVars)) {
    resolved[k] = renderValue(v, lookup)
  }
  scope.vars = resolved
  return resolved
}
