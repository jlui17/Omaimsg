import { readStatePath } from './paths.js'
import { readJsonState, writeJsonState } from './jsonstate.js'

const VERSION = 1
const LABEL = 'read-state'

// One timestamp per chat: the newest message this install has been shown.
// Nothing else can reconstruct it -- Apple's own boundary only moves when the
// Mac or a phone reads the chat, and marking read back on the Mac needs the
// Private API this setup does not use. So it is state, not cache, and it lives
// beside pins.json rather than under XDG_CACHE_HOME.
export class ReadStateStore {
  constructor(path = readStatePath) {
    this.path = path
    const loaded = readJsonState(path, VERSION, LABEL)
    this.opened = new Map(Object.entries(loaded?.opened || {}).filter(([, ts]) => Number.isFinite(ts)))
  }

  openedTs(chatGuid) {
    return this.opened.get(chatGuid) || 0
  }

  // The boundary only moves forward, and says so: a caller that changed nothing
  // gets `false` and can skip whatever it would have told clients.
  markOpened(chatGuid, ts) {
    if (!Number.isFinite(ts) || ts <= this.openedTs(chatGuid)) return false
    this.opened.set(chatGuid, ts)
    writeJsonState(this.path, VERSION, LABEL, { opened: Object.fromEntries(this.opened) })
    return true
  }
}
