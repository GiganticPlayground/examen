import { request } from 'undici'
import type { HttpStep } from '../types.js'
import type { Scope } from '../context.js'
import { createLookup } from '../context.js'
import { renderTemplate, renderValue } from '../template.js'

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
  duration_ms: number
  rawBody: string
}

export async function runHttpStep(
  step: HttpStep,
  scope: Scope,
  defaultTimeoutMs: number
): Promise<HttpResponse> {
  const lookup = createLookup(scope)
  const url = renderTemplate(step.url, lookup)
  const method = step.method

  const rawHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(step.headers ?? {})) {
    rawHeaders[k] = renderTemplate(v, lookup)
  }

  let body: string | undefined
  if (step.body !== undefined) {
    const rendered = renderValue(step.body as unknown, lookup)
    if (!rawHeaders['Content-Type'] && !rawHeaders['content-type']) {
      rawHeaders['Content-Type'] = 'application/json'
    }
    body = JSON.stringify(rendered)
  }

  // Auth
  if (step.auth) {
    if ('user' in step.auth) {
      const user = renderTemplate(step.auth.user, lookup)
      const pass = renderTemplate(step.auth.pass, lookup)
      const creds = Buffer.from(`${user}:${pass}`).toString('base64')
      rawHeaders['Authorization'] = `Basic ${creds}`
    } else {
      rawHeaders['Authorization'] = `Bearer ${renderTemplate(step.auth.bearer, lookup)}`
    }
  }

  const timeoutMs = step.timeoutMs ?? defaultTimeoutMs
  const start = Date.now()

  try {
    const res = await request(url, {
      method,
      headers: rawHeaders,
      ...(body !== undefined ? { body } : {}),
      maxRedirections: step.followRedirects ? 10 : 0,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    })

    const rawBody = await res.body.text()
    const duration_ms = Date.now() - start

    const resHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers)) {
      resHeaders[k] = Array.isArray(v) ? v.join(', ') : (v ?? '')
    }

    const ct = resHeaders['content-type'] ?? ''
    let parsedBody: unknown = rawBody
    if (ct.includes('application/json') || ct.includes('+json')) {
      try { parsedBody = JSON.parse(rawBody) } catch { parsedBody = rawBody }
    }

    return { status: res.statusCode, headers: resHeaders, body: parsedBody, duration_ms, rawBody }
  } catch (err) {
    const duration_ms = Date.now() - start
    const e = err as NodeJS.ErrnoException
    const isTimeout = e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT'
    throw Object.assign(e, { duration_ms, timedOut: isTimeout })
  }
}
