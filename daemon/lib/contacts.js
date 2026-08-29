// Resolves a BlueBubbles handle address (close to E.164, e.g. "+15551230001")
// to a Contacts.app display name.
//
// Verified against bluebubbles-server source
// (packages/server/src/server/api/interfaces/contactInterface.ts):
// GET /api/v1/contact returns contacts already mapped to
// {phoneNumbers:[{address,id}], emails:[{address,id}], displayName, ...} via
// ContactInterface.mapContacts, which also computes displayName from
// firstName/lastName/nickname when absent, so this module only reads
// `displayName`. Addresses are NOT normalized by the server (raw as stored,
// e.g. "(555) 123-0001"), so suffix matching by decreasing length tolerates a
// missing/extra leading country code, like ContactInterface.findContact does.
// Unlike findContact, fuzzy suffix matching requires at least 7 matched
// digits (a local number without area code): anything shorter lets an SMS
// shortcode (a 4-6 digit sender like a carrier's) claim whichever saved
// contact happens to share its trailing digits. Emails and shortcodes
// resolve only on exact match.

const STRIP_RE = /[^a-zA-Z0-9]/g
const MIN_FUZZY_DIGITS = 7

function normalize(address) {
  return (address || '').replace(STRIP_RE, '')
}

export class ContactIndex {
  constructor(entries) {
    this.entries = entries
  }

  static fromContacts(contacts) {
    const entries = []
    for (const contact of contacts || []) {
      if (!contact.displayName) continue
      for (const { address } of contact.phoneNumbers || []) {
        const normalized = normalize(address)
        if (normalized) entries.push({ kind: 'phone', normalized, displayName: contact.displayName })
      }
      for (const { address } of contact.emails || []) {
        const normalized = normalize(address)
        if (normalized) entries.push({ kind: 'email', normalized, displayName: contact.displayName })
      }
    }
    return new ContactIndex(entries)
  }

  // "" (unresolved) keeps the raw handle at the call site, same as an empty
  // contact index would.
  resolve(address) {
    const raw = address || ''
    const kind = raw.includes('@') ? 'email' : 'phone'
    const addr = normalize(raw)
    if (!addr) return ''
    const exact = this.entries.find((e) => e.kind === kind && e.normalized === addr)
    if (exact) return exact.displayName
    if (kind === 'email') return ''
    for (const length of [addr.length, addr.length - 1, addr.length - 2, addr.length - 3]) {
      if (length < MIN_FUZZY_DIGITS) continue
      const ending = addr.slice(-length)
      const match = this.entries.find((e) => e.kind === 'phone' && e.normalized.endsWith(ending))
      if (match) return match.displayName
    }
    return ''
  }
}

export const EMPTY_CONTACT_INDEX = new ContactIndex([])
