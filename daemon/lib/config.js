import { readFileSync } from 'node:fs'
import { configPath } from './paths.js'
import { logger } from './logger.js'

const DEFAULT_METHOD = 'apple-script'

// No config file is a valid, runnable state: the daemon still comes up and
// listens on the socket, it just reports connection:"error" until one exists.
export function loadConfig() {
  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: `no config file at ${configPath}` }
    }
    return { ok: false, error: `could not read ${configPath}: ${err.message}` }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `invalid JSON in ${configPath}: ${err.message}` }
  }

  if (!parsed.serverUrl || !parsed.password) {
    return { ok: false, error: `${configPath} must set "serverUrl" and "password"` }
  }

  return {
    ok: true,
    serverUrl: String(parsed.serverUrl).replace(/\/+$/, ''),
    password: String(parsed.password),
    method: parsed.method === 'private-api' ? 'private-api' : DEFAULT_METHOD
  }
}

export function logConfigOutcome(config) {
  if (config.ok) {
    logger.info(`config loaded from ${configPath}`, { serverUrl: config.serverUrl, method: config.method })
  } else {
    logger.warn(`config: ${config.error}`)
  }
}
