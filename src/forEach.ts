import type { Test } from './types.js'
import type { Scope } from './context.js'
import { createLookup, resolvePath } from './context.js'

export interface TestCase {
  test: Test
  iteration: number
  forEachItem?: unknown
  forEachAs?: string
  keyByValue?: string
}

export function expandTest(test: Test, scope: Scope): TestCase[] {
  if (!test.forEach) {
    return [{ test, iteration: 0 }]
  }
  if (!test.as) {
    throw new Error(`Test "${test.name}" has forEach but missing required "as" field`)
  }
  const asVar: string = test.as

  const lookup = createLookup(scope)
  let items: unknown[]

  if (typeof test.forEach === 'string') {
    // Could be "vars.hosts" or just "hosts"
    const resolved = resolvePath(scope.vars, test.forEach.replace(/^vars\./, ''))
      ?? lookup(test.forEach)
    if (!Array.isArray(resolved)) {
      throw new Error(`forEach expression "${test.forEach}" did not resolve to an array`)
    }
    items = resolved
  } else {
    // Inline array literal
    items = test.forEach as unknown[]
  }

  return items.map((item, iteration) => {
    let keyByValue: string | undefined
    if (test.keyBy) {
      const itemScope: Scope = { ...scope, forEachItem: item, forEachAs: asVar }
      const itemLookup = createLookup(itemScope)
      keyByValue = String(itemLookup(test.keyBy) ?? iteration)
    }
    return {
      test,
      iteration,
      forEachItem: item,
      forEachAs: asVar,
      ...(keyByValue !== undefined ? { keyByValue } : {}),
    }
  })
}
