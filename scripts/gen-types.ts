import { compileFromFile } from 'json-schema-to-typescript'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(__dirname, '../docs/schema.json')
const outPath = join(__dirname, '../src/types.ts')

const ts = await compileFromFile(schemaPath, {
  additionalProperties: false,
  bannerComment: '/* eslint-disable */\n// AUTO-GENERATED — do not edit by hand\n// Run: npm run gen-types',
})
writeFileSync(outPath, ts)
console.log('types.ts generated')
