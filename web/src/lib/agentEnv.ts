// The New agent dialog's environment variables: KEY=value lines (the server checks the same rules,
// internal/server/agentenv.go). Errors name the line and the key, never a value: values may be secrets.

export type EnvParse = { env: Record<string, string>; keys: string[]; errors: string[] }

const keyRe = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The variables minbox sets itself for an agent (and every MINBOX_*). */
export const RESERVED_ENV = ['TERM', 'COLORTERM', 'OPENCODE_CONFIG_CONTENT']

export function reservedEnvKey(key: string): boolean {
  return RESERVED_ENV.includes(key) || key.toUpperCase().startsWith('MINBOX_')
}

/** Parses KEY=value lines. Blank lines and # comments are skipped; a leading "export " is allowed; the value is everything after the first =, as typed. */
export function parseEnvLines(text: string): EnvParse {
  const env: Record<string, string> = Object.create(null) // no prototype: a key such as "constructor" is just a key
  const keys: string[] = []
  const errors: string[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const n = i + 1
    const body = line.replace(/^\s*(export\s+)?/, '')
    const eq = body.indexOf('=')
    if (eq < 0) {
      errors.push(`Line ${n}: expected KEY=value`)
      return
    }
    const key = body.slice(0, eq).trim()
    const value = body.slice(eq + 1)
    if (!keyRe.test(key)) {
      errors.push(`Line ${n}: ${key ? `“${key}” is not a variable name` : 'the name is missing'} (letters, digits and _, not starting with a digit)`)
      return
    }
    if (reservedEnvKey(key)) {
      errors.push(`Line ${n}: ${key} is set by minbox itself and cannot be overridden`)
      return
    }
    if (key in env) {
      errors.push(`Line ${n}: ${key} is set twice`)
      return
    }
    env[key] = value
    keys.push(key)
  })
  return { env, keys, errors }
}
