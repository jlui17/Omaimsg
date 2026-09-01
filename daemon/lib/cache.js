import { cachePath } from './paths.js'
import { readJsonState, writeJsonState } from './jsonstate.js'
import { logger } from './logger.js'

const VERSION = 1
const LABEL = 'cache'
const WRITE_DELAY_MS = 2000

// The chat list and the warm thread pages, so a restarted daemon renders a
// populated panel before BlueBubbles answers a fetch that pages the whole
// account. Purely a latency win: every entry is revalidated by the existing
// cache-first contract, so a stale render corrects itself and losing the file
// costs nothing but the first paint. Read state is deliberately not in here --
// nothing can reconstruct that, so it lives in XDG_STATE_HOME instead.
export class ChatCache {
  constructor(path = cachePath) {
    this.path = path
    this.timer = null
    this.pending = null
  }

  load() {
    return readJsonState(this.path, VERSION, LABEL)
  }

  // Debounced rather than written per message: an active conversation would
  // otherwise rewrite the whole cache on every push. The snapshot is a callback
  // so a burst of mutations builds one, at flush time, rather than one each.
  schedule(snapshotFn) {
    this.pending = snapshotFn
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS)
    this.timer.unref()
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return
    const snapshot = this.pending()
    this.pending = null
    writeJsonState(this.path, VERSION, LABEL, snapshot)
    logger.debug('cache: written', { path: this.path })
  }
}
