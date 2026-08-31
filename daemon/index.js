import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'

import { loadConfig, logConfigOutcome } from './lib/config.js'
import { attachmentPath, socketPath } from './lib/paths.js'
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

// In-flight downloads by guid+size: every panel client requests the same
// image on thread open, and racing duplicate fetches would tear the .part
// rename.
const attachmentDownloads = new Map()

async function ensureAttachment(guid, size = 'thumbnail') {
  const filePath = attachmentPath(guid, size === 'full' ? '.full' : '')
  if (existsSync(filePath)) return filePath
  const key = `${guid}:${size}`
  let download = attachmentDownloads.get(key)
  if (!download) {
    download = session.downloadAttachment(guid, filePath, { thumbnail: size !== 'full' })
      .finally(() => attachmentDownloads.delete(key))
    attachmentDownloads.set(key, download)
  }
  await download
  return filePath
}

// The preview file is disposable (rebuilt from the caches on every request),
// so it is overwritten in place rather than rename-swapped: an in-place write
// is what the viewer's file watcher reliably sees as a change.
async function upgradePreview(guid, previewPath) {
  try {
    await copyFile(await ensureAttachment(guid, 'full'), previewPath)
  } catch (err) {
    logger.warn('preview upgrade failed, viewer keeps the thumbnail', { guid, err: err.message })
  }
}

if (config.ok) {
  session = new BlueBubblesSession(config)

  session.onConnection = (nextConnection, error) => {
    connection = nextConnection
    lastError = error
    pushState()
  }

  session.onMessage = ({ chatGuid, chat, message }) => {
    const cached = store.upsertFromMessage(chat, message)
    store.appendToThread(chatGuid, message)
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

    case 'chats': {
      if (!config.ok) {
        reply({ t: 'error', for: 'chats', message: lastError })
        return
      }
      // Slice AFTER Store's pinned-first/recency sort, never at the
      // BlueBubbles fetch: see bluebubbles.js's header note on why the
      // server's own top-N cut can't be trusted.
      // `limit: 0` means the whole list: a filtered panel spans the account,
      // and any fixed number is a cut it cannot see past.
      const limit = payload.limit === undefined ? 40 : payload.limit
      const page = (chats) => (limit > 0 ? chats.slice(0, limit) : chats)
      // Cache-first, then revalidate, as the `messages` case does. This is the
      // costlier of the two to answer cold: the fetch behind it pages the
      // entire account, so a client holding a list should never wait on it.
      // Every inbound message keeps the store current, so the cached answer is
      // usually already the right one. It has to be a swept list though, not
      // merely a non-empty map: a push can seed a single chat before any client
      // has asked for the list.
      const servedChats = store.hasFullChatList() ? page(store.chatList()) : null
      if (servedChats) reply({ t: 'chats', chats: servedChats, unread: store.totalUnread() })
      try {
        store.replaceChats(await session.chats())
        const fresh = page(store.chatList())
        if (!servedChats || JSON.stringify(servedChats) !== JSON.stringify(fresh))
          reply({ t: 'chats', chats: fresh, unread: store.totalUnread() })
      } catch (err) {
        // A client already holding a list keeps it rather than being told the
        // fetch failed; the `state` frame is what surfaces a BlueBubbles outage.
        if (servedChats) logger.warn('chats: revalidation failed, cached list stands', { err: err.message })
        else reply({ t: 'error', for: 'chats', message: err.message })
      }
      return
    }

    case 'messages':
      if (!config.ok) {
        reply({ t: 'error', for: 'messages', message: lastError })
        return
      }
      if (!payload.chatGuid) {
        reply({ t: 'error', for: 'messages', message: 'chatGuid required' })
        return
      }
      // Cache-first, then revalidate: a warm thread renders before the
      // BlueBubbles round-trip, and a second `messages` frame follows only
      // when the server's page turns out to differ (docs/daemon-protocol.md).
      const served = store.cachedThread(payload.chatGuid)
      if (served) reply({ t: 'messages', chatGuid: payload.chatGuid, messages: served })
      try {
        const messages = await session.messages(payload.chatGuid, payload.limit || 60)
        const changed = store.cacheThread(payload.chatGuid, messages)
        if (!served || changed) reply({ t: 'messages', chatGuid: payload.chatGuid, messages })
      } catch (err) {
        // A client already holding a cached page keeps it rather than being
        // told the thread failed; the `state` frame is what surfaces a
        // BlueBubbles outage.
        if (served) logger.warn('messages: revalidation failed, cached page stands', { chatGuid: payload.chatGuid, err: err.message })
        else reply({ t: 'error', for: 'messages', message: err.message })
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

    case 'attachment':
      if (!config.ok) {
        reply({ t: 'error', for: 'attachment', guid: payload.guid || '', message: lastError })
        return
      }
      if (!payload.guid) {
        reply({ t: 'error', for: 'attachment', guid: '', message: 'guid required' })
        return
      }
      try {
        reply({ t: 'attachment', guid: payload.guid, path: await ensureAttachment(payload.guid) })
      } catch (err) {
        reply({ t: 'error', for: 'attachment', guid: payload.guid, message: err.message })
      }
      return

    case 'preview':
      if (!config.ok) {
        reply({ t: 'error', for: 'preview', guid: payload.guid || '', message: lastError })
        return
      }
      if (!payload.guid) {
        reply({ t: 'error', for: 'preview', guid: '', message: 'guid required' })
        return
      }
      try {
        const previewPath = attachmentPath(payload.guid, '.preview')
        const fullPath = attachmentPath(payload.guid, '.full')
        const haveFull = existsSync(fullPath)
        await copyFile(haveFull ? fullPath : await ensureAttachment(payload.guid), previewPath)
        reply({ t: 'preview', guid: payload.guid, path: previewPath })
        if (!haveFull) upgradePreview(payload.guid, previewPath)
      } catch (err) {
        reply({ t: 'error', for: 'preview', guid: payload.guid, message: err.message })
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
