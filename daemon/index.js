import { loadConfig, logConfigOutcome } from './lib/config.js'
import { socketPath } from './lib/paths.js'
import { logger } from './lib/logger.js'
import { Bus } from './lib/bus.js'
import { Store } from './lib/store.js'
import { BlueBubblesSession } from './lib/bluebubbles.js'

const config = loadConfig()
logConfigOutcome(config)

const bus = new Bus(socketPath)
const store = new Store()

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

let session = null

if (config.ok) {
  session = new BlueBubblesSession(config)

  session.onConnection = (nextConnection, error) => {
    connection = nextConnection
    lastError = error
    pushState()
  }

  session.onMessage = ({ chatGuid, chat, message }) => {
    const cached = store.upsertFromMessage(chat, message)
    bus.broadcast({ t: 'message', chatGuid, message, chat: cached, unread: store.totalUnread() })
  }

  session.start()
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
        const chats = await session.chats()
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
        const messages = await session.messages(payload.chatGuid, payload.limit || 60)
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
        const sent = await session.sendText({ chatGuid: payload.chatGuid, text: payload.text, tempGuid: payload.tempId })
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
      bus.broadcast({ t: 'chats', chats: store.chatList(), unread: store.totalUnread() })
      return

    default:
      reply({ t: 'error', for: String(t || ''), message: `unknown frame: ${t}` })
  }
}

function shutdown(signal) {
  logger.info('shutting down', { signal })
  session?.close()
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
