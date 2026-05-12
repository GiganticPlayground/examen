import type { Scope } from './context.js'
import { resolvePath } from './context.js'
import type { HttpResponse } from '../steps/http.js'
import type { CliResponse } from '../steps/cli.js'

export function applyCapture(
  captureMap: Record<string, unknown>,
  response: HttpResponse | CliResponse,
  scope: Scope
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, pathExpr] of Object.entries(captureMap)) {
    const path = String(pathExpr)
    const value = resolvePath(response as unknown as Record<string, unknown>, path)
    if (value === undefined) {
      throw new Error(`Capture path "${path}" resolved to undefined in response`)
    }
    result[name] = value
    scope.captures[name] = value
  }
  return result
}
