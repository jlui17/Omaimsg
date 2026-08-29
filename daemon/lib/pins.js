import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pinsPath } from './paths.js'
import { logger } from './logger.js'

// Apple stores iPhone chat-pin state outside chat.db: the BlueBubbles Chat
// entity has no isPinned-like column (checked
// packages/server/src/server/databases/imessage/entity/Chat.ts) and the
// Postman collection has no pin endpoint, so BlueBubbles can't see or serve
// pins. They're daemon-local, persisted here as a flat JSON array of guids.
export class PinStore {
  constructor(path = pinsPath) {
    this.path = path
    this.pinned = new Set(this._load())
  }

  _load() {
    try {
      const guids = JSON.parse(readFileSync(this.path, 'utf8'))
      return Array.isArray(guids) ? guids : []
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn('pins: could not read pins.json', { err: err.message })
      return []
    }
  }

  _save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify([...this.pinned]))
    } catch (err) {
      logger.warn('pins: could not write pins.json', { err: err.message })
    }
  }

  set(chatGuid, pinned) {
    if (pinned) this.pinned.add(chatGuid)
    else this.pinned.delete(chatGuid)
    this._save()
  }
}
