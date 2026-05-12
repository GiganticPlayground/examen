# Examen — Design Spec

## Overview

Examen is a small Node.js utility that runs a YAML-defined suite of HTTP and CLI checks against one or more environments. It is purpose-built for service bulletins, audit follow-ups, and "did this fix actually deploy?" checks — not as a replacement for unit tests.

Tests are declared as data, not code. The runner provides templating, generators, per-test and suite-wide bindings, `forEach` iteration, cross-test capture/replay, and a small assertion DSL with an escape hatch for the cases that don't fit.

## Goals

- A single suite file can be read by a human in 60 seconds and understood end-to-end.
- The same suite can run against staging and production with one flag.
- Random values (UUIDs, hex strings, timestamps) are first-class.
- Loops over arrays of hosts/payloads without copy-paste.
- One test can hand a value to another (e.g. create-then-read).
- Failures show exactly which assertion failed, with the actual response and the request that produced it.
- Reproducible runs via a top-level `seed`.

## Non-goals

- Not a unit-test framework. No `describe/it`, no mocking, no code execution beyond `cli` steps.
- Not a load tester. Strictly sequential — no parallel execution.
- Not a contract test runner. There is no schema validation against an OpenAPI doc; assertions are explicit per test.
- No machine-readable output formats in v1 (no JUnit, no JSON reporter). Human-readable stdout only. If CI integration is needed later, layer it on.
- No browser automation, no GUI testing.

## Concepts

### Suite, test, step

A **suite** is a single YAML file containing `vars`, `generators`, and `tests`.

A **test** is one named case with optional `setup`, exactly one main `http` or `cli` step, optional `capture`, `expect`, and `teardown`.

A **step** is either an HTTP request or a CLI invocation. Steps produce a response object that is matched against assertions and that captures can pull values from.

### Scopes

There are four scopes for named values. Pick by where you want sameness vs. freshness.

| Scope            | Declared in                | Lifetime                                | Referenced as                                                        |
| ---------------- | -------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| Suite            | top-level `vars:`          | Whole run, evaluated once at startup    | `${vars.name}` or `${name}`                                          |
| Case             | per-test `let:`            | One `forEach` iteration of one test     | `${name}`                                                            |
| Step (response)  | `setup.capture`, `capture` | From the step's response to end of test | `${name}` (in same test) and `${tests.<id>.<name>}` (in later tests) |
| Inline (factory) | `generators:`              | Evaluated on every reference            | `${gen.name}`                                                        |

`${env:VAR}` is also available for environment variables.

### Expressions

A small grammar wrapped in `${...}`:

- Variable lookup: `${path.to.value}`, `${vars.hosts[0].url}`
- Environment: `${env:NAME}`
- Generators: `${gen.uuid}`
- Cross-test captures: `${tests.createThing.thingId}`, `${tests.createThing[stage].thingId}` (when `keyBy` is set on the producer)
- Built-ins inside generator templates only: `${uuid}`, `${randomHex:N}`, `${randomHex:N:upper}`, `${timestamp}`
- Pipes: `${value | default("x")}`, `${value | split(",")}`

Resist letting this become JavaScript. The escape hatch is the `js:` matcher.

### Generators

Pure factories. Each reference yields a fresh value:

```yaml
generators:
  resourceId: "RES-${uuid}"
  bandStyleId: "011${randomHex:34}"
  ts: "${timestamp}"
```

To pin a generator's output for the run, bind it in `vars:`. To pin it for a single case, bind it in `let:`.

### `let`

A per-test bindings map. Evaluated once per case after `forEach` binds its loop variable, before `setup`. Visible to `setup`, the main step, `capture`, `expect`, and `teardown`.

```yaml
let:
  caseId: "${gen.resourceId}"
```

Use `let` whenever a value needs to be the same across multiple references inside one case (the common case for "create then read").

### `capture`

