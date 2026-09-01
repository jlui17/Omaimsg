// Desktop notifications for inbound messages. Why the daemon owns them and not
// the plugin: docs/daemon-protocol.md.
import { spawn } from 'node:child_process'

import { ATTACHMENT_PLACEHOLDER } from './bluebubbles.js'
import { logger } from './logger.js'

// nf-md-message_text -- the glyph BarWidget.qml wears. notify.test.js pins the
// two equal.
export const NOTIFICATION_GLYPH = '󰍡'

const NOTIFY_TOOL = 'omarchy-notification-send'

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// Nothing is cut here: Omarchy's card wraps and elides the body itself, so a cut
// would only move the ellipsis earlier and lose text the card had room for. The
// collapse to one line above still matters, because the card would honour a
// message's own newlines.
function messageBody(message) {
  const text = oneLine(message.text)
  const attachments = message.attachments || []
  // The placeholder is only ever substituted for a message that HAS
  // attachments, so the same text with none is someone who typed it.
  if (text !== ATTACHMENT_PLACEHOLDER || !attachments.length) return text
  const photos = attachments.every((a) => (a.mime || '').startsWith('image/'))
  if (attachments.length === 1) return photos ? 'Sent a photo' : 'Sent an attachment'
  return `Sent ${attachments.length} ${photos ? 'photos' : 'attachments'}`
}

export function notificationFor({ chat, message }) {
  if (message.fromMe) return null
  const body = messageBody(message)
  // A tapback or a group event carries no text and no attachments, so there is
  // nothing to put in the toast. Nothing renders those yet either.
  if (!body) return null
  const sender = oneLine(message.sender)
  const name = oneLine(chat.name)
  // A message with no resolvable handle carries no sender, and a group's body
  // then has nothing to prefix -- the group name is already the title.
  if (chat.isGroup) return { title: name, body: sender ? `${sender}: ${body}` : body }
  return { title: sender || name, body }
}

// omarchy-notification-send option-parses both of its positional slots and has
// no `--` escape, so a title or body that begins with a dash can be read as one
// of its own flags: verified against a real install, a message of exactly "-g"
// exits the tool non-zero and raises nothing. A leading space is not a flag, and
// is invisible in the toast.
function positional(text) {
  return text.startsWith('-') ? ` ${text}` : text
}

export class Notifier {
  constructor({ enabled, pluginId }) {
    this.enabled = enabled
    this.pluginId = pluginId
  }

  post({ chatGuid, chat, message }) {
    if (!this.enabled) return
    const content = notificationFor({ chat, message })
    if (!content) return

    // --app-name is deliberately not the tool's "omarchy-action" default:
    // Omarchy reads that name as a toast the user just triggered themselves,
    // which bypasses Do Not Disturb and is dropped from history. An inbound
    // message is neither of those things.
    const argv = [
      '--app-name', 'Omaimsg',
      '-g', NOTIFICATION_GLYPH,
      '-u', 'normal',
      positional(content.title),
      positional(content.body),
      '--exec', 'omarchy-shell', this.pluginId, 'openChat', chatGuid
    ]

    const failed = (detail) => logger.warn('notify: could not raise a notification', { chatGuid, ...detail })
    try {
      const child = spawn(NOTIFY_TOOL, argv, { detached: true, stdio: 'ignore' })
      child.on('error', (err) => failed({ err: err.message }))
      // A non-zero exit is the failure that actually happens: no session bus
      // yet, or a title the tool read as one of its own options. stdio is
      // dropped, so the code is the whole diagnosis, and staying silent here
      // would leave a daemon that never notifies looking like it works.
      child.on('exit', (code) => { if (code) failed({ exit: code }) })
      child.unref()
    } catch (err) {
      failed({ err: err.message })
    }
  }
}
