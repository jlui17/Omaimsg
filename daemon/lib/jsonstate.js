import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from './logger.js'

// The discipline both persisted files follow: versioned so a later shape change
// is detected rather than misread, written through a temp file so an interrupted
// write cannot leave a partial one, and never fatal -- an unreadable file starts
// the daemon cold instead of stopping it.
export function readJsonState(path, version, label) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`${label}: could not read the file`, { err: err.message })
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== version) {
      logger.warn(`${label}: discarding a file this daemon cannot read`, { version: parsed?.version })
      return null
    }
    return parsed
  } catch (err) {
    logger.warn(`${label}: discarding a corrupt file`, { err: err.message })
    return null
  }
}

export function writeJsonState(path, version, label, payload) {
  const temp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, JSON.stringify({ version, ...payload }))
    renameSync(temp, path)
  } catch (err) {
    logger.warn(`${label}: could not write the file`, { err: err.message })
  }
}