A bindings map populated _after_ a step from its response. Works exactly like `let` for downstream references in the same test; additionally, if the test has an `id`, all captures become available to later tests as `${tests.<id>.<name>}`.

```yaml
capture:
  resourceId: body.state.id
  status: status
```

The right side is a JSONPath-ish expression evaluated against the step's response object: `body`, `status`, `headers.*`, `duration_ms` for HTTP; `exitCode`, `stdout`, `stderr`, `duration_ms` for CLI.

### `forEach` and cross-test captures

`forEach` clones the test per item. Combined with cross-test captures, this lets you fan out a setup and consume it elsewhere:

```yaml
- id: createResource
  forEach: vars.hosts
  as: host
  keyBy: host.name # captures indexed by ${host.name}
  let:
    caseId: "${gen.resourceId}"
  http:
    method: POST
    url: "${host.url}/api/v1/createResource"
    body: { id: "${caseId}" }
  capture:
    resourceId: "${caseId}"

- id: readResource
  forEach: vars.hosts
  as: host
  dependsOn: createResource
  http:
    method: POST
    url: "${host.url}/api/v1/getResource"
    body: { id: "${tests.createResource[host.name].resourceId}" }
  expect:
    - status: 200
    - body.id: { equals: "${tests.createResource[host.name].resourceId}" }
```

Without `keyBy`, captures from a `forEach` test are an array, addressable by index: `${tests.createResource[0].resourceId}`.

### Assertions

Each item in `expect` is a one-key object: `{ <path>: <matcher-or-shorthand> }`.

Path syntax:

- `status`, `exitCode`, `stdout`, `stderr`, `duration_ms` — top-level response fields
- `body.state.id` — dot notation into the response body
- `body[0].id` — array indexing
- `body[*].id` — every element (use with `all:`)
- `headers."content-type"` — quoted segments for special characters

Matchers:

| Matcher                     | Value type           | Meaning                                                             |
| --------------------------- | -------------------- | ------------------------------------------------------------------- |
| `equals` / `notEquals`      | any                  | Deep equality                                                       |
| `exists`                    | bool                 | Value is (`true`) or is not (`false`) `undefined`                   |
| `type`                      | string               | `string`, `number`, `integer`, `boolean`, `object`, `array`, `null` |
| `matches` / `notMatches`    | regex string         | Stringified value tested against regex                              |
| `contains` / `notContains`  | substring or element | String contains substring, or array contains element                |
| `in` / `notIn`              | array                | Value is/is not in the given array                                  |
| `lengthEquals`/`Gte`/`Lte`  | integer              | Array or string length                                              |
| `gt` / `gte` / `lt` / `lte` | number               | Numeric comparison                                                  |
| `all`                       | matcher              | Apply nested matcher to every element of an array                   |
| `js`                        | expression           | Escape hatch. Evaluated as `(value, ctx) => boolean`                |

Shorthand: a primitive value (`status: 200`) is sugar for `{ equals: 200 }`.

## Reference example

