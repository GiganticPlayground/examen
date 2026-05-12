import seedrandom from 'seedrandom'

export type Rng = seedrandom.PRNG

export function createRng(seed: number | string | undefined): Rng {
  return seedrandom(seed !== undefined ? String(seed) : undefined)
}

// Built-ins available inside generator template strings only
export function evalBuiltin(name: string, arg: string | undefined, rng: Rng): string {
  switch (name) {
    case 'uuid': {
      // RFC 4122 v4 from seeded RNG
      const hex = () => Math.floor(rng() * 16).toString(16)
      function r(n: number) { return Array.from({length: n}, hex).join('') }
      return `${r(8)}-${r(4)}-4${r(3)}-${['8','9','a','b'][Math.floor(rng()*4)] ?? '8'}${r(3)}-${r(12)}`
    }
    case 'randomHex': {
      const len = arg ? parseInt(arg.split(':')[0] ?? '8', 10) : 8
      const upper = arg?.includes(':upper') ?? false
      const s = Array.from({length: len}, () => Math.floor(rng() * 16).toString(16)).join('')
      return upper ? s.toUpperCase() : s
    }
    case 'timestamp':
      return String(Date.now())
    default:
      throw new Error(`Unknown generator built-in: ${name}`)
  }
}
