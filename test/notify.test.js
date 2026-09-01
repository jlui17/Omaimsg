// What an inbound message turns into on screen. The spawn itself is wiring and
// belongs to smoke.js; everything here is the pure shaping in front of it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NOTIFICATION_GLYPH, notificationFor } from '../daemon/lib/notify.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const SOLO = { guid: 'iMessage;-;+15551230001', name: 'Maya Chen', isGroup: false }
const GROUP = { guid: 'iMessage;+;chat1122334455', name: 'Weekend Crew', isGroup: true }

function inbound(fields) {
  return { guid: 'M1', ts: 1, fromMe: false, sender: 'Maya Chen', text: 'on my way', ...fields }
}

test('a one-to-one message names the sender and shows the text', () => {
  assert.deepEqual(notificationFor({ chat: SOLO, message: inbound() }), {
    title: 'Maya Chen',
    body: 'on my way'
  })
})

test('a group message names the group and prefixes the sender', () => {
  assert.deepEqual(notificationFor({ chat: GROUP, message: inbound() }), {
    title: 'Weekend Crew',
    body: 'Maya Chen: on my way'
  })
})

test('a message of my own never notifies', () => {
  assert.equal(notificationFor({ chat: SOLO, message: inbound({ fromMe: true, sender: '' }) }), null)
})

// A toast is one line, so a body that carries its own line breaks has to lose
// them: left in, they either grow the toast or get cut off mid-sentence.
test('newlines and runs of whitespace collapse to single spaces', () => {
  assert.equal(
    notificationFor({ chat: SOLO, message: inbound({ text: 'line one\n\nline   two' }) }).body,
    'line one line two'
  )
})

// Omarchy's own card wraps and elides the body, so cutting it here would only
// decide where the ellipsis lands and would lose text the card had room for.
test('a long body is handed over whole, for the card to elide', () => {
  const text = 'a'.repeat(400)
  assert.equal(notificationFor({ chat: SOLO, message: inbound({ text }) }).body, text)
  assert.equal(notificationFor({ chat: GROUP, message: inbound({ text }) }).body, `Maya Chen: ${text}`)
})

// The daemon substitutes a placeholder for a message with no text so the panel
// renders something; a toast reading "[attachment]" is not that something.
test('an image-only message reads as a photo, not the placeholder', () => {
  const message = inbound({
    text: '[attachment]',
    attachments: [{ guid: 'A1', mime: 'image/png', name: 'photo.png' }]
  })
  assert.equal(notificationFor({ chat: SOLO, message }).body, 'Sent a photo')
})

test('any other attachment-only message reads as an attachment', () => {
  const message = inbound({
    text: '[attachment]',
    attachments: [{ guid: 'A1', mime: 'video/quicktime', name: 'clip.mov' }]
  })
  assert.equal(notificationFor({ chat: SOLO, message }).body, 'Sent an attachment')
})

test('several attachments are counted', () => {
  const image = { guid: 'A1', mime: 'image/png', name: 'a.png' }
  const clip = { guid: 'A2', mime: 'video/quicktime', name: 'b.mov' }
  const body = (attachments) =>
    notificationFor({ chat: SOLO, message: inbound({ text: '[attachment]', attachments }) }).body
  assert.equal(body([image, { ...image, guid: 'A2' }]), 'Sent 2 photos')
  assert.equal(body([image, clip]), 'Sent 2 attachments')
})

// The placeholder is only ever substituted for a message that HAS attachments,
// so the same text with none is someone who typed it. Their words, not ours.
test('a message that literally says [attachment] is left alone', () => {
  const message = inbound({ text: '[attachment]' })
  assert.equal(notificationFor({ chat: SOLO, message }).body, '[attachment]')
})

test('a caption on an attachment is the body, not the attachment wording', () => {
  const message = inbound({
    text: 'look at this',
    attachments: [{ guid: 'A1', mime: 'image/png', name: 'photo.png' }]
  })
  assert.equal(notificationFor({ chat: SOLO, message }).body, 'look at this')
})

// The two live in different languages and cannot import each other, so the only
// thing keeping the toast wearing the same glyph as the bar is this assertion.
test('the toast glyph is the glyph the bar widget wears', () => {
  const qml = readFileSync(`${repoRoot}BarWidget.qml`, 'utf8')
  const match = qml.match(/readonly property string glyph: "(.+)"/)
  assert.ok(match, 'BarWidget.qml no longer declares a glyph property')
  assert.equal(NOTIFICATION_GLYPH, match[1])
})

// A `new-message` push with no handle on it resolves to no sender at all. The
// group name is already the title, so prefixing the body with it says nothing.
test('a message with no sender leaves a group body unprefixed', () => {
  assert.deepEqual(notificationFor({ chat: GROUP, message: inbound({ sender: '' }) }), {
    title: 'Weekend Crew',
    body: 'on my way'
  })
})

test('a message with no sender falls back to the chat name as the title', () => {
  assert.equal(notificationFor({ chat: SOLO, message: inbound({ sender: '' }) }).title, 'Maya Chen')
})

// A tapback or a group event arrives as a message with no text and no
// attachments. Nothing renders those yet, and a toast carrying a sender and a
// blank body says less than no toast at all.
test('a message with nothing to show does not notify', () => {
  assert.equal(notificationFor({ chat: SOLO, message: inbound({ text: '' }) }), null)
  assert.equal(notificationFor({ chat: GROUP, message: inbound({ text: '   ' }) }), null)
})