```yaml
name: "Release verification suite"
seed: 12345
defaultTimeoutMs: 15000

vars:
  hosts:
    - { name: stage, url: "https://stage.api.example.com" }
    - { name: prod, url: "https://prod.api.example.com" }
  tokens:
    mobile: "${env:MOBILE_TOKEN}"
    debug: "${env:DEBUG_TOKEN}"
  ec2_hosts: '${env:EC2_HOSTS | split(",")}'

generators:
  resourceId: "RES-${uuid}"
  bandStyleId: "011${randomHex:34}"
  ts: "${timestamp}"

tests:
  - id: filterIgnored
    name: "Response filter param is ignored on getResource"
    forEach: vars.hosts
    as: host
    skipIf: "host.name == 'prod'"
    let:
      caseId: "${gen.resourceId}"
    http:
      method: POST
      url: "${host.url}/api/v1/getResource"
      headers:
        Authorization: "Bearer ${vars.tokens.mobile}"
        Content-Type: application/json
      body:
        id: "${caseId}"
        filter: "state.id"
    expect:
      - status: 200
      - body: { type: object }
      - body.state: { exists: true }
      - body.state.id: { matches: "^[A-F0-9]+$" }

  - id: loginForbidden
    name: "/login rejected for mobile token; accepted for debug token in stage"
    forEach:
      - { host: stage, token: "${vars.tokens.mobile}", expected: 403 }
      - { host: stage, token: "${vars.tokens.debug}", expected: 200 }
      - { host: prod, token: "${vars.tokens.mobile}", expected: 403 }
    as: case
    http:
      method: POST
      url: "${vars.hosts[?(@.name == case.host)].url}/api/v1/login"
      headers: { Authorization: "Bearer ${case.token}" }
    expect:
      - status: "${case.expected}"

  - id: forbiddenEndpoints
    name: "Forbidden endpoints all return 403 for mobile token"
    forEach: [setConfig, grantItems, grantStats]
    as: endpoint
    http:
      method: POST
      url: "${vars.hosts[0].url}/api/v1/${endpoint}"
      headers: { Authorization: "Bearer ${vars.tokens.mobile}" }
    expect:
      - status: 403

  - id: queuePersistent
    name: "Message broker publish is persistent (delivery_mode = 2)"
    let:
      eventTag: "persistence-probe-${gen.ts}"
    setup:
      http:
        method: POST
        url: "${vars.hosts[0].url}/api/v1/analytics"
        headers: { Authorization: "Bearer ${vars.tokens.mobile}" }
        body:
          id: "${gen.resourceId}"
          event: "${eventTag}"
    http:
      method: GET
      url: "${env:RMQ_URL}/api/queues/%2F/q.AnalyticsSink/get"
      auth: { user: "${env:RMQ_USER}", pass: "${env:RMQ_PASS}" }
      body: { count: 10, ackmode: "peek" }
    expect:
      - status: 200
      - "body[*].properties.delivery_mode": { all: { equals: 2 } }

  - id: extraUserAbsent
    name: "Stale service account is absent on EC2 hosts"
    forEach: vars.ec2_hosts
    as: ec2
    cli:
      command: ssh
      args: ["ec2-user@${ec2}", "getent passwd staleuser; echo EXIT=$?"]
      timeoutMs: 10000
    expect:
      - exitCode: 0
      - stdout: { matches: "EXIT=2" }
      - stdout: { notContains: "staleuser:" }
```

## Runtime behavior

### Loading

1. Read YAML, validate against `examen.schema.json`. Fail fast on schema errors with line numbers.
2. Resolve the runner's PRNG from `seed` (or generate one and log it).
3. Evaluate `vars` once. Vars may reference `${env:...}` and `${gen.X}`. Generator references in `vars` are evaluated once at load and the value is pinned for the run.
4. Build the test plan: expand `forEach` into cases, validate `dependsOn` references (must point to earlier test ids), validate `as` is present when `forEach` is set.

### Per-case execution

For each test, for each `forEach` iteration:

1. Bind the `forEach` item under `as`.
2. Evaluate `skipIf`. Skip if truthy.
3. If `dependsOn` lists a failed or skipped test, skip with reason.
4. Evaluate `let`.
5. Run `setup` if present. Failures here cause the test to fail without running the main step (but `teardown` still runs).
6. Run the main `http` or `cli` step. Capture timing, response, exit info.
7. Evaluate `capture`. If a referenced path is missing, raise a hard error.
8. Evaluate `expect`. Collect all failures (do not short-circuit on the first).
9. If `retry` is configured and any expect failed, wait `delayMs` and rerun from step 6 up to `count` total attempts.
10. Run `teardown` if present. Its failures are reported but don't change the pass/fail status of the test itself.

### Failure handling

- Schema-invalid suite: exit code 2.
- Test failed (expect failures): exit code 1.
- All tests passed (or all expected failures were skips): exit code 0.
- Runtime error (network unreachable, missing env var, undefined template path): exit code 3.

