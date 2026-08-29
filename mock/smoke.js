// End-to-end smoke test: mock BlueBubbles server -> daemon -> raw NDJSON
// client over the Unix socket. Exercises every frame in docs/daemon-protocol.md.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTACT_TEST_CHATS, SHORTCODE_TEST_CHAT, UNNAMED_GROUP_TEST_CHAT } from './data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const daemonEntry = process.env.OMAIMSG_DAEMON_ENTRY || 'daemon/index.js'
const PORT = 39000 + (process.pid % 500)
const PASSWORD = 'testpass'
const configPath = path.join(os.tmpdir(), `omaimsg-smoke-config-${process.pid}.json`)
const socketPath = path.join(os.tmpdir(), `omaimsg-smoke-${process.pid}.sock`)
const stateHome = path.join(os.tmpdir(), `omaimsg-smoke-state-${process.pid}`)
const pinsFilePath = path.join(stateHome, 'omaimsg', 'pins.json')

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  for (const file of [configPath, socketPath]) {
    try {
      rmSync(file, { force: true })
    } catch {
      // Already gone.
    }
  }
  try {
    rmSync(stateHome, { force: true, recursive: true })
  } catch {
    // Already gone.
  }
}

async function main() {
  trackSpawn(
    spawn('node', ['mock/server.js', String(PORT)], {
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
    method: 'apple-script'
  }))

  trackSpawn(
    spawn('node', [daemonEntry], {
      cwd: repoRoot,
      // A page size (3) far smaller than the 7 canned chats forces every
      // `chats` command through the daemon's multi-page fetch for the whole
      // run -- the strongest regression net for the pagination fix.
      env: {
        ...process.env,
        OMAIMSG_CONFIG: configPath,
        OMAIMSG_SOCKET: socketPath,
        XDG_STATE_HOME: stateHome,
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

  client.send({ t: 'chats', limit: 40 })
  const chatsFrame = await client.waitFor((f) => f.t === 'chats')
  report('chats -> 7 chats', chatsFrame.chats?.length === 7, `got ${chatsFrame.chats?.length}`)

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

  client.send({ t: 'chats' })
  const reorderedFrame = await client.waitFor((f) => f.t === 'chats')
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

  // Drain orderTarget's canned reply and mark it read so its unread
  // contribution doesn't leak into the unread assertions below, which are
  // scoped to chatGuid's own send/reply round trip.
  await client.waitFor((f) => f.t === 'message' && f.chatGuid === orderTarget && f.message.fromMe === false, 6000)
  client.send({ t: 'read', chatGuid: orderTarget })
  await client.waitFor((f) => f.t === 'state', 3000)

  const chatGuid = chatsFrame.chats[0].guid
  client.send({ t: 'messages', chatGuid, limit: 60 })
  const messagesFrame = await client.waitFor((f) => f.t === 'messages' && f.chatGuid === chatGuid)
  report('messages -> non-empty list', Array.isArray(messagesFrame.messages) && messagesFrame.messages.length > 0)

  client.send({ t: 'chats' })
  const unreadBaseline = (await client.waitFor((f) => f.t === 'chats')).unread

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

  client.send({ t: 'read', chatGuid })
  const stateAfterRead = await client.waitFor((f) => f.t === 'state', 3000)
  report('read -> total unread clears', stateAfterRead.unread === 0, `unread=${stateAfterRead.unread}`)

  client.send({ t: 'chats' })
  const chatsAfterRead = await client.waitFor((f) => f.t === 'chats')
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

  client.send({ t: 'chats', limit: 3 })
  const pagedFrame = await client.waitFor((f) => f.t === 'chats')
  report(
    'pagination: newest chat surfaces first despite sitting outside page one',
    pagedFrame.chats[0]?.guid === pageTarget,
    `got ${pagedFrame.chats[0]?.guid}`
  )

  client.send({ t: 'chats', limit: 40 })
  const allChatsFrame = await client.waitFor((f) => f.t === 'chats')
  report(
    'pagination: no chats dropped across pages',
    allChatsFrame.chats.length === 7,
    `got ${allChatsFrame.chats.length}`
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
