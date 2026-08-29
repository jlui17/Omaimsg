import { join } from 'node:path'
import { homedir } from 'node:os'

// $XDG_RUNTIME_DIR/omaimsg.sock, falling back to /tmp when the session has no
// runtime dir (e.g. a bare smoke-test environment). OMAIMSG_SOCKET overrides
// both, so the smoke script can run daemons side by side without colliding.
export const socketPath = process.env.OMAIMSG_SOCKET
  || join(process.env.XDG_RUNTIME_DIR || '/tmp', 'omaimsg.sock')

export const configPath = process.env.OMAIMSG_CONFIG
  || join(homedir(), '.config', 'omaimsg', 'config.json')

export const pinsPath = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'omaimsg',
  'pins.json'
)

const attachmentsDir = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'omaimsg',
  'attachments'
)

// base64url rather than the raw guid: BlueBubbles attachment guids can carry
// characters that are unsafe as filenames, and the encoding stays collision-free.
export function attachmentPath(guid, suffix = '') {
  return join(attachmentsDir, Buffer.from(guid, 'utf8').toString('base64url') + suffix)
}
