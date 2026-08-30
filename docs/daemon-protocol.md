# Daemon ↔ plugin protocol (POC)

Newline-delimited JSON over a Unix domain socket at `$XDG_RUNTIME_DIR/omaimsg.sock` (fallback `/tmp/omaimsg.sock`). The daemon accepts multiple clients and fans every push frame out to all of them (one plugin client per monitor). Frame shape follows the convention Quickshell's `Socket` + `SplitParser` consume directly: one JSON object per line, `t` is the frame type.

POC scope: text messages plus image attachments. A message with attachments carries their metadata; the daemon downloads image files on request (thumbnail-sized, cached by guid under `$XDG_CACHE_HOME/omaimsg/attachments/`) and hands back a local path. A message whose only content is attachments still gets `[attachment]` substituted as its text, so previews and non-image attachments render something. No tapbacks, no typing indicators, no read-receipt sync back to Apple.

## Client → daemon

| Frame | Meaning |
|---|---|
| `{"t":"hello"}` | Request a full `state` frame (sent on every connect). |
| `{"t":"chats","limit":40}` | Request the chat list. |
| `{"t":"messages","chatGuid":"...","limit":60}` | Request recent messages for one chat, oldest first. Served from the daemon's cache when warm; see the reply frame for what that means for the client. |
| `{"t":"send","chatGuid":"...","text":"...","tempId":"..."}` | Send a text message. `tempId` is client-generated, echoed in the `ack`. |
| `{"t":"read","chatGuid":"..."}` | Mark a chat read (clears its unread count in the daemon; not synced to Apple in the POC). |
| `{"t":"pin","chatGuid":"...","pinned":true}` | Pin or unpin a chat. Daemon-local (Apple keeps iPhone pins outside chat.db, so BlueBubbles can't see them); persisted to `$XDG_STATE_HOME/omaimsg/pins.json` so pins survive restarts. The daemon replies by broadcasting a fresh `chats` frame to all clients. |
| `{"t":"attachment","guid":"..."}` | Request a local file for one attachment. The daemon serves it from the guid-keyed cache or downloads it from BlueBubbles (images come back thumbnail-width, re-encoded as PNG by the server). |
| `{"t":"preview","guid":"..."}` | Request a viewer-ready file for one attachment. Replies immediately with a `.preview` file holding the best bytes on hand (the cached full-size file, else a copy of the thumbnail), then downloads the full-size file in the background (cached as `.full`) and overwrites the `.preview` in place — a viewer that watches the file (imv does) upgrades itself. A failed background upgrade is logged, never surfaced; the viewer keeps the thumbnail. |
| `{"t":"ping"}` | Liveness probe. |

## Daemon → client

| Frame | Meaning |
|---|---|
| `{"t":"state","connection":"connected\|connecting\|error","serverUrl":"...","unread":3,"lastError":""}` | Daemon/BlueBubbles link status. Sent on connect, on any status change, and in reply to `hello`. |
| `{"t":"chats","chats":[Chat],"unread":3}` | Reply to `chats`, and the frame a `pin` broadcasts. Served from the daemon's cache when it holds one, so it can arrive before the BlueBubbles fetch behind it; a second frame follows only when that fetch turns out to differ from what was served. A failed revalidation leaves the served list standing and is logged, not surfaced as an `error`. |
| `{"t":"messages","chatGuid":"...","messages":[Message]}` | Reply to `messages`. One request can produce **two** of these: the daemon answers a cached thread immediately, then revalidates against BlueBubbles and sends a second frame only if that page differs. Treat every `messages` frame as the full replacement for its `chatGuid`, never as an increment, and never assume one reply per request. A revalidation that fails leaves the cached frame standing with no `error` frame — a BlueBubbles outage surfaces through `state`. |
| `{"t":"message","chatGuid":"...","message":Message,"chat":Chat,"unread":4}` | Push: a new message. The daemon always pushes the client's own sends too (BlueBubbles echoes them over Socket.IO with `tempGuid` stamped); an echoed send's `Message` carries `tempId` so the client can promote its optimistic row exactly. BlueBubbles emits that echo twice under one guid, only the first stamped with `tempGuid`; the daemon forwards a guid once, so the client never sees a duplicate frame. `chat` is the updated preview for the list. |
| `{"t":"ack","for":"send","chatGuid":"...","tempId":"...","guid":"...","ok":true}` | Send accepted by BlueBubbles. `guid` is the real message guid from the send response (`""` if unavailable). `ok:false` plus `message` on failure. |
| `{"t":"attachment","guid":"...","path":"/abs/path"}` | Reply to `attachment`: the file is on disk at `path`. |
| `{"t":"preview","guid":"...","path":"/abs/path"}` | Reply to `preview`: open `path` now; its content may upgrade in place afterwards. |
| `{"t":"error","for":"chats\|messages\|send\|...","message":"..."}` | Request failed. An `attachment` or `preview` error also carries the requested `guid`, so the client can clear its pending state for exactly that image. |
| `{"t":"pong"}` | Reply to `ping`. |

## Objects

```
Chat    { guid, name, isGroup, pinned, lastMessage: { text, ts, fromMe }, unread }   // isGroup: >1 participant

Chat-list order: pinned chats first, then unpinned; most-recent lastMessage.ts first within each block, chats with no lastMessage at the end of their block.
Message { guid, text, ts, fromMe, sender, attachments?, tempId? }   // ts = unix ms; sender = display name, "" when fromMe; tempId only on echoed own sends

Message.attachments: [{ guid, mime, name }], present only when non-empty. `mime` is the original mimeType ("" when BlueBubbles omits it) -- the UI decides what to render from it; the downloaded file for an image may still be PNG (server-side resize re-encodes).
```

Unread counts are daemon-owned, in-memory only (reset on daemon restart): +1 per inbound message to a chat that isn't marked read since, cleared by `read`.

Thread pages are cached the same way — in memory, dying with the daemon: the last 60 messages of each of the 30 most recently read chats, kept warm by inbound pushes.
