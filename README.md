# examen

Declarative HTTP and CLI test runner. Define test suites in YAML — assert status codes, response bodies, headers, exit codes, and timing. Supports chained tests, parallel host checks, retries, setup/teardown, and a small expression language for dynamic values.

## Why examen?

Most test frameworks are built for unit and integration tests that run inside a codebase. examen is built for a different problem: **verifying that a deployed environment is actually working**.

You write a YAML file that describes what your system should do — hit this endpoint, get this response, check these fields — and examen runs it against real infrastructure. No test harness to set up, no language runtime to match, no mocking. Just a file you can commit next to your deploy scripts and run from anywhere.

Common use cases:
- **Release verification** — run a suite after every deploy to confirm the environment is healthy before marking it complete
- **Multi-host smoke tests** — iterate the same checks across staging, production, and regional endpoints in a single run
- **API contract checks** — assert that a third-party or internal API still behaves the way your system depends on
- **CLI tool validation** — verify that scripts, SSH commands, or system processes return expected output and exit codes
- **Chained workflow tests** — create a resource, read it back, assert on the result, then clean it up — all in one suite

Because suite files are plain YAML with no dependencies, they live alongside whatever they verify: next to a deploy script, in a release notes folder, or in a scripts directory. Any team member or CI job can run them with a single Docker command — no local toolchain required.

---

## Running examen

### Option 1 — npx (no checkout required)

```bash
npx github:GiganticPlayground/examen run my-suite.yaml
npx github:GiganticPlayground/examen validate my-suite.yaml
```

npm clones the repo, builds it, and runs it. No install or auth required for public repos. The first run takes ~15s to build; subsequent runs use npm's cache.

---

### Option 2 — Docker

Pull and run directly from the GitHub Container Registry:

```bash
docker run --rm -v $(pwd):/work ghcr.io/giganticplayground/examen run suite.yaml
docker run --rm -v $(pwd):/work ghcr.io/giganticplayground/examen validate suite.yaml
```

Your current directory is mounted to `/work` inside the container, so relative file paths work as expected. Add a shell alias for convenience:

```bash
alias examen='docker run --rm -v $(pwd):/work ghcr.io/giganticplayground/examen'

examen run suite.yaml
examen validate suite.yaml
```

Available image tags:
- `latest` — latest build from `main`
- `main` — same as latest
- Short SHA tags for pinning to a specific commit

---

### Option 3 — Local checkout (development)

```bash
git clone git@github.com:GiganticPlayground/examen.git
cd examen
npm install
npm run build

node dist/index.js run examples/valid/full.yaml
node dist/index.js validate examples/valid/full.yaml
```

Or run TypeScript directly without building:

```bash
npx tsx src/index.ts run examples/valid/full.yaml
```

---

## CLI Reference

```
examen run <file> [options]
examen validate <file>
```

**`run`** — execute the suite and report results.

| Flag | Short | Description |
|---|---|---|
| `--env-file <path>` | `-E` | Load environment variables from a `.env` file |
| `--only id,id` | `-o` | Run only these test ids (comma-separated) |
| `--seed <n>` | `-s` | Fix the PRNG seed for reproducible generator values |
| `--no-redact` | | Show full Authorization headers and tokens in output |
| `--output <dir>` | `-O` | Write a structured run log to this directory |

**`validate`** — parse and schema-check the file without making any requests. Supports `--env-file`. Exit code `0` = valid, `2` = error.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | All tests passed |
| `1` | One or more test failures |
| `2` | Schema or parse error |
| `3` | Runtime error |

---

## Environment Variables

Reference environment variables anywhere in a suite file with `${env:VAR_NAME}`. examen will error immediately if a referenced variable is not set.

```yaml
vars:
  baseUrl: "${env:API_URL}"
  token:   "${env:API_TOKEN}"

tests:
  - name: "Authenticated request"
    http:
      method: GET
      url: "${vars.baseUrl}/profile"
      headers:
        Authorization: "Bearer ${vars.token}"
    expect:
      - status: 200
```

**Loading from a `.env` file:**

```bash
examen run suite.yaml --env-file .env.staging
```

The `.env` file format is standard — `KEY=value`, `export KEY=value`, quoted values, and `#` comments are all supported:

```bash
API_URL=https://staging.example.com
API_TOKEN="my-secret-token"
# DB_URL=unused
export REGION=us-east-1
```

**With Docker**, pass env vars via `-e` flags or `--env-file`:

