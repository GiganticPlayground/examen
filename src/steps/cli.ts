import { execa } from 'execa'
import type { CliStep } from '../types.js'
import type { Scope } from '../context.js'
import { createLookup } from '../context.js'
import { renderTemplate } from '../template.js'

export interface CliResponse {
  exitCode: number
  stdout: string
  stderr: string
  duration_ms: number
  timedOut: boolean
}

export async function runCliStep(
  step: CliStep,
  scope: Scope,
  defaultTimeoutMs: number
): Promise<CliResponse> {
  const lookup = createLookup(scope)
  const command = renderTemplate(step.command, lookup)
  const args = (step.args ?? []).map(a => renderTemplate(a, lookup))
  const timeoutMs = step.timeoutMs ?? defaultTimeoutMs
  const start = Date.now()

  const result = await execa(command, args, {
    shell: step.shell ?? false,
    timeout: timeoutMs,
    ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...(step.env ?? {}) }).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
    ...(step.stdin !== undefined ? { input: step.stdin } : {}),
    reject: false,
  })

  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    duration_ms: Date.now() - start,
    timedOut: result.timedOut,
  }
}
