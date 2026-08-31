import { pluginId } from './paths.js'

// stderr only, prefixed per the POC spec so it's easy to grep out of a
// systemd journal shared with the plugin side. Every daemon names its install,
// so a journal carrying more than one stays readable.
const PREFIX = `omaimsg-daemon[${pluginId}]:`

function line(level, msg, extra) {
  const suffix = extra !== undefined ? ` ${JSON.stringify(extra)}` : ''
  process.stderr.write(`${PREFIX} [${level}] ${msg}${suffix}\n`)
}

export const logger = {
  info: (msg, extra) => line('info', msg, extra),
  warn: (msg, extra) => line('warn', msg, extra),
  error: (msg, extra) => line('error', msg, extra),
  debug: (msg, extra) => {
    if (process.env.OMAIMSG_DEBUG) line('debug', msg, extra)
  }
}
