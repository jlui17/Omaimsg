// The id -> state-path derivation. It lives entirely in the daemon (the plugin
// passes its manifest id through verbatim), so this is the only place the rules
// are pinned.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { instancePaths } from '../daemon/lib/paths.js'

const ENV = {
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_CONFIG_HOME: '/h/.config',
  XDG_STATE_HOME: '/h/.local/state',
  XDG_CACHE_HOME: '/h/.cache'
}

test('a missing id is the canonical install', () => {
  assert.equal(instancePaths(undefined, ENV).configPath, '/h/.config/io.omaimsg/config.json')
})

test('every state path is named by the id, with no id excepted', () => {
  for (const id of ['io.omaimsg', 'io.omaimsg.b']) {
    const paths = instancePaths(id, ENV)
    assert.equal(paths.configPath, `/h/.config/${id}/config.json`)
    assert.equal(paths.pinsPath, `/h/.local/state/${id}/pins.json`)
    assert.equal(paths.readStatePath, `/h/.local/state/${id}/read-state.json`)
    assert.equal(paths.attachmentsDir, `/h/.cache/${id}/attachments`)
    assert.equal(paths.cachePath, `/h/.cache/${id}/cache.json`)
  }
})

// The reason paths are named by the whole id and never by a shortened or
// scrubbed form of it: any such form collapses ids that differ only in the
// characters it drops, and the two installs then share a pins file.
test('ids that differ at all get different state paths', () => {
  const seen = new Set()
  for (const id of ['io.omaimsg.work.two', 'io.omaimsg.work-two', 'io.omaimsg.', 'io.omaimsg', 'com.fork.msg']) {
    const { configPath } = instancePaths(id, ENV)
    assert.equal(seen.has(configPath), false, `${id} collides on ${configPath}`)
    seen.add(configPath)
  }
})

// The plugin builds this same name by appending ".sock" to its manifest id, so
// keying it on the raw id rather than the instance is what lets the QML side
// hold none of the rules above.
test('the socket is named by the raw id', () => {
  assert.equal(instancePaths('io.omaimsg', ENV).socketPath, '/run/user/1000/io.omaimsg.sock')
  assert.equal(instancePaths('io.omaimsg.b', ENV).socketPath, '/run/user/1000/io.omaimsg.b.sock')
})

test('OMAIMSG_CONFIG overrides the derived config path', () => {
  const paths = instancePaths('io.omaimsg.b', { ...ENV, OMAIMSG_CONFIG: '/tmp/one-off.json' })
  assert.equal(paths.configPath, '/tmp/one-off.json')
  assert.equal(paths.pinsPath, '/h/.local/state/io.omaimsg.b/pins.json')
})
