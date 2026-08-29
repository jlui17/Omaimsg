// Canned BlueBubbles-shaped data: 5 chats, 10-30 messages each. Shapes match
// what's verified from the Postman collection and server source (see
// daemon/lib/bluebubbles.js's header comment for the citations).

let rowId = 1
const nextRowId = () => rowId++

function guid() {
  return 'MOCK-' + Math.random().toString(36).slice(2, 10).toUpperCase()
}

// Alex and Jordan have no displayName set, same as a real 1:1 iMessage chat
// with no contact card resolved server-side: the daemon falls back to the
// participant's handle for the chat name.
const CHAT_DEFS = [
  { guid: 'iMessage;-;+15551230001', displayName: '', participant: '+15551230001' },
  { guid: 'iMessage;-;+15551230002', displayName: 'Sam Patel', participant: 'sam.patel@icloud.com' },
  { guid: 'iMessage;+;chat9988776655', displayName: 'Fam 🏠', participants: ['+15551230003', '+15551230004'] },
  { guid: 'iMessage;-;+15551230005', displayName: '', participant: '+15551230005' },
  { guid: 'iMessage;+;chat5544332211', displayName: 'Book Club', participants: ['+15551230006', '+15551230007', '+15551230008'] },
  // An SMS shortcode sender (carrier notifications). Riley Bower's number below
  // ends with the same six digits; the shortcode must stay unresolved rather
  // than claim that contact.
  { guid: 'SMS;-;753310', displayName: '', participant: '753310' },
  // A group with no name set: renders as joined participant first names, not
  // a single member's name.
  { guid: 'iMessage;+;chat1122334455', displayName: '', participants: ['+15551230003', '+15551230004'] }
]

// Alex and Jordan (the two no-displayName chats above) each have a contact
// card whose stored number is formatted differently from the E.164-ish chat
// handle, like a real Contacts.app entry vs. an iMessage handle.
export const CONTACTS = [
  {
    id: 1,
    displayName: 'Alex Rivera',
    firstName: 'Alex',
    lastName: 'Rivera',
    phoneNumbers: [{ id: 1, address: '(555) 123-0001' }],
    emails: []
  },
  {
    id: 2,
    displayName: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    phoneNumbers: [{ id: 2, address: '555.123.0005' }],
    emails: []
  },
  {
    id: 3,
    displayName: 'Riley Bower',
    firstName: 'Riley',
    lastName: 'Bower',
    phoneNumbers: [{ id: 3, address: '(604) 575-3310' }],
    emails: []
  },
  {
    id: 4,
    displayName: 'Maya Chen',
    firstName: 'Maya',
    lastName: 'Chen',
    phoneNumbers: [{ id: 4, address: '+1 555 123 0003' }],
    emails: []
  }
]

// The chat<->contact pairing above, for smoke.js to assert resolution
// against without duplicating the literal guids/names.
export const CONTACT_TEST_CHATS = [
  { guid: 'iMessage;-;+15551230001', resolvedName: 'Alex Rivera' },
  { guid: 'iMessage;-;+15551230005', resolvedName: 'Jordan Lee' }
]

// The shortcode chat must keep its raw handle as the name; resolving it to
// Riley Bower (whose number shares the trailing digits) is the bug under test.
export const SHORTCODE_TEST_CHAT = { guid: 'SMS;-;753310', rawName: '753310', wrongName: 'Riley Bower' }

// Unnamed group: first names of resolved members, raw handle for the rest.
export const UNNAMED_GROUP_TEST_CHAT = { guid: 'iMessage;+;chat1122334455', expectedName: 'Maya & +15551230004' }

// The seeded image-only message (chat 0, third message), with the bytes the
// mock's download route serves for it: a 1x1 PNG, exported so smoke.js can
// byte-compare what the daemon wrote to disk.
export const ATTACHMENT_TEST_CHAT = CHAT_DEFS[0].guid
export const ATTACHMENT_TEST = { guid: 'MOCK-ATTACHMENT-1', mimeType: 'image/png', transferName: 'photo.png' }
export const ATTACHMENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
// A different 1x1 PNG: what the mock serves when the download request has no
// resize params, i.e. the daemon asked for the full-size file.
export const ATTACHMENT_PNG_FULL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

const BANK = [
  "hey, you around?", "just saw this and thought of you", "omg yes", "lol true",
  "what time works for you tomorrow", "running 5 min late", "sounds good", "no worries!",
  "did you finish the thing", "almost, give me an hour", "can you send the link again",
  "sent!", "thank you!!", "np", "that's hilarious", "wait what happened",
  "long story, tell you later", "ok deal", "see you then", "on my way",
  "can we push to friday instead", "works for me", "let me check and get back to you",
  "just checked, all good", "haha classic", "miss you guys", "same!!",
  "who's driving", "I can drive", "perfect, pick me up at 7", "got it",
  "one sec", "back", "so what did they say", "they said yes!",
  "amazing news", "congrats!!", "thanks, means a lot", "anytime"
]

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function buildParticipants(def) {
  const addrs = def.participants || [def.participant]
  return addrs.map((address) => ({ originalROWID: nextRowId(), address, service: 'iMessage' }))
}

// A message's embedded `chats` entry is a snapshot without `lastMessage`:
// the real server builds it from a fresh relation load, not a shared object,
// so it never nests a message inside the chat inside the message.
function chatSnapshot(chat) {
  const { lastMessage: _lastMessage, ...rest } = chat
  return rest
}

function buildMessage({ chat, text, fromMe, ts, attachmentOnly }) {
  const handle = fromMe ? null : { originalROWID: nextRowId(), address: pick(chat.participants).address, service: 'iMessage' }
  return {
    originalROWID: nextRowId(),
    guid: guid(),
    text: attachmentOnly ? null : text,
    handle,
    handleId: handle?.originalROWID ?? 0,
    otherHandle: 0,
    chats: [chatSnapshot(chat)],
    attachments: attachmentOnly ? [{ originalROWID: nextRowId(), ...ATTACHMENT_TEST }] : [],
    isFromMe: fromMe,
    dateCreated: ts,
    dateRead: fromMe ? null : ts + 1000,
    dateDelivered: fromMe ? ts + 200 : null
  }
}

// Builds the mutable in-memory store: one entry per chat, each holding the
// BlueBubbles chat object and its message list (oldest first).
export function buildStore() {
  const chats = new Map() // guid -> chat object (with lastMessage kept in sync)
  const messages = new Map() // guid -> array of message objects

  for (const def of CHAT_DEFS) {
    const chat = {
      originalROWID: nextRowId(),
      guid: def.guid,
      style: def.participants ? 43 : 45,
      chatIdentifier: def.guid.split(';').pop(),
      isArchived: false,
      displayName: def.displayName,
      participants: buildParticipants(def),
      lastMessage: null
    }

    const count = 10 + Math.floor(Math.random() * 21) // 10-30
    const now = Date.now()
    const list = []
    for (let i = 0; i < count; i++) {
      const fromMe = Math.random() < 0.45
      const ts = now - (count - i) * 5 * 60 * 1000 // 5 min apart, oldest first
      const attachmentOnly = i === 2 && def.guid === CHAT_DEFS[0].guid
      list.push(buildMessage({ chat, text: pick(BANK), fromMe, ts, attachmentOnly }))
    }

    chats.set(def.guid, chat)
    messages.set(def.guid, list)
    chat.lastMessage = list[list.length - 1]
  }

  return { chats, messages }
}

export { buildMessage, nextRowId, guid as newGuid, BANK }
