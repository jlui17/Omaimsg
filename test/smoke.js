// End-to-end smoke test: mock BlueBubbles server -> daemon -> raw NDJSON
// client over the Unix socket. Exercises every frame in docs/daemon-protocol.md.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { instancePaths } from '../daemon/lib/paths.js'
import { ATTACHMENT_PNG, ATTACHMENT_PNG_FULL, ATTACHMENT_TEST, ATTACHMENT_TEST_CHAT, CONTACT_TEST_CHATS, NEVER_TRACKED_TEST, ORPHANED_TEST, SEED_UNREAD_TEST, SHORTCODE_TEST_CHAT, UNNAMED_GROUP_TEST_CHAT, UNREACHABLE_TEST } from './data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const daemonEntry = process.env.OMAIMSG_DAEMON_ENTRY || 'daemon/index.js'
const PORT = 39000 + (process.pid % 500)
const PASSWORD = 'testpass'
// Well under every canned chat's 10-30 messages, so a thread always has pages
// behind its first one to walk back through.
const CACHE_PAGE_SIZE = 5
const configPath = path.join(os.tmpdir(), `omaimsg-smoke-config-${process.pid}.json`)
// Per-PID everywhere so two worktrees can run the suite at once. The daemon is
// sandboxed by pointing its XDG dirs here rather than by handing it paths, so
// the run exercises the real derivation.
const runtimeDir = path.join(os.tmpdir(), `omaimsg-smoke-run-${process.pid}`)
const stateHome = path.join(os.tmpdir(), `omaimsg-smoke-state-${process.pid}`)
const cacheHome = path.join(os.tmpdir(), `omaimsg-smoke-cache-${process.pid}`)
const PLUGIN_ID = 'io.omaimsg'
const sandbox = { XDG_RUNTIME_DIR: runtimeDir, XDG_STATE_HOME: stateHome, XDG_CACHE_HOME: cacheHome }
// Where the daemon under test will put things, asked of the same function it
// asks, so this file holds no second copy of the naming rules.
const { socketPath, pinsPath: pinsFilePath } = instancePaths(PLUGIN_ID, sandbox)

const failures = []
function report(step, cond, detail) {
  if (cond) {
    console.log(`PASS: ${step}`)
  } else {
    console.log(`FAIL: ${step}${detail ? ` - ${detail}` : ''}`)
    failures.push(step)
  }
}

const spawned = []
function trackSpawn(child, name) {
  spawned.push({ child, name })
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`smoke: ${name} exited unexpectedly (code=${code} signal=${signal})`)
  })
  return child
}

function waitTcpOpen(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, 'localhost')
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error(`timeout waiting for port ${port}`))
        else setTimeout(attempt, 100)
      })
    }
    attempt()
  })
}

function waitFileExists(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (existsSync(filePath)) return resolve()
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${filePath}`))
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

class NdjsonClient {
  constructor(sock) {
    this.socket = sock
    this.buffer = ''
    this.backlog = []
    this.waiters = []
    sock.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let index = this.buffer.indexOf('\n')
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (line) this._deliver(JSON.parse(line))
        index = this.buffer.indexOf('\n')
      }
    })
  }

  _deliver(frame) {
    const index = this.waiters.findIndex((w) => w.predicate(frame))
    if (index === -1) {
      this.backlog.push(frame)
      return
    }
    const [waiter] = this.waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.resolve(frame)
  }

  send(obj) {
    this.socket.write(`${JSON.stringify(obj)}\n`)
  }

  waitFor(predicate, timeoutMs = 5000) {
    const index = this.backlog.findIndex(predicate)
    if (index !== -1) return Promise.resolve(this.backlog.splice(index, 1)[0])

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter)
          if (i !== -1) this.waiters.splice(i, 1)
          reject(new Error('timeout waiting for matching frame'))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  close() {
    this.socket.destroy()
  }
}

function connectClient(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath)
    sock.once('connect', () => resolve(new NdjsonClient(sock)))
    sock.once('error', reject)
  })
}

async function waitForConnected(client, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    client.send({ t: 'hello' })
    try {
      const frame = await client.waitFor((f) => f.t === 'state', 1500)
      if (frame.connection === 'connected') return frame
      if (frame.connection === 'error') throw new Error(`daemon reported connection error: ${frame.lastError}`)
    } catch (err) {
      if (Date.now() > deadline) throw err
    }
  }
  throw new Error('daemon never reached connection:"connected"')
}

// Cache-first means one `chats` request can be answered twice: the cached list,
// then the revalidated one if it differs (docs/daemon-protocol.md). A client
// applies both and the last one wins, so an assertion about the account's real
// state has to do the same rather than reading whichever frame arrived first.
//
// Nothing on the wire says which request a frame answers, so attribution rests
// on no earlier one still being outstanding. Draining the backlog cannot buy
// that, because a frame still in flight is not in it yet; waiting for silence
// can.
async function quiesceChats(client, quietMs = 300) {
  while (true) {
    try {
      await client.waitFor((f) => f.t === 'chats', quietMs)
    } catch {
      return
    }
  }
}

async function settledChats(client, payload = {}) {
  await quiesceChats(client)
  client.send({ t: 'chats', ...payload })
  let frame = await client.waitFor((f) => f.t === 'chats')
  try {
    frame = await client.waitFor((f) => f.t === 'chats', 1500)
  } catch {
    // One frame was the whole answer: the cache was already right.
  }
  return frame
}

// `state` frames carry no request id, and a `read` sent without collecting its
// reply leaves one in the backlog, so a later `waitFor` can answer with a total
// from before its own read. Drain first; nothing else emits `state` unprompted.
async function settledRead(client, chatGuid) {
  while (true) {
    try {
      await client.waitFor((f) => f.t === 'state', 200)
    } catch {
      break
    }
  }
  client.send({ t: 'read', chatGuid })
  return client.waitFor((f) => f.t === 'state', 3000)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Harness-only endpoints on the mock (test/server.js), not BlueBubbles routes.
async function mockControl(route, body) {
  const res = await fetch(`http://localhost:${PORT}/__test/${route}?password=${PASSWORD}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`mock control ${route} failed: ${res.status}`)
  return res.json()
}

