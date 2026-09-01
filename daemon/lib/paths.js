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
  const attachmentsDir = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), id, 'attachments')
  return {
    socketPath: join(env.XDG_RUNTIME_DIR || '/tmp', `${id}.sock`),
    configPath: env.OMAIMSG_CONFIG
      || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), id, 'config.json'),
    pinsPath: join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), id, 'pins.json'),
    readStatePath: join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), id, 'read-state.json'),
    attachmentsDir,
    attachmentPath: (guid, suffix = '') => join(attachmentsDir, encodeAttachmentName(guid) + suffix),
    cachePath: join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), id, 'cache.json')
  }
}

// base64url rather than the raw guid: BlueBubbles attachment guids can carry
// characters that are unsafe as filenames, and the encoding stays collision-free.
function encodeAttachmentName(guid) {
  return Buffer.from(guid, 'utf8').toString('base64url')
}

export const pluginId = String(process.env.OMAIMSG_PLUGIN_ID || CANONICAL_ID)

const resolved = instancePaths(pluginId)

export const socketPath = resolved.socketPath
export const configPath = resolved.configPath
export const pinsPath = resolved.pinsPath
export const readStatePath = resolved.readStatePath
export const cachePath = resolved.cachePath
export const attachmentPath = resolved.attachmentPath