Undefined template references are always hard errors. The runner never silently substitutes `undefined` into a request body.

## CLI

```
examen run <file> [--only <id,id>] [--seed <n>] [--no-redact]
examen validate <file>
```

Flags:

- `--only`: only run tests with the given ids (and their `dependsOn` chain).
- `--seed`: override the suite's seed for this run.
- `--no-redact`: show full Authorization headers and bearer tokens in output. Off by default; default behavior shows `Bearer ****abcd` (first/last 4 chars).

Output goes to stdout. Pipe / tee as needed. No `--reporter` flag, no `--bail`, no `--parallel` — the suite is small enough to run end-to-end every time.

## Output

The runner prints every request and every response. There are no silent successes. Each test case produces a block; a summary table follows at the end.

### HTTP success

```
────────────────────────────────────────────────────────────────────────────────
[1/8] filterIgnored / host=stage

  → POST https://stage.api.example.com/api/v1/getResource
    Authorization: Bearer ****abcd
    Content-Type:  application/json
    timeout:       15000ms
    body:
      {
        "id":     "RES-9f12-...",
        "filter": "state.id"
      }

  ← 200 OK  (212ms)
    content-type: application/json
    etag:         W/"ED17EFD4..."
    body:
      {
        "state": {
          "id":   "ABCDEF1234",
          "name": "..."
        }
      }

  ✓ status equals 200
  ✓ body is object
  ✓ body.state exists
  ✓ body.state.id matches /^[A-F0-9]+$/

  PASS  (200 OK, 212ms)
```

### HTTP failure

```
────────────────────────────────────────────────────────────────────────────────
[1/8] filterIgnored / host=stage

  → POST https://stage.api.example.com/api/v1/getResource
    Authorization: Bearer ****abcd
    body:
      { "id": "RES-9f12-...", "filter": "state.id" }

  ← 200 OK  (210ms)
    body:
      { "state": { "id": "abc-not-hex" } }

  ✓ status equals 200
  ✓ body is object
  ✓ body.state exists
  ✗ body.state.id matches /^[A-F0-9]+$/
      actual: "abc-not-hex"

  FAIL  (200 OK, 210ms)
  Reproduce: examen run suite.yaml --seed 12345 --only filterIgnored
```

### CLI success

```
────────────────────────────────────────────────────────────────────────────────
[5/8] extraUserAbsent / ec2=10.0.0.5

  $ ssh ec2-user@10.0.0.5 'getent passwd staleuser; echo EXIT=$?'
    timeout: 10000ms

  ← exit 0  (842ms)
    stdout:
      EXIT=2
    stderr:
      (empty)

  ✓ exitCode equals 0
  ✓ stdout matches /EXIT=2/
  ✓ stdout does not contain "staleuser:"

  PASS  (exit=0, 842ms)
```

### Skipped

```
────────────────────────────────────────────────────────────────────────────────
[2/8] filterIgnored / host=prod

  SKIP  (skipIf: host.name == 'prod')
```

### Final summary

```
═══════════════════════════════════════════════════════════════════════════════
SUMMARY                                                              seed=12345
═══════════════════════════════════════════════════════════════════════════════
  PASS   filterIgnored / host=stage                          200 OK   212ms
  SKIP   filterIgnored / host=prod                           —        —
  PASS   loginForbidden / case=0                             403      88ms
  PASS   loginForbidden / case=1                             200      91ms
  PASS   loginForbidden / case=2                             403      87ms
  PASS   forbiddenEndpoints / endpoint=setConfig             403      101ms
  PASS   queuePersistent                                     200 OK   312ms
  PASS   extraUserAbsent / ec2=10.0.0.5                      exit=0   842ms
───────────────────────────────────────────────────────────────────────────────
  7 passed · 1 skipped · 0 failed                                       1.4s
═══════════════════════════════════════════════════════════════════════════════
```

