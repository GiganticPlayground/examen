export type LookupFn = (path: string) => unknown

// When a string is exactly one ${...} expression, preserve the resolved value's type.
// When it contains other characters (prefix/suffix text), always return a string.
function renderValueString(template: string, lookup: LookupFn): unknown {
  const singleExpr = /^\$\{([^}]+)\}$/.exec(template)
  if (singleExpr) {
    const result = evalExpr(singleExpr[1]!.trim(), lookup)
    if (result === undefined) throw new Error(`Undefined template reference: \${${singleExpr[1]}}`)
    return result
  }
  return renderTemplate(template, lookup)
}

export function renderTemplate(template: string, lookup: LookupFn): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const result = evalExpr(expr.trim(), lookup)
    if (result === undefined) {
      throw new Error(`Undefined template reference: \${${expr}}`)
    }
    return String(result)
  })
}

export function renderValue(value: unknown, lookup: LookupFn): unknown {
  if (typeof value === 'string') return renderValueString(value, lookup)
  if (Array.isArray(value)) return value.map(v => renderValue(v, lookup))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderValue(v, lookup)])
    )
  }
  return value
}

function evalExpr(expr: string, lookup: LookupFn): unknown {
  // Handle pipes: split on ' | ' (with spaces to avoid matching URL segments)
  const pipeIdx = expr.indexOf(' | ')
  if (pipeIdx !== -1) {
    const base = evalExpr(expr.slice(0, pipeIdx).trim(), lookup)
    return applyPipe(base, expr.slice(pipeIdx + 3).trim())
  }
  // env: prefix
  if (expr.startsWith('env:')) {
    const varName = expr.slice(4)
    const val = process.env[varName]
    if (val === undefined) throw new Error(`Undefined env var: ${varName}`)
    return val
  }
  return lookup(expr)
}

function applyPipe(value: unknown, pipe: string): unknown {
  if (pipe.startsWith('default(') && pipe.endsWith(')')) {
    const def = pipe.slice(8, -1).replace(/^["']|["']$/g, '')
    return value ?? def
  }
  if (pipe.startsWith('split(') && pipe.endsWith(')')) {
    const sep = pipe.slice(6, -1).replace(/^["']|["']$/g, '')
    if (typeof value !== 'string') throw new Error(`split() requires a string value`)
    return value.split(sep)
  }
  throw new Error(`Unknown pipe: ${pipe}`)
}