```bash
# Inline
docker run --rm -v $(pwd):/work \
  -e API_URL=https://staging.example.com \
  -e API_TOKEN=my-token \
  ghcr.io/giganticplayground/examen run /work/suite.yaml

# From a file (Docker's --env-file, loaded into the container environment)
docker run --rm -v $(pwd):/work \
  --env-file .env.staging \
  ghcr.io/giganticplayground/examen run /work/suite.yaml

# Or mount the file and use examen's --env-file flag
docker run --rm -v $(pwd):/work \
  ghcr.io/giganticplayground/examen run /work/suite.yaml --env-file /work/.env.staging
```

---

## Output (`--output`)

When `--output <dir>` is provided, examen writes a structured run log:

```
output/
  2026-05-12T19-43-48-my-suite/
    summary.json        ← metadata, counts, and per-case status index
    run.md              ← full human-readable markdown log
    cases/
      01-healthCheck.json
      02-createUser.json
      03-deleteUser-SKIP.json
      ...
```

Each case file contains the full request, response, and assertion results. Non-passing cases have their status appended to the filename for easy filtering.

---

## Writing Test Suites

Suite files are YAML. A minimal example:

```yaml
name: "API smoke check"

vars:
  baseUrl: "https://api.example.com"

tests:
  - id: healthCheck
    name: "Health endpoint returns 200"
    http:
      method: GET
      url: "${vars.baseUrl}/health"
    expect:
      - status: 200
      - body: { type: object }
```

### Key concepts

**`vars`** — suite-wide bindings, evaluated once at startup.

**`generators`** — fresh value on every `${gen.x}` reference (uuid, randomHex, timestamp).

**`let`** — per-test bindings, pinned for the duration of one test case. Use this when you need the same generated value in multiple places within a test.

**`capture`** — extract values from a response for use in later tests via `${tests.<id>.<name>}`.

**`forEach`** — iterate a test over an array. Each item becomes one case.

**`dependsOn`** — skip this test if a named test failed.

**`retry`** — re-run the test up to N times with an optional delay between attempts.

**`setup` / `teardown`** — pre/post steps that run before and after the main step.

### All matchers

```yaml
expect:
  - status: 200                                    # shorthand equals
  - status: { equals: 200 }
  - status: { notEquals: 404 }
  - body.id: { exists: true }
  - body.id: { exists: false }
  - body: { type: object }                         # string number integer boolean object array null
  - body.name: { matches: "^[A-Z]" }              # regex
  - body.name: { notMatches: "error" }
  - body.message: { contains: "success" }
  - body.tags: { notContains: "deprecated" }
  - body.status: { in: ["active", "pending"] }
  - body.status: { notIn: ["deleted", "banned"] }
  - body.items: { lengthEquals: 3 }
  - body.items: { lengthGte: 1 }
  - body.items: { lengthLte: 10 }
  - body.count: { gt: 0 }
  - body.count: { gte: 1 }
  - body.count: { lt: 100 }
  - body.count: { lte: 99 }
  - "body[*].active": { all: { equals: true } }   # every element
  - body.value: { js: "value > 0 && value < 1000" }
```

### Expression language

| Expression | Meaning |
|---|---|
| `${vars.baseUrl}` | Suite var |
| `${name}` | Short form of `${vars.name}` |
| `${env:API_TOKEN}` | Environment variable (hard error if missing) |
| `${gen.resourceId}` | Generator — fresh value each reference |
| `${host.url}` | forEach binding (when `as: host`) |
| `${tests.createThing.id}` | Cross-test capture |
| `${tests.createThing[stage].id}` | Keyed cross-test capture (when `keyBy` is set) |
| `${value \| default("x")}` | Pipe: fallback if undefined |
| `${value \| split(",")}` | Pipe: split string into array |

See [`examples/valid/full.yaml`](examples/valid/full.yaml) for a complete working example covering all features against httpbin.org.

---

## Generating Suites with Claude

[`SKILL.md`](SKILL.md) is a Claude skill file that teaches Claude exactly how to write and run examen suite files. Load it into a Claude Code session to get AI-assisted test generation with full awareness of the syntax, matchers, expression language, and common patterns.

```bash
# In a Claude Code session, load the skill:
/skill SKILL.md
```

Then describe what you want to test and Claude will generate a valid suite file ready to run.

---

## Development

```bash
npm run build        # compile TypeScript to dist/
npm run dev          # run via tsx (no build step)
npm run typecheck    # type-check without emitting
npm run gen-types    # regenerate src/types.ts from docs/schema.json
```

The JSON Schema for suite files lives at [`docs/schema.json`](docs/schema.json). If you extend the schema, run `npm run gen-types` to regenerate the TypeScript types.
