#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSuite, ExamenError } from './suite/load.js'
import { runSuite } from './suite/run.js'
import { printCase, printSummary } from './output.js'
import { writeReport } from './reporter.js'

const HELP = `
Usage:
  examen run <file> [options]
  examen validate <file> [options]

Commands:
  run       Execute a test suite and report results
  validate  Parse and schema-check a suite file without making requests

Options:
  --env-file, -E <path>   Load environment variables from a .env file
  --only,     -o <ids>    Run only these test ids (comma-separated)
  --seed,     -s <n>      Fix the PRNG seed for reproducible runs
  --output,   -O <dir>    Write a structured run log to this directory
  --no-redact             Show full Authorization headers and tokens in output
  --help,     -h          Show this help

Environment variables:
  Reference any env var in your suite file with \${env:VAR_NAME}.
  Use --env-file to load vars from a .env file instead of the shell environment.

Exit codes:
  0  All tests passed
  1  One or more test failures
  2  Schema or parse error
  3  Runtime error

Examples:
  examen run suite.yaml
  examen run suite.yaml --env-file .env.staging
  examen run suite.yaml --only createUser,readUser --seed 42
  examen run suite.yaml --output ./output
  examen validate suite.yaml
`.trim()

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') {
  console.log(HELP)
  process.exit(0)
}

function parseEnvFile(filePath: string): void {
  let raw: string
  try {
    raw = readFileSync(resolve(filePath), 'utf8')
  } catch {
    throw new ExamenError(`Cannot read env file: ${filePath}`, 2)
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Strip optional leading "export "
    const stripped = trimmed.replace(/^export\s+/, '')
    const eqIdx = stripped.indexOf('=')
    if (eqIdx === -1) continue
    const key = stripped.slice(0, eqIdx).trim()
    let value = stripped.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) process.env[key] = value
  }
}

function parseFlags(startIdx: number): {
  only?: string[]
  seed?: number | string
  noRedact: boolean
  outputDir?: string
  envFile?: string
} {
  let only: string[] | undefined
  let seed: number | string | undefined
  let noRedact = false
  let outputDir: string | undefined
  let envFile: string | undefined

  for (let i = startIdx; i < args.length; i++) {
    const flag = args[i]
    if ((flag === '--only' || flag === '-o') && args[i + 1]) {
      only = args[++i]!.split(',').map(s => s.trim())
    } else if ((flag === '--seed' || flag === '-s') && args[i + 1]) {
      seed = parseInt(args[++i]!, 10)
    } else if (flag === '--no-redact') {
      noRedact = true
    } else if ((flag === '--output' || flag === '-O') && args[i + 1]) {
      outputDir = args[++i]
    } else if ((flag === '--env-file' || flag === '-E') && args[i + 1]) {
      envFile = args[++i]
    }
  }

  return {
    noRedact,
    ...(only !== undefined ? { only } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(envFile !== undefined ? { envFile } : {}),
  }
}

if (command === 'validate') {
  const file = args[1]
  if (!file) {
    console.error('Usage: examen validate <file> [--env-file <path>]')
    process.exit(2)
  }
  const { envFile } = parseFlags(2)
  if (envFile) parseEnvFile(envFile)
  try {
    loadSuite(file)
    console.log(`✓ ${file} is valid`)
    process.exit(0)
  } catch (err) {
    if (err instanceof ExamenError) {
      console.error(err.message)
      process.exit(err.exitCode)
    }
    throw err
  }
}

if (command === 'run') {
  const file = args[1]
  if (!file) {
    console.error('Usage: examen run <file> [options]\nRun examen --help for full usage.')
    process.exit(2)
  }

  const { only, seed, noRedact, outputDir, envFile } = parseFlags(2)
  if (envFile) parseEnvFile(envFile)

  const startedAt = new Date()
  const start = startedAt.getTime()
  try {
    const suite = loadSuite(file)
    const results = await runSuite(suite, {
      ...(only !== undefined ? { only } : {}),
      ...(seed !== undefined ? { seed } : {}),
      noRedact,
      suiteFile: file,
    })

    for (const r of results) {
      printCase(r, noRedact)
    }

    const effectiveSeed = seed ?? suite.seed ?? 'random'
    const totalMs = Date.now() - start
    printSummary(results, effectiveSeed, totalMs)

    if (outputDir !== undefined) {
      const runDir = writeReport({ suite, suiteFile: file, seed: effectiveSeed, startedAt, duration_ms: totalMs, results, outputDir })
      console.log(`\nReport written to ${runDir}/`)
    }

    const anyFailed = results.some(r => r.status === 'FAIL' || r.status === 'ERROR')
    process.exit(anyFailed ? 1 : 0)
  } catch (err) {
    if (err instanceof ExamenError) {
      console.error(err.message)
      process.exit(err.exitCode)
    }
    console.error((err as Error).message)
    process.exit(3)
  }
} else {
  console.error(`Unknown command: ${command}\nRun examen --help for usage.`)
  process.exit(2)
}
