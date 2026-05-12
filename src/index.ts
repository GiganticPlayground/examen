#!/usr/bin/env node
import { loadSuite, ExamenError } from './suite/load.js'
import { runSuite } from './suite/run.js'
import { printCase, printSummary } from './output.js'

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') {
  console.log(`Usage:
  examen run <file> [--only <id,id>] [--seed <n>] [--no-redact]
  examen validate <file>`)
  process.exit(0)
}

if (command === 'validate') {
  const file = args[1]
  if (!file) {
    console.error('Usage: examen validate <file>')
    process.exit(2)
  }
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
    console.error('Usage: examen run <file> [--only id,id] [--seed n] [--no-redact]')
    process.exit(2)
  }

  let only: string[] | undefined
  let seed: number | string | undefined
  let noRedact = false

  for (let i = 2; i < args.length; i++) {
    const flag = args[i]
    if ((flag === '--only' || flag === '-o') && args[i + 1]) {
      only = args[++i]!.split(',').map(s => s.trim())
    } else if ((flag === '--seed' || flag === '-s') && args[i + 1]) {
      seed = parseInt(args[++i]!, 10)
    } else if (flag === '--no-redact') {
      noRedact = true
    }
  }

  const start = Date.now()
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
  console.error(`Unknown command: ${command}`)
  process.exit(2)
}
