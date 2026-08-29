import net from 'node:net'
import { chmodSync, unlinkSync } from 'node:fs'
import { logger } from './logger.js'

const MAX_LINE_BYTES = 1024 * 512

// Newline-delimited JSON over a unix socket, one plugin client per monitor.
// Every push frame fans out to all connected clients.
export class Bus {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.clients = new Set()
    this.server = null
    this.onCommand = null
    this.snapshot = null
  }

  async listen() {
    await this._clearStaleSocket()
    this.server = net.createServer((socket) => this._accept(socket))
    this.server.on('error', (err) => logger.error('bus: server error', { err: err.message }))

    await new Promise((resolvePromise, rejectPromise) => {
      this.server.once('error', rejectPromise)
      this.server.listen(this.socketPath, () => {
        this.server.off('error', rejectPromise)
        resolvePromise()
      })
    })

    try {
      chmodSync(this.socketPath, 0o600)
    } catch (err) {
      logger.warn('bus: could not tighten socket permissions', { err: err.message })
    }
    logger.info('bus: listening', { socket: this.socketPath })
  }

  // A socket file left behind by a killed daemon is indistinguishable from a
  // live one by name alone, so probe it: a refused connect means it is dead.
  async _clearStaleSocket() {
    const alive = await new Promise((resolvePromise) => {
      const probe = net.connect(this.socketPath)
      const done = (result) => {
        probe.destroy()
        resolvePromise(result)
      }
      probe.once('connect', () => done(true))
      probe.once('error', () => done(false))
      setTimeout(() => done(false), 500).unref?.()
    })

    if (alive) {
      const err = new Error(`another omaimsg daemon is already listening on ${this.socketPath}`)
      err.code = 'EALREADYRUNNING'
      throw err
    }

    try {
      unlinkSync(this.socketPath)
      logger.info('bus: removed stale socket')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  _accept(socket) {
    socket.setNoDelay(true)
    const client = { socket, buffer: '' }
    this.clients.add(client)
    logger.debug('bus: client connected', { clients: this.clients.size })

    socket.on('data', (chunk) => {
      client.buffer += chunk.toString('utf8')
      if (client.buffer.length > MAX_LINE_BYTES) {
        logger.warn('bus: oversized frame, dropping client')
        socket.destroy()
        return
      }
      let index = client.buffer.indexOf('\n')
      while (index !== -1) {
        const line = client.buffer.slice(0, index).trim()
        client.buffer = client.buffer.slice(index + 1)
        if (line) this._dispatch(client, line)
        index = client.buffer.indexOf('\n')
      }
    })

    const drop = () => {
      this.clients.delete(client)
      logger.debug('bus: client gone', { clients: this.clients.size })
    }
    socket.on('close', drop)
    socket.on('error', drop)

    if (this.snapshot) this.sendTo(client, this.snapshot())
  }

  _dispatch(client, line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      logger.warn('bus: unparseable command', { line: line.slice(0, 120) })
      return
    }
    if (!payload || typeof payload !== 'object') return
    logger.debug('bus: command', { t: payload.t })
    Promise.resolve()
      .then(() => this.onCommand?.(payload, (response) => this.sendTo(client, response)))
      .catch((err) => {
        logger.warn('bus: command failed', { err: err.message, t: payload.t })
        this.sendTo(client, { t: 'error', for: payload.t || '', message: String(err?.message || err) })
      })
  }

  sendTo(client, payload) {
    if (!payload) return
    try {
      client.socket.write(`${JSON.stringify(payload)}\n`)
    } catch (err) {
      logger.debug('bus: write failed', { err: err.message })
    }
  }

  broadcast(payload) {
    if (!payload || this.clients.size === 0) return
    const line = `${JSON.stringify(payload)}\n`
    for (const client of this.clients) {
      try {
        client.socket.write(line)
      } catch (err) {
        logger.debug('bus: broadcast write failed', { err: err.message })
      }
    }
  }

  close() {
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
    this.server?.close()
    try {
      unlinkSync(this.socketPath)
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}
