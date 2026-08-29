import { io } from 'socket.io-client'

import { loadConfig, logConfigOutcome } from './lib/config.js'
import { socketPath } from './lib/paths.js'
import { logger } from './lib/logger.js'
import { Bus } from './lib/bus.js'
import { Store } from './lib/store.js'
import { BlueBubblesClient, chatGuidOf, embeddedChat, normalizeMessage } from './lib/bluebubbles.js'
import { ContactIndex, EMPTY_CONTACT_INDEX } from './lib/contacts.js'
import { PinStore } from './lib/pins.js'

const config = loadConfig()
logConfigOutcome(config)

const bus = new Bus(socketPath)
const store = new Store()
const pinStore = new PinStore()
store.setPinnedGuids(pinStore.pinned)

let connection = config.ok ? 'connecting' : 'error'
let lastError = config.ok ? '' : config.error

function state() {
  return {
    t: 'state',
    connection,
    serverUrl: config.ok ? config.serverUrl : '',
    unread: store.totalUnread(),
    lastError
  }
}

function pushState() {
  bus.broadcast(state())
}

let bb = null
let socket = null
let contactIndex = EMPTY_CONTACT_INDEX

async function refreshContacts() {
  try {
    const contacts = await bb.getContacts()
    contactIndex = ContactIndex.fromContacts(contacts)
    logger.info('bluebubbles: contacts loaded', { contacts: contacts.length })
  } catch (err) {
    logger.warn('bluebubbles: contacts fetch failed', { err: err.message })
  }
}

if (config.ok) {
  bb = new BlueBubblesClient(config)

  socket = io(config.serverUrl, {
    query: { password: config.password },
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000
  })

  socket.on('connect', () => {
    connection = 'connected'
    lastError = ''
    logger.info('bluebubbles: connected')
    pushState()
    refreshContacts()
  })

  socket.on('disconnect', (reason) => {
    logger.warn('bluebubbles: disconnected', { reason })
    if (reason === 'io server disconnect') {
      // The server only disconnects a socket itself on auth failure
      // (authMiddleware-equivalent check in httpService/index.ts); it will
      // not retry on its own.
      connection = 'error'
      lastError = 'BlueBubbles rejected the password'
    } else {
      connection = 'connecting'
      lastError = reason
    }
    pushState()
  })

  socket.on('connect_error', (err) => {
    logger.warn('bluebubbles: connect_error', { err: err.message })
    connection = 'connecting'
    lastError = err.message
    pushState()
  })

  // BlueBubbles emits "new-message" for both inbound iMessages and the echo
  // of a message this daemon just sent (chats embedded on the payload).
  socket.on('new-message', (payload) => {
    const chatGuid = chatGuidOf(payload)
    const bbChat = embeddedChat(payload)
    if (!chatGuid || !bbChat) {
      logger.warn('bluebubbles: new-message with no embedded chat, dropping')
      return
    }
    const message = normalizeMessage(payload, contactIndex)
    const chat = store.upsertFromMessage(bbChat, message, contactIndex)
    bus.broadcast({ t: 'message', chatGuid, message, chat, unread: store.totalUnread() })
  })
}

async function handleCommand(payload, reply) {
  const { t } = payload

  switch (t) {
    case 'hello':
      reply(state())
      return

    case 'ping':
      reply({ t: 'pong' })
      return

    case 'chats':
      if (!config.ok) {
        reply({ t: 'error', for: 'chats', message: lastError })
        return
      }
      try {
        const chats = await bb.queryAllChats(contactIndex)
        store.replaceChats(chats)
        // Slice AFTER Store's pinned-first/recency sort, never at the
        // BlueBubbles fetch: see bluebubbles.js's header note on why the
        // server's own top-N cut can't be trusted.
        reply({ t: 'chats', chats: store.chatList().slice(0, payload.limit || 40), unread: store.totalUnread() })
      } catch (err) {
        reply({ t: 'error', for: 'chats', message: err.message })
      }
      return

    case 'messages':
      if (!config.ok) {
        reply({ t: 'error', for: 'messages', message: lastError })
        return
      }
      if (!payload.chatGuid) {
        reply({ t: 'error', for: 'messages', message: 'chatGuid required' })
        return
      }
      try {
        const messages = await bb.getChatMessages(payload.chatGuid, payload.limit || 60, contactIndex)
        reply({ t: 'messages', chatGuid: payload.chatGuid, messages })
      } catch (err) {
        reply({ t: 'error', for: 'messages', message: err.message })
      }
      return

    case 'send':
      if (!config.ok) {
        reply({ t: 'ack', for: 'send', chatGuid: payload.chatGuid, tempId: payload.tempId, guid: '', ok: false, message: lastError })
        return
      }
      try {
        const sent = await bb.sendText({ chatGuid: payload.chatGuid, text: payload.text, tempGuid: payload.tempId })
        reply({ t: 'ack', for: 'send', chatGuid: payload.chatGuid, tempId: payload.tempId, guid: sent.guid || '', ok: true })
      } catch (err) {
        reply({ t: 'ack', for: 'send', chatGuid: payload.chatGuid, tempId: payload.tempId, guid: '', ok: false, message: err.message })
      }
      return

    case 'read':
      store.markRead(payload.chatGuid)
      pushState()
      return

    case 'pin':
      store.setPinned(payload.chatGuid, !!payload.pinned)
      pinStore.set(payload.chatGuid, !!payload.pinned)
      bus.broadcast({ t: 'chats', chats: store.chatList(), unread: store.totalUnread() })
      return

    default:
      reply({ t: 'error', for: String(t || ''), message: `unknown frame: ${t}` })
  }
}

function shutdown(signal) {
  logger.info('shutting down', { signal })
  socket?.close()
  bus.close()
  process.exit(0)
}

async function main() {
  bus.snapshot = state
  bus.onCommand = handleCommand
  try {
    await bus.listen()
  } catch (err) {
    if (err.code === 'EALREADYRUNNING') {
      logger.error(err.message)
      process.exit(3)
    }
    throw err
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal))
  process.on('uncaughtException', (err) => logger.error('uncaught exception', { err: err.message }))
  process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err: err?.message || err }))
}

main().catch((err) => {
  logger.error('daemon failed to start', { err: err.message })
  process.exit(1)
})
