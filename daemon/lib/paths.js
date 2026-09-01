import { join } from 'node:path'
import { homedir } from 'node:os'

const CANONICAL_ID = 'io.omaimsg'

// The plugin passes its manifest id through verbatim and every path is named
// from it directly, with no exception for any id, so two installs cannot land
// on each other's state however their ids are spelled. Omarchy rejects an id
// holding "/" or ".." (PluginRegistry.qml validateManifest), so nothing here
// has to scrub one.
export function instancePaths(pluginId, env = process.env) {
  const id = String(pluginId || CANONICAL_ID)
  return {
    socketPath: join(env.XDG_RUNTIME_DIR || '/tmp', `${id}.sock`),
    configPath: env.OMAIMSG_CONFIG
      || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), id, 'config.json'),
    pinsPath: join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), id, 'pins.json'),
    readStatePath: join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), id, 'read-state.json'),
    attachmentsDir: join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), id, 'attachments'),
    cachePath: join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), id, 'cache.json')
  }
}

export const pluginId = String(process.env.OMAIMSG_PLUGIN_ID || CANONICAL_ID)

const resolved = instancePaths(pluginId)

export const socketPath = resolved.socketPath
export const configPath = resolved.configPath
export const pinsPath = resolved.pinsPath
export const readStatePath = resolved.readStatePath
export const cachePath = resolved.cachePath

// base64url rather than the raw guid: BlueBubbles attachment guids can carry
// characters that are unsafe as filenames, and the encoding stays collision-free.
export function attachmentPath(guid, suffix = '') {
  return join(resolved.attachmentsDir, Buffer.from(guid, 'utf8').toString('base64url') + suffix)
}
