---
name: examen-creator
description: Use when the user wants to create or run an examen test suite YAML file. Covers writing suite files, all supported syntax, and running them with the CLI.
---

# Examen Suite Creator

Create and run declarative YAML test suites for the `examen` CLI tool. Suites test HTTP endpoints and CLI commands against one or more environments.

## What is examen

`examen` is a Node.js CLI at `/Users/daniellmorris/work/gigaplay/os/examen`. Run it via:

```bash
# Dev (no build needed)
cd /Users/daniellmorris/work/gigaplay/os/examen
tsx src/index.ts run <suite-file>

# Or from the compiled dist
node dist/index.js run <suite-file>
```

Suite files live **alongside the thing they verify**, not inside the examen repo. For example:

```
tests/release-v2122.yaml      # next to release notes
scripts/verify-deploy.yaml    # next to deploy scripts
```

## CLI Commands

```bash
# Run a suite
node dist/index.js run <file> [--only <id,id>] [--seed <n>] [--no-redact]

# Validate syntax only (no requests made)
node dist/index.js validate <file>
```

Flags:
- `--only id,id` — run only these test ids (and their dependsOn chain)
- `--seed 12345` — fix the PRNG seed for reproducible generator values
- `--no-redact` — show full Authorization headers and tokens in output

Exit codes: `0` = all pass, `1` = test failures, `2` = schema/parse error, `3` = runtime error.

## Suite File Structure

```yaml
name: "Human-readable suite name"       # optional
seed: 12345                             # optional — makes uuid/randomHex reproducible
defaultTimeoutMs: 15000                 # optional, default 30000

vars:                                   # suite-wide bindings, evaluated once at startup
  hosts:
    - { name: stage, url: "https://stage.example.com" }
    - { name: prod,  url: "https://prod.example.com" }
  token: "${env:API_TOKEN}"

generators:                             # fresh value on every ${gen.X} reference
  resourceId: "RES-${uuid}"
  tag: "probe-${randomHex:8}"
  ts: "${timestamp}"

tests:
  - id: myTest                          # optional but required for cross-test captures
    name: "Human-readable test name"    # required
    http:                               # exactly one of: http or cli
      method: POST
      url: "${vars.hosts[0].url}/api/v1/thing"
    expect:
      - status: 200
```

## Expression Language `${...}`

| Expression | Meaning |
|---|---|
| `${vars.hosts[0].url}` | Suite var, dot/bracket path |
| `${name}` | Short form of `${vars.name}` |
| `${env:API_TOKEN}` | Environment variable (hard error if missing) |
| `${gen.resourceId}` | Generator — fresh value each reference |
| `${host.url}` | forEach binding (when `as: host` is set) |
| `${tests.createThing.id}` | Cross-test capture from test with `id: createThing` |
| `${tests.createThing[stage].id}` | Keyed cross-test capture (when `keyBy` is set) |
| `${tests.createThing[0].id}` | Indexed cross-test capture (position 0) |
| `${value \| default("x")}` | Pipe: default if undefined |
| `${value \| split(",")}` | Pipe: split string into array |

Built-ins (inside generator templates only): `${uuid}`, `${randomHex:N}`, `${randomHex:N:upper}`, `${timestamp}`

## Scopes — where values live

| Scope | Declared in | Evaluated | Referenced as |
|---|---|---|---|
| Suite | `vars:` | Once at startup | `${vars.x}` or `${x}` |
| Case | `let:` | Once per forEach iteration | `${x}` |
| Response | `capture:` | After each step | `${x}` (same test) or `${tests.id.x}` |
| Generator | `generators:` | On every reference | `${gen.x}` |

Use `let:` when you need the same generated value in multiple places within one test case (e.g., create then verify the same id).

## HTTP Step

```yaml
http:
  method: POST                          # GET POST PUT PATCH DELETE HEAD OPTIONS
  url: "${host.url}/api/v1/resource"
  headers:
    Authorization: "Bearer ${vars.token}"
    Content-Type: application/json      # default when body is set
  body:
    id: "${caseId}"
    filter: "state.id"
  auth:                                 # alternative to header — basic or bearer
    user: "${env:RMQ_USER}"
    pass: "${env:RMQ_PASS}"
  timeoutMs: 10000                      # overrides defaultTimeoutMs
  followRedirects: false                # default false
```

Body is JSON-serialized and `Content-Type: application/json` is added automatically unless you override it.

## CLI Step

```yaml
cli:
  command: ssh
  args: ["ec2-user@${ec2}", "getent passwd staleuser; echo EXIT=$?"]
  timeoutMs: 10000
  shell: false                          # default — don't interpret shell metacharacters
  cwd: "/some/path"                     # optional working directory
  env:                                  # merged with process env
    MY_VAR: "value"
  stdin: "input text"                   # optional stdin
```

## Assertions (`expect:`)

Each assertion is a one-key object: `{ <path>: <matcher> }`.

**Shorthand** — a primitive is `{ equals: value }`:
```yaml
expect:
  - status: 200
  - exitCode: 0
```

**Path syntax:**
```
status          exitCode        stdout          stderr          duration_ms
body.state.id   body[0].id      body[*].id      headers."content-type"
```

**All matchers:**

