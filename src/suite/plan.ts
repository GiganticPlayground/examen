import type { ExamenTestSuite, Test } from '../types.js'
import type { TestCase } from './forEach.js'
import type { Scope } from '../eval/context.js'
import { expandTest } from './forEach.js'

export interface Plan {
  cases: TestCase[]
  testIndex: Map<string, Test>
}

export function buildPlan(suite: ExamenTestSuite, scope: Scope): Plan {
  const testIndex = new Map<string, Test>()

  for (const test of suite.tests) {
    if (test.id) {
      if (testIndex.has(test.id)) {
        throw new Error(`Duplicate test id: "${test.id}"`)
      }
      testIndex.set(test.id, test)
    }
  }

  // Validate dependsOn — must reference earlier test ids
  const seenIds = new Set<string>()
  for (const test of suite.tests) {
    const deps = normalizeDeps(test.dependsOn)
    for (const dep of deps) {
      if (!seenIds.has(dep)) {
        if (!testIndex.has(dep)) {
          throw new Error(`Test "${test.name}" dependsOn unknown id: "${dep}"`)
        }
        throw new Error(
          `Test "${test.name}" dependsOn "${dep}" which appears later in the suite (dependsOn must point to earlier tests)`
        )
      }
    }
    if (test.id) seenIds.add(test.id)
  }

  // Static warning: tests referencing ${tests.<id>...} without declaring dependsOn
  for (const test of suite.tests) {
    const deps = new Set(normalizeDeps(test.dependsOn))
    const refs = findTestRefs(test)
    for (const ref of refs) {
      if (!deps.has(ref)) {
        process.stderr.write(
          `[warn] Test "${test.name}" references \${tests.${ref}...} but does not declare dependsOn: "${ref}"\n`
        )
      }
    }
  }

  const cases: TestCase[] = []
  for (const test of suite.tests) {
    cases.push(...expandTest(test, scope))
  }

  return { cases, testIndex }
}

export function normalizeDeps(dependsOn: string | string[] | undefined): string[] {
  if (!dependsOn) return []
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn]
}

function findTestRefs(test: Test): string[] {
  const str = JSON.stringify(test)
  const refs: string[] = []
  const re = /\$\{tests\.([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(str)) !== null) {
    const ref = m[1]
    if (ref) refs.push(ref)
  }
  return [...new Set(refs)]
}
