import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { buildStore, buildMessage, pick, BANK, CONTACTS } from './data.js'

const PORT = Number(process.argv[2]) || 3010
const PASSWORD = process.env.MOCK_BB_PASSWORD || 'testpass'
const REPLY_DELAY_MS = 3000
const UNPROMPTED_INTERVAL_MS = 45_000

const { chats, messages } = buildStore()

function log(...args) {
  console.error('omaimsg-mock:', ...args)
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function envelope(data, message = 'Success') {
  return { status: 200, message, data }
}

function unauthorized(res) {
  sendJson(res, 401, {
    status: 401,
    message: 'Unauthorized',
    error: { type: 'Unauthorized', error: 'Missing or invalid password' }
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const password = url.searchParams.get('password') ?? url.searchParams.get('guid') ?? url.searchParams.get('token')
  if (password !== PASSWORD) {
    unauthorized(res)
    return
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/contact') {
      sendJson(res, 200, envelope(CONTACTS))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/chat/query') {
      const body = await readBody(req)
      const limit = body.limit || 1000
      const offset = body.offset || 0
      // Deliberately NOT sorted by recency, `sort` param or not: this is the
      // same shape as the real bug the daemon works around (BlueBubbles'
      // ranking silently drops a chat from an early page even though its
      // lastMessage is the newest in the account) -- a chat that just got a
      // new message stays wherever it was in this insertion order until a
      // full-list re-sort recovers it, same as the real server's index-200
      // cutoff missing an `any;-;` chat entirely.
      const list = [...chats.values()].slice(offset, offset + limit)
      sendJson(res, 200, envelope(list))
      return
    }

    const messageMatch = url.pathname.match(/^\/api\/v1\/chat\/(.+)\/message$/)
    if (req.method === 'GET' && messageMatch) {
      const chatGuid = decodeURIComponent(messageMatch[1])
      const list = messages.get(chatGuid)
      if (!list) {
        sendJson(res, 404, { status: 404, message: 'Chat does not exist' })
        return
      }
      const limit = Number(url.searchParams.get('limit')) || 100
      const newestFirst = url.searchParams.get('sort') !== 'ASC'
      const sorted = newestFirst ? [...list].reverse() : list
      sendJson(res, 200, envelope(sorted.slice(0, limit)))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/message/text') {
      const body = await readBody(req)
      const { chatGuid, tempGuid, message: text } = body
      const chat = chats.get(chatGuid)
      if (!chat) {
        sendJson(res, 404, { status: 404, message: 'Chat does not exist' })
        return
      }

      const sent = buildMessage({ chat, text, fromMe: true, ts: Date.now() })
      messages.get(chatGuid).push(sent)
      chat.lastMessage = sent
      sendJson(res, 200, envelope(sent))

      // Echo over the socket like the real server's emitMessageMatch (which
      // stamps tempGuid on the emitted copy, not the HTTP response), then a
      // canned reply a few seconds later so the round trip is visible.
      io.emit('new-message', { ...sent, tempGuid })
      scheduleReply(chatGuid)
      return
    }

    sendJson(res, 404, { status: 404, message: 'Not found' })
  } catch (err) {
    sendJson(res, 500, { status: 500, message: err.message })
  }
})

const io = new SocketIOServer(server)

io.on('connection', (socket) => {
  const pass = socket.handshake.query?.password ?? socket.handshake.query?.guid
  if (pass !== PASSWORD) {
    socket.disconnect()
    return
  }
  log('client connected')
  socket.on('disconnect', () => log('client disconnected'))
})

function scheduleReply(chatGuid) {
  setTimeout(() => {
    const chat = chats.get(chatGuid)
    const list = messages.get(chatGuid)
    if (!chat || !list) return
    const reply = buildMessage({ chat, text: pick(BANK), fromMe: false, ts: Date.now() })
    list.push(reply)
    chat.lastMessage = reply
    io.emit('new-message', reply)
    log('canned reply sent', chatGuid)
  }, REPLY_DELAY_MS).unref()
}

setInterval(() => {
  const guids = [...chats.keys()]
  const chatGuid = pick(guids)
  const chat = chats.get(chatGuid)
  const list = messages.get(chatGuid)
  const message = buildMessage({ chat, text: pick(BANK), fromMe: false, ts: Date.now() })
  list.push(message)
  chat.lastMessage = message
  io.emit('new-message', message)
  log('unprompted message', chatGuid)
}, UNPROMPTED_INTERVAL_MS).unref()

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT} (password: ${PASSWORD})`)
})