```yaml
expect:
  - status: 200                                     # shorthand equals
  - status: { equals: 200 }                         # explicit equals
  - status: { notEquals: 404 }
  - body.id: { exists: true }                       # exists (not undefined)
  - body.id: { exists: false }                      # does not exist
  - body: { type: object }                          # string number integer boolean object array null
  - body.state.id: { matches: "^[A-F0-9]+$" }      # regex
  - body.state.id: { notMatches: "error" }
  - body.message: { contains: "success" }           # substring or array element
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
  - "body[*].delivery_mode": { all: { equals: 2 } } # every element
  - body.value: { js: "value > 0 && value < 1000" } # escape hatch
```

## Capture — read from response

```yaml
capture:
  thingId: body.state.id          # dot path into response body
  status:  status                 # top-level field
  etag:    headers.etag
```

Captured values are available as `${thingId}` in the same test, and as `${tests.<id>.thingId}` in later tests.

## forEach — iterate over a list

```yaml
# From a var
- id: checkHosts
  forEach: vars.hosts             # resolves to the array
  as: host
  http:
    method: GET
    url: "${host.url}/health"
  expect:
    - status: 200

# Inline array
- forEach: [setConfig, grantItems, grantStats]
  as: endpoint
  http:
    method: POST
    url: "${vars.hosts[0].url}/api/v1/${endpoint}"
  expect:
    - status: 403

# Inline array of objects
- forEach:
    - { host: stage, token: "${vars.tokens.mobile}", expected: 403 }
    - { host: stage, token: "${vars.tokens.debug}",  expected: 200 }
  as: case
  http:
    method: POST
    url: "${vars.hosts[0].url}/api/v1/login"
    headers: { Authorization: "Bearer ${case.token}" }
  expect:
    - status: "${case.expected}"
```

## Cross-test capture with keyBy

```yaml
- id: createResource
  forEach: vars.hosts
  as: host
  keyBy: host.name                      # index captures by host.name value
  let:
    caseId: "${gen.resourceId}"         # same value for whole iteration
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
    method: GET
    url: "${host.url}/api/v1/resource/${tests.createResource[host.name].resourceId}"
  expect:
    - status: 200
```

Without `keyBy`, captures are indexed by position: `${tests.createResource[0].resourceId}`.

## dependsOn and skipIf

```yaml
- id: readThing
  dependsOn: createThing            # skip if createThing failed
  # dependsOn: [stepA, stepB]       # multiple deps

- id: stageOnly
  forEach: vars.hosts
  as: host
  skipIf: "host.name == 'prod'"     # supports == and !=
```

## setup and teardown

```yaml
- id: queueCheck
  let:
    eventTag: "probe-${gen.ts}"
  setup:                              # runs before main step; failures abort the test
    http:
      method: POST
      url: "${vars.hosts[0].url}/api/v1/analytics"
      body: { event: "${eventTag}" }
  http:
    method: GET
    url: "${env:RMQ_URL}/api/queues/%2F/q.sink/get"
    auth: { user: "${env:RMQ_USER}", pass: "${env:RMQ_PASS}" }
    body: { count: 10, ackmode: "peek" }
  expect:
    - status: 200
  teardown:                           # always runs; failures don't affect pass/fail
    http:
      method: DELETE
      url: "${vars.hosts[0].url}/api/v1/analytics/${eventTag}"
```

## retry

```yaml
- id: waitForReady
  retry:
    count: 5        # max attempts including first
    delayMs: 2000   # wait between attempts
  http:
    method: GET
    url: "${vars.hosts[0].url}/health"
  expect:
    - status: 200
    - body.ready: true
```

## Minimal working example

```yaml
name: "API smoke check"
seed: 42

vars:
  baseUrl: "${env:API_URL}"

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

Run it:
```bash
API_URL=https://example.com node dist/index.js run my-suite.yaml --seed 42
```

## Common patterns

**Create then read:**
```yaml
tests:
  - id: create
    name: "Create resource"
    let:
      id: "${gen.resourceId}"
    http:
      method: POST
      url: "${vars.baseUrl}/api/resource"
      body: { id: "${id}" }
    capture:
      createdId: body.id
    expect:
      - status: 201

  - id: read
    name: "Read resource back"
    dependsOn: create
    http:
      method: GET
      url: "${vars.baseUrl}/api/resource/${tests.create.createdId}"
    expect:
      - status: 200
      - body.id: { equals: "${tests.create.createdId}" }
```

**Check all hosts:**
```yaml
vars:
  hosts:
    - { name: stage, url: "https://stage.example.com" }
    - { name: prod,  url: "https://prod.example.com" }

tests:
  - id: healthAll
    name: "Health check all hosts"
    forEach: vars.hosts
    as: host
    http:
      method: GET
      url: "${host.url}/health"
    expect:
      - status: 200
```

**Forbidden endpoints:**
```yaml
tests:
  - id: forbidden
    name: "Admin endpoints reject mobile token"
    forEach: [adminConfig, grantItems, exportData]
    as: endpoint
    http:
      method: POST
      url: "${vars.baseUrl}/api/${endpoint}"
      headers: { Authorization: "Bearer ${vars.mobileToken}" }
    expect:
      - status: 403
```

**CLI check:**
```yaml
tests:
  - id: serviceRunning
    name: "Service process is running"
    cli:
      command: systemctl
      args: ["is-active", "my-service"]
    expect:
      - exitCode: 0
      - stdout: { contains: "active" }
```