When a failure occurs, the summary row shows `FAIL` with the same status/exit info, and the reproduce hint appears once at the bottom:

```
Failures:
  filterIgnored / host=stage  →  body.state.id did not match /^[A-F0-9]+$/

Reproduce a failing case:
  examen run suite.yaml --seed 12345 --only filterIgnored
```

### Redaction

By default, the runner redacts these header values to first/last 4 characters: `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token`. `--no-redact` disables this. Bearer tokens inside request bodies are not auto-detected; if you want them redacted, name the field accordingly (anything matching `/token|secret|password|bearer/i` is redacted in body output).

### Bytes, encoding, large bodies

- Response bodies over 8 KB are truncated in stdout with `... (N more bytes)`. Full body is still used for assertions.
- Non-JSON response bodies are printed as a single quoted string if under 200 chars, otherwise truncated with the same suffix.
- CLI stdout/stderr over 4 KB are similarly truncated.

## Implementation hints

### Language and toolchain

- **TypeScript on Node 20+.** ESM modules (`"type": "module"` in `package.json`, `"module": "NodeNext"` in `tsconfig`).
- Run in dev with `tsx`; ship a compiled `dist/` via `tsc`. No bundler needed.
- `tsconfig.json` baseline: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`. These three catch the bugs that matter; everything else `strict: true` already gives you.

### Implicit typing — DRY by default

Prefer type inference over explicit annotations. Write the type once and let it flow:

- **Local variables and `const`s** — never annotate. `const url = new URL(host)` not `const url: URL = new URL(host)`.
- **Function return types** — omit on internal functions; let TS infer. Annotate only on exported/public API boundaries where the return type _is_ the contract.
- **Function parameters** — always annotate (TS can't infer these). Use the narrowest accurate type.
- **Discriminated unions** — define the union once, use type narrowing everywhere. Don't re-annotate the narrowed branch.
- **Schema-derived types** — generate the suite type from the JSON Schema with `json-schema-to-typescript` so the schema stays the single source of truth. Don't hand-maintain a parallel `interface Suite { ... }`.
- **Matcher / step / response shapes** — define each shape once, derive variants with `Pick`, `Omit`, `Extract` rather than retyping.

When to break the rule and add an explicit annotation:

- A function returns a complex inferred type that's hard to read at the call site.
- You want the compiler to enforce a return shape _before_ the implementation is written (`function foo(): Result { ... }` as a contract).
- A widening would happen otherwise (`const status = 200` infers `number`; `const status: 200 = 200` if you need the literal type).

### Suggested dependencies

- `yaml` — YAML parsing with source-position info (important for line-numbered errors).
- `ajv` + `json-schema-to-typescript` — schema validation at runtime, type generation at build time.
- `undici` — HTTP client (or native `fetch` if you don't need its extras).
- `execa` — CLI steps.
- `chalk` — output coloring.
- A tiny seeded PRNG (`seedrandom` or a 20-line xorshift).

### Suggested module layout

```
src/
  index.ts          # CLI entry
  types.ts          # generated from examen.schema.json; do not edit by hand
  load.ts           # YAML + schema validation
  context.ts        # build context, scopes, expression eval
  template.ts       # ${...} template parser
  generators.ts     # uuid, randomHex, timestamp
  forEach.ts        # expand a test into cases
  steps/
    http.ts
    cli.ts
  expect.ts         # path resolver + matchers
  capture.ts        # post-step binding
  plan.ts           # dependsOn validation, ordering
  output.ts         # the single (human) output writer
  run.ts            # top-level execution loop
scripts/
  gen-types.ts      # regenerates src/types.ts from examen.schema.json
