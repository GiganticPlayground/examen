import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { ExamenTestSuite } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadSchema(): object {
  const schemaPath = join(__dirname, '../docs/schema.json')
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as object
}

export function loadSuite(filePath: string): ExamenTestSuite {
  const absPath = resolve(filePath)
  let raw: string
  try {
    raw = readFileSync(absPath, 'utf8')
  } catch {
    throw new ExamenError(`Cannot read file: ${absPath}`, 2)
  }

  const doc = parseDocument(raw, { prettyErrors: true })

  if (doc.errors.length > 0) {
    const msgs = doc.errors.map(e => {
      const pos = e.linePos?.[0]
      return pos ? `  Line ${pos.line}, col ${pos.col}: ${e.message}` : `  ${e.message}`
    })
    throw new ExamenError(`YAML parse errors in ${filePath}:\n${msgs.join('\n')}`, 2)
  }

  const data = doc.toJS() as unknown

  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const schema = loadSchema()
  const validate = ajv.compile(schema)

  if (!validate(data)) {
    const msgs = (validate.errors ?? []).map(e =>
      `  ${e.instancePath || '(root)'}: ${e.message ?? 'invalid'}`
    )
    throw new ExamenError(`Schema validation failed for ${filePath}:\n${msgs.join('\n')}`, 2)
  }

  return data as ExamenTestSuite
}

export class ExamenError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message)
    this.name = 'ExamenError'
  }
}