// Contact loading happens off the socket "connect" event in the background,
// so the very first `chats` reply can race it; poll instead of asserting once.
async function waitForChatName(client, chatGuid, expectedName, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let chat
  while (Date.now() < deadline) {
    client.send({ t: 'chats', limit: 40 })
    const frame = await client.waitFor((f) => f.t === 'chats', 1000)
    chat = frame.chats.find((c) => c.guid === chatGuid)
    if (chat?.name === expectedName) return chat
    await sleep(150)
  }
  return chat
}

function cleanup() {
  for (const { child, name } of spawned) {
    try {
      child.kill('SIGTERM')
    } catch (err) {
      console.error(`smoke: failed to signal ${name}`, err.message)
    }
  }
  try {
    rmSync(configPath, { force: true })
  } catch {
    // Already gone.
  }
  for (const dir of [stateHome, cacheHome, runtimeDir]) {
    try {
      rmSync(dir, { force: true, recursive: true })
    } catch {
      // Already gone.
    }
  }
}

async function main() {
  trackSpawn(
    spawn('node', ['test/server.js', String(PORT)], {
      cwd: repoRoot,
      env: { ...process.env, MOCK_BB_PASSWORD: PASSWORD },
      stdio: ['ignore', 'ignore', 'inherit']
    }),
    'mock'
  )
  await waitTcpOpen(PORT, 5000)

  writeFileSync(configPath, JSON.stringify({
    serverUrl: `http://localhost:${PORT}`,
    password: PASSWORD,
    method: 'apple-script',
    cache: { threads: 30, messagesPerThread: CACHE_PAGE_SIZE }
  }))

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })

  trackSpawn(
    spawn('node', [daemonEntry], {
      cwd: repoRoot,
      // A page size (3) far smaller than the 7 canned chats forces every
      // `chats` command through the daemon's multi-page fetch for the whole
      // run -- the strongest regression net for the pagination fix.
      env: {
        ...process.env,
        OMAIMSG_CONFIG: configPath,
        OMAIMSG_PLUGIN_ID: PLUGIN_ID,
        ...sandbox,
        OMAIMSG_CHAT_PAGE_SIZE: '3'
      },
      stdio: ['ignore', 'ignore', 'inherit']
    }),
    'daemon'
  )
  await waitFileExists(socketPath, 5000)

  const client = await connectClient(socketPath)

  const stateFrame = await waitForConnected(client)
  report('hello -> state connected', stateFrame.connection === 'connected', JSON.stringify(stateFrame))

  // A push before any `chats` request seeds exactly one chat in the store. The
  // cache-first reply must not serve that as the list, or a client renders one
  // conversation and believes it has them all. This is the only window in the
  // run where the store has never been swept, so the check lives here.
  await mockControl('push-message', { chatGuid: ATTACHMENT_TEST_CHAT, text: 'seed the store' })
  await client.waitFor((f) => f.t === 'message' && f.chatGuid === ATTACHMENT_TEST_CHAT)

  // Read the FIRST frame, not the settled one: the cached reply is what a panel
  // renders immediately, and the revalidation behind it would hide a bad one.
  await quiesceChats(client)
  client.send({ t: 'chats', limit: 40 })
  const firstChatsFrame = await client.waitFor((f) => f.t === 'chats')
  report(
    'chats -> a push before the first request is not served as the list',
    firstChatsFrame.chats?.length === 7,
    `first frame carried ${firstChatsFrame.chats?.length} chats`
  )
  let chatsFrame = firstChatsFrame
  try {
    chatsFrame = await client.waitFor((f) => f.t === 'chats', 1500)
  } catch {
    // One frame was the whole answer.
  }
  report('chats -> 7 chats', chatsFrame.chats?.length === 7, `got ${chatsFrame.chats?.length}`)

  // Seeding from the server: the daemon scans at startup and the count attaches
  // to the chat list when it lands. The scan races the first request, so poll.
  let seeded = null
  for (let attempt = 0; attempt < 20 && !seeded; attempt++) {
    const frame = await settledChats(client, { limit: 40 })
    const chat = frame.chats.find((c) => c.guid === SEED_UNREAD_TEST.guid)
    if (chat && (chat.unread || 0) > 0) seeded = frame
    else await sleep(200)
  }
  const seededChat = seeded?.chats.find((c) => c.guid === SEED_UNREAD_TEST.guid)
  report(
    'unread -> seeded from the server for a chat with a read history',
    (seededChat?.unread || 0) === SEED_UNREAD_TEST.unread,
    `got ${seededChat?.unread}, wanted ${SEED_UNREAD_TEST.unread}`
  )
  const neverTracked = seeded?.chats.find((c) => c.guid === NEVER_TRACKED_TEST.guid)
  report(
    'unread -> a chat the Mac never recorded a read on seeds as zero',
    (neverTracked?.unread || 0) === 0,
    `got ${neverTracked?.unread}`
  )

  // The Mac reporting the chat read is what clears it, no `read` frame from us.
  await mockControl('read-status', { chatGuid: SEED_UNREAD_TEST.guid })
  let clearedFrame = null
  try {
    clearedFrame = await client.waitFor(
      (f) => f.t === 'chats' && f.chats.some((c) => c.guid === SEED_UNREAD_TEST.guid && (c.unread || 0) === 0),
      4000
    )
  } catch {
    // Reported by the assertion below.
  }
  report(
    'chat-read-status-changed -> the chat clears without a read frame',
    !!clearedFrame,
    'no chats frame arrived with the chat cleared'
  )
  // The seed left an unread behind. Clear it so the unread assertions further
  // down measure their own pushes and nothing else.
  client.send({ t: 'read', chatGuid: ATTACHMENT_TEST_CHAT })

  const oneToOneChat = chatsFrame.chats.find((c) => c.isGroup === false)
  const groupChat = chatsFrame.chats.find((c) => c.isGroup === true)
  report('chats -> isGroup false on a 1:1 chat', !!oneToOneChat, JSON.stringify(oneToOneChat))
  report('chats -> isGroup true on a group chat', !!groupChat, JSON.stringify(groupChat))

  const shortcodeChat = chatsFrame.chats.find((c) => c.guid === SHORTCODE_TEST_CHAT.guid)
  report(
    `shortcode stays raw: ${SHORTCODE_TEST_CHAT.guid} -> "${SHORTCODE_TEST_CHAT.rawName}" (not "${SHORTCODE_TEST_CHAT.wrongName}")`,
    shortcodeChat?.name === SHORTCODE_TEST_CHAT.rawName,
    `got "${shortcodeChat?.name}"`
  )

  const unnamedGroup = chatsFrame.chats.find((c) => c.guid === UNNAMED_GROUP_TEST_CHAT.guid)
  report(
    `unnamed group joins member names -> "${UNNAMED_GROUP_TEST_CHAT.expectedName}"`,
    unnamedGroup?.name === UNNAMED_GROUP_TEST_CHAT.expectedName,
    `got "${unnamedGroup?.name}"`
  )

  for (const { guid, resolvedName } of CONTACT_TEST_CHATS) {
    const chat = await waitForChatName(client, guid, resolvedName)
    report(`contact resolution: ${guid} -> "${resolvedName}"`, chat?.name === resolvedName, `got "${chat?.name}"`)
  }

  // Reordering: message the chat currently LAST in the list and confirm a
  // fresh `chats` fetch puts it first. This is the actual regression the Map
  // insertion-order bug caused (see report NOTES) -- an initial snapshot can
  // look sorted by coincidence, but a chat that gets a new message must move
  // to the front, which only re-sorting on every `chatList()` call guarantees.
  const orderTarget = chatsFrame.chats[chatsFrame.chats.length - 1].guid
  const orderTempId = 'order-test'
  client.send({ t: 'send', chatGuid: orderTarget, text: 'reorder me', tempId: orderTempId })
  await client.waitFor((f) => f.t === 'ack' && f.for === 'send' && f.tempId === orderTempId)
  await client.waitFor((f) => f.t === 'message' && f.chatGuid === orderTarget && f.message.fromMe === true)

  const reorderedFrame = await settledChats(client)
  report(
    'chats -> messaging the last chat moves it to the front',
    reorderedFrame.chats[0]?.guid === orderTarget,
    `got ${reorderedFrame.chats[0]?.guid}`
  )
  const descending = reorderedFrame.chats.every((c, i) => {
    if (i === 0) return true
    const prevTs = reorderedFrame.chats[i - 1].lastMessage?.ts ?? -Infinity
    const curTs = c.lastMessage?.ts ?? -Infinity
    return prevTs >= curTs
  })
  report('chats -> sorted by lastMessage.ts descending', descending, JSON.stringify(reorderedFrame.chats.map((c) => c.lastMessage?.ts)))

  // A pushed preview has to survive the next full sweep even when the server
  // answers `/chat/query` with no lastMessage for that chat. Losing it drops
  // the chat to the end of the recency sort with a blank preview, which is how
  // a chat carrying an unread ends up past the page any client asks for.
  const omitTarget = SHORTCODE_TEST_CHAT.guid
  await mockControl('push-message', { chatGuid: omitTarget, text: 'preview survives a sweep' })
  await client.waitFor((f) => f.t === 'message' && f.chatGuid === omitTarget)
  await mockControl('omit-last-message', { chatGuid: omitTarget })
  const sweptFrame = await settledChats(client)
  const swept = sweptFrame.chats.find((c) => c.guid === omitTarget)
  report(
    'chats -> a pushed preview survives a sweep that omits lastMessage',
    typeof swept?.lastMessage?.ts === 'number' && swept.lastMessage.text === 'preview survives a sweep',
    JSON.stringify(swept)
  )
  report(
    'chats -> that chat still sorts by recency, not to the end',
    sweptFrame.chats[0]?.guid === omitTarget,
    `got ${sweptFrame.chats[0]?.guid}, target at index ${sweptFrame.chats.findIndex((c) => c.guid === omitTarget)}`
  )
  await settledRead(client, omitTarget)

  // Drain orderTarget's canned reply and mark it read so its unread
  // contribution doesn't leak into the unread assertions below, which are
  // scoped to chatGuid's own send/reply round trip.
  await client.waitFor((f) => f.t === 'message' && f.chatGuid === orderTarget && f.message.fromMe === false, 6000)
  await settledRead(client, orderTarget)

  const chatGuid = chatsFrame.chats[0].guid
  client.send({ t: 'messages', chatGuid })
  const messagesFrame = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === chatGuid)
  report('messages -> non-empty list', Array.isArray(messagesFrame.messages) && messagesFrame.messages.length > 0)

  // Cache-first: chatGuid is warm from the request above, so a re-request must
  // answer well inside the fetch the daemon is simultaneously making.
  await mockControl('message-delay', { ms: 700 })
  const warmStart = Date.now()
  client.send({ t: 'messages', chatGuid })
  await client.waitFor((f) => f.t === 'messages' && f.chatGuid === chatGuid)
  const warmMs = Date.now() - warmStart
  report(
    'messages -> cached page replies ahead of the BlueBubbles fetch',
    warmMs < 300,
    `${warmMs}ms against a 700ms server delay`
  )

  // Revalidation: a change the daemon never saw over the socket must still
  // reach the client, as a second frame after the cached one.
  const staleMarker = `omaimsg-smoke-revalidate-${process.pid}`
  await mockControl('silent-message', { chatGuid, text: staleMarker })
  client.send({ t: 'messages', chatGuid })
  const staleFrame = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === chatGuid)
  report(
    'cached reply is served before the server change is known',
    !staleFrame.messages.some((m) => m.text === staleMarker)
  )
  await client.waitFor(
    (f) => f.t === 'messages' && f.chatGuid === chatGuid && f.messages.some((m) => m.text === staleMarker),
    5000
  )
  report('revalidation follows up with a second messages frame carrying the change', true)
  await mockControl('message-delay', { ms: 0 })

  // Cache-first for `chats`, the same contract the thread pages keep. The
  // store is warm from the requests above, so a re-request must answer well
  // inside the sweep the daemon is simultaneously making. Delay applies per
  // page, and the 7 canned chats page 3 at a time, so the sweep is slower than
  // one delay.
  await mockControl('chat-delay', { ms: 700 })
  const warmChatsStart = Date.now()
  client.send({ t: 'chats', limit: 40 })
  await client.waitFor((f) => f.t === 'chats')
  const warmChatsMs = Date.now() - warmChatsStart
  report(
    'chats -> cached list replies ahead of the account sweep',
    warmChatsMs < 300,
    `${warmChatsMs}ms against a 700ms per-page server delay`
  )

  // Revalidation: a change the daemon never saw over the socket still reaches
  // the client, as a second frame after the cached one.
  const staleChatMarker = `omaimsg-smoke-chats-revalidate-${process.pid}`
  await mockControl('silent-message', { chatGuid, text: staleChatMarker })
  client.send({ t: 'chats', limit: 40 })
  const staleChatsFrame = await client.waitFor((f) => f.t === 'chats')
  report(
    'chats -> cached list is served before the server change is known',
    !staleChatsFrame.chats.some((c) => c.lastMessage?.text === staleChatMarker)
  )
  await client.waitFor(
    (f) => f.t === 'chats' && f.chats.some((c) => c.lastMessage?.text === staleChatMarker),
    5000
  )
  report('chats -> revalidation follows up with a second frame carrying the change', true)
  await mockControl('chat-delay', { ms: 0 })

  // Attachments: chat 0 seeds one image-only message (test/data.js).
  client.send({ t: 'messages', chatGuid: ATTACHMENT_TEST_CHAT })
  const attachmentChatFrame = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === ATTACHMENT_TEST_CHAT)
  const attachmentMessage = attachmentChatFrame.messages.find((m) => m.attachments?.length)
  report(
    'attachment message carries {guid, mime, name} metadata',
    attachmentMessage?.attachments?.[0]?.guid === ATTACHMENT_TEST.guid
      && attachmentMessage?.attachments?.[0]?.mime === ATTACHMENT_TEST.mimeType
      && attachmentMessage?.attachments?.[0]?.name === ATTACHMENT_TEST.transferName,
    JSON.stringify(attachmentMessage?.attachments)
  )
  report(
    'attachment carries the pixel dimensions the UI reserves its box from',
    attachmentMessage?.attachments?.[0]?.width === ATTACHMENT_TEST.width
      && attachmentMessage?.attachments?.[0]?.height === ATTACHMENT_TEST.height,
    JSON.stringify(attachmentMessage?.attachments?.[0])
  )
  report(
    'attachment-only message keeps "[attachment]" placeholder text',
    attachmentMessage?.text === '[attachment]',
    JSON.stringify(attachmentMessage?.text)
  )
  report(
    'messages without attachments omit the field',
    attachmentChatFrame.messages.some((m) => !('attachments' in m)),
    'every message carried attachments'
  )

  client.send({ t: 'attachment', guid: ATTACHMENT_TEST.guid })
  const downloadFrame = await client.waitFor((f) => f.t === 'attachment' && f.guid === ATTACHMENT_TEST.guid)
  report(
    'attachment -> path under XDG_CACHE_HOME',
    typeof downloadFrame.path === 'string' && downloadFrame.path.startsWith(cacheHome),
    JSON.stringify(downloadFrame)
  )
  const downloadedBytes = existsSync(downloadFrame.path) ? readFileSync(downloadFrame.path) : null
  report('attachment -> downloaded bytes match the mock PNG', downloadedBytes !== null && downloadedBytes.equals(ATTACHMENT_PNG))
  report('attachment -> no .part file left behind', !existsSync(`${downloadFrame.path}.part`))

  // Cache: poison the file, re-request, and require the poison to survive --
  // a daemon that re-downloads on a warm guid would overwrite it.
  writeFileSync(downloadFrame.path, 'sentinel')
  client.send({ t: 'attachment', guid: ATTACHMENT_TEST.guid })
  const cachedFrame = await client.waitFor((f) => f.t === 'attachment' && f.guid === ATTACHMENT_TEST.guid)
  report(
    'attachment -> second request is a cache hit (same path, no re-download)',
    cachedFrame.path === downloadFrame.path && readFileSync(downloadFrame.path, 'utf8') === 'sentinel',
    JSON.stringify(cachedFrame)
  )

  client.send({ t: 'attachment', guid: 'MOCK-ATTACHMENT-MISSING' })
  const attachmentError = await client.waitFor((f) => f.t === 'error' && f.for === 'attachment')
  report(
    'unknown attachment -> error frame carries the guid',
    attachmentError.guid === 'MOCK-ATTACHMENT-MISSING' && typeof attachmentError.message === 'string' && attachmentError.message.length > 0,
    JSON.stringify(attachmentError)
  )

  // Preview: replies instantly with a thumb-backed copy, upgrades the same
  // file in place once the full-size download lands. The thumbnail cache
  // still holds the "sentinel" poison from the cache-hit test above, which
  // makes the copy provenance unambiguous.
  client.send({ t: 'preview', guid: ATTACHMENT_TEST.guid })
  const previewFrame = await client.waitFor((f) => f.t === 'preview' && f.guid === ATTACHMENT_TEST.guid)
  report('preview -> distinct .preview path', previewFrame.path === `${downloadFrame.path}.preview`, JSON.stringify(previewFrame))
  report(
    'preview -> initial bytes copied from the thumbnail cache',
    existsSync(previewFrame.path) && readFileSync(previewFrame.path, 'utf8') === 'sentinel',
    'preview did not start as the thumb copy'
  )

  const upgradeDeadline = Date.now() + 5000
  let upgraded = false
  while (Date.now() < upgradeDeadline && !upgraded) {
    upgraded = readFileSync(previewFrame.path).equals(ATTACHMENT_PNG_FULL)
    if (!upgraded) await sleep(100)
  }
  report('preview -> upgraded in place to the full-size bytes', upgraded)
  const fullCachePath = `${downloadFrame.path}.full`
  report(
    'preview -> full-size download cached alongside the thumb',
    existsSync(fullCachePath) && readFileSync(fullCachePath).equals(ATTACHMENT_PNG_FULL)
  )

  // Warm-path: with .full cached, the reply must serve it directly -- no
  // thumb copy, no re-download. Byte-comparing the preview can't prove that
  // (a local thumb-copy-then-upgrade converges to the same bytes almost
  // instantly), so delete the thumb cache instead: only the cold path would
  // recreate it.
  writeFileSync(fullCachePath, 'full-sentinel')
  rmSync(downloadFrame.path)
  client.send({ t: 'preview', guid: ATTACHMENT_TEST.guid })
  const warmPreview = await client.waitFor((f) => f.t === 'preview' && f.guid === ATTACHMENT_TEST.guid)
  report(
    'preview -> warm request serves the cached full file',
    warmPreview.path === previewFrame.path && readFileSync(warmPreview.path, 'utf8') === 'full-sentinel',
    JSON.stringify(warmPreview)
  )
  report(
    'preview -> warm request never touches the thumbnail path',
    !existsSync(downloadFrame.path),
    'thumb cache file was recreated'
  )

  client.send({ t: 'preview', guid: 'MOCK-ATTACHMENT-MISSING' })
  const previewError = await client.waitFor((f) => f.t === 'error' && f.for === 'preview')
  report(
    'unknown preview -> error frame carries the guid',
    previewError.guid === 'MOCK-ATTACHMENT-MISSING' && typeof previewError.message === 'string' && previewError.message.length > 0,
    JSON.stringify(previewError)
  )

  const unreadBaseline = (await settledChats(client)).unread

  const tempId = 'smoke-1'
  const text = 'smoke test message'
  client.send({ t: 'send', chatGuid, text, tempId })
  const ackFrame = await client.waitFor((f) => f.t === 'ack' && f.for === 'send' && f.tempId === tempId)
  report('send -> ack ok', ackFrame.ok === true, JSON.stringify(ackFrame))
  report('ack -> guid non-empty', typeof ackFrame.guid === 'string' && ackFrame.guid.length > 0, JSON.stringify(ackFrame))

  const echoFrame = await client.waitFor(
    (f) => f.t === 'message' && f.chatGuid === chatGuid && f.message.fromMe === true && f.message.text === text
  )
  report('send -> echoed message pushed', !!echoFrame)
  report('echoed message carries matching tempId', echoFrame.message.tempId === tempId, JSON.stringify(echoFrame.message))

  const duplicateEcho = await client
    .waitFor((f) => f.t === 'message' && f.message.guid === echoFrame.message.guid, 1000)
    .catch(() => null)
  report('second echo of the same guid is dropped', duplicateEcho === null, JSON.stringify(duplicateEcho))

  const replyFrame = await client.waitFor(
    (f) => f.t === 'message' && f.chatGuid === chatGuid && f.message.fromMe === false,
    6000
  )
  report('canned reply pushed within ~5s', !!replyFrame)
  report(
    'unread incremented on pushed reply',
    replyFrame.unread === unreadBaseline + 1,
    `unread=${replyFrame.unread} baseline=${unreadBaseline}`
  )

  const stateAfterRead = await settledRead(client, chatGuid)
  report('read -> total unread clears', stateAfterRead.unread === 0, `unread=${stateAfterRead.unread}`)

  const chatsAfterRead = await settledChats(client)
  const readChat = chatsAfterRead.chats.find((c) => c.guid === chatGuid)
  report('read -> chat.unread clears', readChat?.unread === 0, `unread=${readChat?.unread}`)

  // Pins: a mid-list chat (neither current front nor back) so the move is
  // unambiguous, and its recency-position is recoverable to check unpin.
  const midIndex = Math.floor(chatsAfterRead.chats.length / 2)
  const pinTarget = chatsAfterRead.chats[midIndex]
  report(
    'pin test setup: picked a genuinely mid-list chat',
    midIndex > 0 && midIndex < chatsAfterRead.chats.length - 1,
    `midIndex=${midIndex} of ${chatsAfterRead.chats.length}`
  )

  client.send({ t: 'pin', chatGuid: pinTarget.guid, pinned: true })
  const pinnedFrame = await client.waitFor((f) => f.t === 'chats' && f.chats.some((c) => c.guid === pinTarget.guid && c.pinned === true), 3000)
  report(
    'pin -> chat moves to front with pinned:true',
    pinnedFrame.chats[0]?.guid === pinTarget.guid && pinnedFrame.chats[0]?.pinned === true,
    JSON.stringify(pinnedFrame.chats[0])
  )

  const restAfterPin = pinnedFrame.chats.slice(1)
  const restStillDescending = restAfterPin.every((c, i) => {
    if (i === 0) return true
    const prevTs = restAfterPin[i - 1].lastMessage?.ts ?? -Infinity
    const curTs = c.lastMessage?.ts ?? -Infinity
    return prevTs >= curTs
  })
  report(
    'pin -> rest of the list stays recency-sorted',
    restStillDescending,
    JSON.stringify(restAfterPin.map((c) => c.lastMessage?.ts))
  )

  let pinsAfterPin = null
  try {
    await waitFileExists(pinsFilePath, 3000)
    pinsAfterPin = JSON.parse(readFileSync(pinsFilePath, 'utf8'))
  } catch (err) {
    pinsAfterPin = `<unreadable: ${err.message}>`
  }
  report(
    'pin -> persisted to pins.json',
    Array.isArray(pinsAfterPin) && pinsAfterPin.includes(pinTarget.guid),
    JSON.stringify(pinsAfterPin)
  )

  client.send({ t: 'pin', chatGuid: pinTarget.guid, pinned: false })
  const unpinnedFrame = await client.waitFor((f) => f.t === 'chats' && f.chats.some((c) => c.guid === pinTarget.guid && c.pinned === false), 3000)
  const unpinnedIndex = unpinnedFrame.chats.findIndex((c) => c.guid === pinTarget.guid)
  report(
    'unpin -> chat drops back to its recency position',
    unpinnedIndex === midIndex,
    `expected index ${midIndex}, got ${unpinnedIndex}`
  )

  let pinsAfterUnpin = null
  try {
    pinsAfterUnpin = JSON.parse(readFileSync(pinsFilePath, 'utf8'))
  } catch (err) {
    pinsAfterUnpin = `<unreadable: ${err.message}>`
  }
  report(
    'unpin -> removed from pins.json',
    Array.isArray(pinsAfterUnpin) && !pinsAfterUnpin.includes(pinTarget.guid),
    JSON.stringify(pinsAfterUnpin)
  )

  // Pagination: mimics the real BlueBubbles bug (a chat with the account's
  // newest lastMessage silently absent from a small top-N chat/query page).
  // UNNAMED_GROUP_TEST_CHAT is last in the mock's raw insertion order, so
  // with the page size forced to 3 (see spawn env above) it sits entirely on
  // page 3 -- a daemon that fetched only page one could never surface it.
  const pageTarget = UNNAMED_GROUP_TEST_CHAT.guid
  const pageTempId = 'page-test'
  client.send({ t: 'send', chatGuid: pageTarget, text: 'newest in the account', tempId: pageTempId })
  await client.waitFor((f) => f.t === 'ack' && f.for === 'send' && f.tempId === pageTempId)
  await client.waitFor((f) => f.t === 'message' && f.chatGuid === pageTarget && f.message.fromMe === true)

  const pagedFrame = await settledChats(client, { limit: 3 })
  report(
    'pagination: newest chat surfaces first despite sitting outside page one',
    pagedFrame.chats[0]?.guid === pageTarget,
    `got ${pagedFrame.chats[0]?.guid}`
  )

  const allChatsFrame = await settledChats(client, { limit: 40 })
  report(
    'pagination: no chats dropped across pages',
    allChatsFrame.chats.length === 7,
    `got ${allChatsFrame.chats.length}`
  )

  const cappedFrame = await settledChats(client, { limit: 3 })
  const uncappedFrame = await settledChats(client, { limit: 0 })
  report(
    'limit 0 -> the whole list, where a numeric limit caps it',
    cappedFrame.chats.length === 3 && uncappedFrame.chats.length === 7,
    `capped ${cappedFrame.chats.length}, uncapped ${uncappedFrame.chats.length}`
  )

  // A chat whose messages chat.db never linked to it: the chat-scoped route
  // serves nothing, and only the handle-scoped fallback reaches them.
  client.send({ t: 'messages', chatGuid: ORPHANED_TEST.guid })
  const orphanFrame = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === ORPHANED_TEST.guid)
  report(
    'messages -> a chat with no chat-linked messages is recovered by handle',
    (orphanFrame.messages || []).length > 0 && orphanFrame.unavailable !== true,
    `got ${(orphanFrame.messages || []).length} messages, unavailable=${orphanFrame.unavailable}`
  )

  client.send({ t: 'messages', chatGuid: UNREACHABLE_TEST.guid })
  const unreachableFrame = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === UNREACHABLE_TEST.guid)
  report(
    'messages -> a group the fallback cannot reach is reported unavailable',
    (unreachableFrame.messages || []).length === 0 && unreachableFrame.unavailable === true,
    JSON.stringify({ messages: (unreachableFrame.messages || []).length, unavailable: unreachableFrame.unavailable })
  )

  // Thread paging: the daemon sizes the page from its own config, and the panel
  // walks backwards from it. NEVER_TRACKED_TEST is a chat-linked thread, so the
  // chat-scoped route answers it directly; every assertion below is relative to
  // the pages this walk itself received, so a push landing at the newest end
  // mid-walk cannot move them.
  const pageChat = NEVER_TRACKED_TEST.guid
  client.send({ t: 'messages', chatGuid: pageChat })
  const firstPage = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === pageChat)
  report(
    'messages -> the daemon serves a page sized from its own config',
    (firstPage.messages || []).length === CACHE_PAGE_SIZE,
    `got ${(firstPage.messages || []).length}, configured ${CACHE_PAGE_SIZE}`
  )

  const seenGuids = new Set(firstPage.messages.map((m) => m.guid))
  let cursor = firstPage.messages[0].ts
  let olderPages = 0
  let overlapOnlyAtCursor = true
  let oldestFirst = true
  let endFrame = null
  // Bounded: no canned chat holds more than a handful of pages, so a walk that
  // has not reached the start by here is a daemon that never reports it.
  for (let step = 0; step < 12; step += 1) {
    client.send({ t: 'olderMessages', chatGuid: pageChat, beforeTs: cursor })
    const frame = await client.waitFor((f) => f.t === 'olderMessages' && f.chatGuid === pageChat)
    const page = frame.messages || []
    // The server's cut is inclusive, so the cursor message comes back with
    // every page; running out of anything STRICTLY older is what ends the walk.
    // Whether the daemon also says so is the assertion below, so a daemon that
    // never flags exhaustion fails here rather than running the loop out.
    if (!page.some((m) => m.ts < cursor)) {
      endFrame = frame
      break
    }
    olderPages += 1
    // Anything the thread already held may only be the inclusive boundary
    // itself; a repeat from further back would mean the cursor never moved.
    if (page.some((m) => seenGuids.has(m.guid) && m.ts !== cursor)) overlapOnlyAtCursor = false
    if (page.some((m, i) => i > 0 && m.ts < page[i - 1].ts)) oldestFirst = false
    for (const message of page) seenGuids.add(message.guid)
    cursor = page[0].ts
  }

  report('olderMessages -> the walk pages back through more than the first page', olderPages > 0, `${olderPages} older pages`)
  report('olderMessages -> pages repeat nothing but the inclusive cursor itself', overlapOnlyAtCursor)
  report('olderMessages -> pages arrive oldest-first, like a messages frame', oldestFirst)
  report(
    'olderMessages -> a thread with nothing older reports exhausted, so the panel can stop asking',
    endFrame !== null && endFrame.exhausted === true,
    JSON.stringify(endFrame)
  )
  report(
    'olderMessages -> the exhausted page still carries the cursor message, so nothing sharing its ms is lost',
    endFrame !== null && (endFrame.messages || []).some((m) => m.ts === cursor),
    JSON.stringify(endFrame)
  )

  // A cursor-less request must be refused, not answered with the newest page:
  // the panel would then prepend the page it already has.
  client.send({ t: 'olderMessages', chatGuid: pageChat })
  let missingCursor = null
  try {
    missingCursor = await client.waitFor((f) => f.t === 'error' && f.for === 'olderMessages', 2000)
  } catch {
    // eslint-disable-line no-empty
  }
  report(
    'olderMessages without a cursor -> error',
    missingCursor !== null && typeof missingCursor.message === 'string' && missingCursor.message.length > 0,
    JSON.stringify(missingCursor)
  )
  report(
    'olderMessages error carries its chatGuid, so a client clears the gate for that thread only',
    missingCursor !== null && missingCursor.chatGuid === pageChat,
    JSON.stringify(missingCursor)
  )

  client.send({ t: 'ping' })
  const pongFrame = await client.waitFor((f) => f.t === 'pong')
  report('ping -> pong', !!pongFrame)

  client.close()
}

main()
  .then(() => {
    cleanup()
    const failed = failures.length > 0
    console.log(failed ? `\n${failures.length} step(s) FAILED` : '\nALL STEPS PASSED')
    process.exit(failed ? 1 : 0)
  })
  .catch((err) => {
    console.error('smoke: fatal error', err)
    cleanup()
    process.exit(1)
  })