```

The `types.ts` generation should run as a pre-build step so the schema is the only place these shapes are defined.

### Expression language

Keep the expression language deliberately small. Do not parse arbitrary JavaScript — every `${...}` is either a path, a generator call, a piped path, or one of a fixed set of built-ins. The `js:` matcher is the only place real JS evaluates, and it runs in a `vm.runInNewContext` sandbox with a frozen `ctx`.

## Acceptance criteria

The utility ships when these are all true. Many of these are tests of the runner itself.

1. **Schema validation**

   - `validate` exits 0 on every example in `examples/valid/*.yaml` and exits 2 on every example in `examples/invalid/*.yaml` with a line-numbered error.

2. **Vars evaluated once**

   - A `vars.x: "${gen.uuid}"` is identical in every test that reads it across the run.

3. **Let evaluated once per case**

   - A `let.x: "${gen.uuid}"` is identical across `setup`, `http`, `expect` within one `forEach` iteration, and different across iterations.

4. **Inline generators are fresh**

   - Two `${gen.uuid}` references in the same `expect` block produce different values.

5. **Seed reproducibility**

   - Running with `--seed 42` twice produces byte-identical request bodies and identical generator outputs.

6. **forEach + keyBy**

   - A test with `forEach: vars.hosts as host, keyBy: host.name` exposes captures as `${tests.<id>.stage.x}` and `${tests.<id>.prod.x}`.
   - Without `keyBy`, the same captures are addressable as `${tests.<id>[0].x}` and `${tests.<id>[1].x}`.

7. **dependsOn**

   - A failed test causes its dependents to be skipped with a reason that names the dependency.
   - A test that references `${tests.<id>...}` without declaring `dependsOn` produces a static warning at `validate` time.

8. **Undefined references are hard errors**

   - Referencing `${tests.missing.value}` or `${notDefined}` produces a clear error naming the unresolved path. The runner never substitutes the literal string `undefined` into a request body.

9. **Matchers correctness**

   - Each matcher has at least one positive and one negative test in the runner's own test suite.
   - `body[*]` with `all:` fails fast on the first non-matching element and reports its index.

10. **CLI step**

    - Captures `exitCode`, `stdout`, `stderr`, and `duration_ms`.
    - Respects `timeoutMs` (process killed on timeout, reported as failure).
    - `shell: false` is the default and does not interpret shell metacharacters in `args`.

11. **HTTP step**

    - Sends JSON body with `Content-Type: application/json` by default; respects override.
    - Follows redirects only when `followRedirects: true`.
    - Captures `status`, `headers`, `body` (parsed as JSON when content-type matches, otherwise raw string).

12. **Output completeness**

    - Every HTTP step prints method, URL, request headers (Authorization redacted), request body, response status, response headers, response body, and duration — for both passing and failing cases.
    - Every CLI step prints command, args, stdin (if any), exitCode, stdout, stderr, and duration — for both passing and failing cases.
    - Each `expect` assertion prints a `✓` or `✗` line with the path and matcher; failures include the actual value.
    - Final summary table lists every case with status + response status (HTTP) or exit code (CLI) + duration.

13. **Failure reproduction**

    - Output prints a one-line `--seed <n> --only <id>` hint that reproduces any failing case.

14. **Timeouts**

    - A step that exceeds `timeoutMs` (or `defaultTimeoutMs`) is aborted, reported as FAIL with reason `timeout`, and the partial response (if any) is shown.

15. **Redaction**
    - By default, `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token` header values are redacted in output to first/last 4 chars.
    - Body fields whose name matches `/token|secret|password|bearer/i` are redacted in printed bodies but used verbatim in the actual request.
    - `--no-redact` disables both.

## Out of scope for v1 (note for future)

- Machine-readable output (JUnit, NDJSON, JSON reporter).
- Parallel execution.
- Bail-on-first-failure.
- Tag-based filtering.
- Reading OpenAPI/Swagger to derive expects automatically.
- A `before:` / `after:` hook block at the suite level (use the first/last tests for now).
- Loading suites that include other suites.
- WebSocket or gRPC support.

## Filename and packaging

Package name: `examen`. Single bin entry `examen`. Suites live alongside the projects they verify, e.g. `tests/release-v2122.yaml` next to release notes.
