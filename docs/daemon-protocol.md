# Daemon ↔ plugin protocol (POC)

Newline-delimited JSON over a Unix domain socket at `$XDG_RUNTIME_DIR/<plugin id>.sock` (fallback `/tmp`), so the canonical install is `io.omaimsg.sock`. The plugin names it by appending `.sock` to its manifest id; the daemon derives the same name from `OMAIMSG_PLUGIN_ID`. The daemon accepts multiple clients and fans every push frame out to all of them (one plugin client per monitor). Frame shape follows the convention Quickshell's `Socket` + `SplitParser` consume directly: one JSON object per line, `t` is the frame type.

POC scope: text messages plus image attachments, sent and received. A message with attachments carries their metadata; the daemon downloads image files on request (thumbnail-sized, cached by guid under `$XDG_CACHE_HOME/<plugin id>/attachments/`) and hands back a local path. A message whose only content is attachments still gets `[attachment]` substituted as its text, so previews and non-image attachments render something. No tapbacks, no typing indicators, no read-receipt sync back to Apple.

## Client → daemon

| Frame | Meaning |
|---|---|
| `{"t":"hello"}` | Request a full `state` frame (sent on every connect). |
| `{"t":"chats","limit":40}` | Request the chat list. `limit: 0` asks for the whole list (what a filtered panel needs, since a filter spans the account); an omitted `limit` means 40. |
| `{"t":"messages","chatGuid":"..."}` | Request the newest page of one chat, oldest first. The page size is the daemon's, not the client's (`cache.messagesPerThread` in its config). Served from the daemon's cache when warm; see the reply frame for what that means for the client. |
| `{"t":"olderMessages","chatGuid":"...","beforeTs":1730000000000}` | Request the page ending at `beforeTs` (unix ms) in one chat: what a panel asks for when the reader scrolls to the top of what it holds, passing the timestamp of the oldest message it has. Same page size as `messages`. Never served from cache — the cache is the thread's newest page, so nothing behind it is ever a hit. |
| `{"t":"send","chatGuid":"...","text":"...","tempId":"..."}` | Send a text message. `tempId` is client-generated, echoed in the `ack`. |
| `{"t":"sendImage","chatGuid":"...","path":"/abs/path","tempId":"..."}` | Send one image from a local file. One image per frame and no caption, so picking several files is several frames and a message with text and an image is two sends. The daemon copies the file into its attachment cache keyed by `tempId` and answers with an `attachment` frame for that key **before** the send goes out, so the client's optimistic row renders from the cache like every other image and never from the path it was handed. The send itself is acknowledged with the same `ack` frame a text `send` gets (`for:"send"`), so a failure lands on that one row and leaves the rest of a pick alone. The cached copy is deleted when the socket echo lands, since the echo names the attachment by its real guid; a send that fails keeps its copy, which is what the failed row is still rendering. |
| `{"t":"read","chatGuid":"..."}` | Mark a chat read: the daemon records that this install has been shown everything it knows of in the chat, persisted to `$XDG_STATE_HOME/<plugin id>/read-state.json` so a restart cannot resurrect it. Not synced to Apple (see the unread section). Answered with a `state` frame, not a `chats` frame -- a client mirroring unread clears its own row. |
| `{"t":"pin","chatGuid":"...","pinned":true}` | Pin or unpin a chat. Daemon-local (Apple keeps iPhone pins outside chat.db, so BlueBubbles can't see them); persisted to `$XDG_STATE_HOME/<plugin id>/pins.json` so pins survive restarts. The daemon replies by broadcasting a fresh `chats` frame to all clients. |
| `{"t":"attachment","guid":"..."}` | Request a local file for one attachment. The daemon serves it from the guid-keyed cache or downloads it from BlueBubbles (images come back thumbnail-width, re-encoded as PNG by the server). |
| `{"t":"preview","guid":"..."}` | Request a viewer-ready file for one attachment. Replies immediately with a `.preview` file holding the best bytes on hand (the cached full-size file, else a copy of the thumbnail), then downloads the full-size file in the background (cached as `.full`) and overwrites the `.preview` in place — a viewer that watches the file (imv does) upgrades itself. A failed background upgrade is logged, never surfaced; the viewer keeps the thumbnail. |
| `{"t":"ping"}` | Liveness probe. |

## Daemon → client

| Frame | Meaning |
|---|---|
| `{"t":"state","connection":"connected\|connecting\|error","serverUrl":"...","unread":3,"lastError":""}` | Daemon/BlueBubbles link status. Sent on connect, on any status change, and in reply to `hello`. `unread` counts **chats** with something unread, not messages -- `Chat.unread` is the message count for one chat, and the two do not sum to each other. |
| `{"t":"chats","chats":[Chat],"unread":3}` | Reply to `chats`, and the frame a `pin` broadcasts. Served from the daemon's cache when it holds one, so it can arrive before the BlueBubbles fetch behind it; a second frame follows only when that fetch turns out to differ from what was served. A failed revalidation leaves the served list standing and is logged, not surfaced as an `error`. |
| `{"t":"messages","chatGuid":"...","messages":[Message],"unavailable":false}` | Reply to `messages`. `unavailable` is true when the page came back empty, which a client should render as "the Mac has nothing filed under this chat" rather than as a still-loading thread. One request can produce **two** of these: the daemon answers a cached thread immediately, then revalidates against BlueBubbles and sends a second frame only if that page differs. Treat every `messages` frame as the full replacement for its `chatGuid`, never as an increment, and never assume one reply per request — which also means it discards any older pages the client had paged in, so a client tracking exhaustion resets it here. A revalidation that fails leaves the cached frame standing with no `error` frame — a BlueBubbles outage surfaces through `state`. |
| `{"t":"olderMessages","chatGuid":"...","messages":[Message],"exhausted":false}` | Reply to `olderMessages`, and the one frame that is **additive**: prepend it, never swap the thread for it. Exactly one per request. Oldest first, and the cut is **inclusive** — the cursor message comes back with every page, along with anything sharing its millisecond, so a client must dedupe by guid before prepending. That inclusiveness is deliberate: BlueBubbles offers no exclusive cut, and asking for one millisecond earlier instead would make a same-millisecond sibling unreachable forever. `exhausted` is therefore "the page holds nothing strictly older than `beforeTs`", not "the page is empty"; it is what tells a client to stop asking rather than retry forever. |
| `{"t":"message","chatGuid":"...","message":Message,"chat":Chat,"unread":4}` | Push: a new message. The daemon always pushes the client's own sends too (BlueBubbles echoes them over Socket.IO with `tempGuid` stamped); an echoed send's `Message` carries `tempId` so the client can promote its optimistic row exactly. BlueBubbles emits that echo twice under one guid, only the first stamped with `tempGuid`; the daemon forwards a guid once, so the client never sees a duplicate frame. `chat` is the updated preview for the list. |
| `{"t":"ack","for":"send","chatGuid":"...","tempId":"...","guid":"...","ok":true}` | Send accepted by BlueBubbles, for a `send` and a `sendImage` alike -- `for` is `"send"` in both cases, so one client path patches both rows. `guid` is the real message guid from the send response (`""` if unavailable). `ok:false` plus `message` on failure. |
| `{"t":"attachment","guid":"...","path":"/abs/path"}` | Reply to `attachment`: the file is on disk at `path`. Also sent unrequested, keyed by a `tempId`, as the first half of a `sendImage`. |
| `{"t":"preview","guid":"...","path":"/abs/path"}` | Reply to `preview`: open `path` now; its content may upgrade in place afterwards. |
| `{"t":"error","for":"chats\|messages\|olderMessages\|send\|...","message":"..."}` | Request failed. An `attachment` or `preview` error also carries the requested `guid`, and an `olderMessages` error its `chatGuid`, so the client can clear its pending state for exactly that image or thread. |
| `{"t":"pong"}` | Reply to `ping`. |

## Objects

```
Chat    { guid, name, isGroup, pinned, lastMessage: { text, ts, fromMe }, unread }   // isGroup: >1 participant

Chat-list order: pinned chats first, then unpinned; most-recent lastMessage.ts first within each block, chats with no lastMessage at the end of their block.

Chat.lastMessage is sticky: once the daemon has a preview for a chat, a later BlueBubbles fetch that omits the field (the server does this per chat, even when the field is asked for) leaves the known one standing rather than blanking it. A chat therefore reads `null` only while nothing has ever been seen for it.
Message { guid, text, ts, fromMe, sender, attachments?, tempId? }   // ts = unix ms; sender = display name, "" when fromMe; tempId only on echoed own sends

Message.attachments: [{ guid, mime, name, width?, height? }], present only when non-empty. `width`/`height` are the original pixel dimensions, present only when BlueBubbles reports both as non-zero, so the UI can reserve an image's box before the file arrives; the downloaded thumbnail keeps this aspect ratio. `mime` is the original mimeType ("" when BlueBubbles omits it) -- the UI decides what to render from it; the downloaded file for an image may still be PNG (server-side resize re-encodes).
```

chat.db can hold messages with no chat link at all, and every chat-scoped route on the server inner-joins chats, so those threads read as empty. For a 1:1 chat the daemon retries by the participant's handle with no chat relation requested, which does reach them (measured: 11 of 40 such chats recovered). Two limits come with it: a group cannot be recovered this way, and chat.db links outbound messages by chat rather than handle, so a recovered thread shows only what the other person sent.

Unread is derived, never counted. A chat's unread messages are the ones newer than a **read boundary**, and the boundary is the later of two things: what Apple reports the account has seen, and what this install has been shown. Apple's half is re-derived from the server on every daemon start; this install's half is one timestamp per chat, persisted to `$XDG_STATE_HOME/<plugin id>/read-state.json` and moved by a `read` frame or by BlueBubbles reporting the chat read (`chat-read-status-changed`, which is what reading the chat on a phone triggers). That file is **state, not cache**: nothing can reconstruct it, because reading a chat here cannot clear it on Apple -- writing read state back to the Mac goes through the Private API, which this setup does not use. Deleting it makes every chat unread again up to Apple's own boundary.

Apple's half is approximate, because BlueBubbles exposes no unread field. Two signals, neither trusted alone:

1. `dateRead` on a message **decides**: a chat counts as unread when its newest inbound messages carry no `dateRead` *and* the chat has recorded a read before, which is what proves the Mac tracks read state there. A chat that has never recorded one is unknowable and seeds as zero.
2. `properties[0].lastSeenMessageGuid` on the chat -- the last message the *Mac* has been shown -- may only **shorten** that answer, never create one. Both runs start at the newest message, so the shorter of the two wins.

Each signal is wrong in its own direction, which is why the veto is one-way. Reading a chat on an iPhone does not stamp `dateRead` on the Mac's copy of an inbound message, so signal 1 alone reports such a chat unread forever; signal 2 sees it and clears it. But signal 2 syncs from a phone only sometimes, so trusting it to *create* unread turned 2 unread chats into 19 on a real account, two groups claiming 51 and 62. Roughly a quarter of chats carry it at all.

The persisted boundary catches whatever neither signal does: once you open a chat here, it stays read across restarts.

The chat list and the warm thread pages — the newest page of each of the most recently read chats, kept warm by inbound pushes — survive a restart in `$XDG_CACHE_HOME/<plugin id>/cache.json`, written debounced and atomically and flushed on shutdown. That file is **cache, not state**: a boot serves it through the same cache-first-then-revalidate contract the frames above describe, so a stale entry corrects itself on the fetch behind it and deleting the file costs nothing but the first paint. There is no staleness bound, and read state is not in it.

Both sizes come from the daemon's config (`~/.config/<plugin id>/config.json`), which is also the only place a page size is set:

```
{ "serverUrl": "...", "password": "...", "cache": { "threads": 30, "messagesPerThread": 60 } }
```

`messagesPerThread` is one number doing two jobs on purpose: it is both the page the daemon serves and the tail it caches, so a warm thread open can never come up short of what the client just asked for. Omit `cache`, or either key, to take the defaults above.

## Notifications

The daemon raises the desktop notification for an inbound message, and the plugin must not. Two reasons: the daemon is the one component guaranteed to be running (the shell can restart under it), and the plugin runs one client per monitor, so a plugin-side toast would fire once per screen. A `message` frame therefore carries no instruction to notify, and a client that sees one has nothing to do about it.

One toast per inbound message, never stacked or replaced. It goes out through `omarchy-notification-send`, and its click action is `omarchy-shell <plugin id> openChat <chat guid>` — the plugin's bar widget exposes `openChat` alongside `open`, `close` and `toggle` for exactly this. The body is the message's own text, collapsed to one line and otherwise whole: Omarchy's toast card wraps and elides it, so cutting it here would only move the ellipsis earlier. A message whose only content is attachments says what they are and how many ("Sent a photo", "Sent 3 attachments") rather than the `[attachment]` placeholder the panel renders. Own sends never notify, the socket echo included, and neither does a message with no text and no attachments (a tapback, a group event) because there is nothing to put in the toast. Nothing is suppressed based on which chat is on screen: the daemon has no live focus signal, and a `read` frame is not one.

Set `"notifications": false` in the daemon's config to silence them. It lives there and not in the manifest because manifest settings reach the QML only, and the daemon has no channel to them.
