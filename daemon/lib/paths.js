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
