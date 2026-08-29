# Daemon ↔ plugin protocol (POC)

Newline-delimited JSON over a Unix domain socket at `$XDG_RUNTIME_DIR/omaimsg.sock` (fallback `/tmp/omaimsg.sock`). The daemon accepts multiple clients and fans every push frame out to all of them (one plugin client per monitor). Frame shape follows the convention Quickshell's `Socket` + `SplitParser` consume directly: one JSON object per line, `t` is the frame type.

POC scope: text messages only. No attachments (render `[attachment]` placeholder text the daemon substitutes), no tapbacks, no typing indicators, no read-receipt sync back to Apple.

## Client → daemon

| Frame | Meaning |
|---|---|
| `{"t":"hello"}` | Request a full `state` frame (sent on every connect). |
| `{"t":"chats","limit":40}` | Request the chat list. |
| `{"t":"messages","chatGuid":"...","limit":60}` | Request recent messages for one chat, oldest first. |
| `{"t":"send","chatGuid":"...","text":"...","tempId":"..."}` | Send a text message. `tempId` is client-generated, echoed in the `ack`. |
| `{"t":"read","chatGuid":"..."}` | Mark a chat read (clears its unread count in the daemon; not synced to Apple in the POC). |
| `{"t":"pin","chatGuid":"...","pinned":true}` | Pin or unpin a chat. Daemon-local (Apple keeps iPhone pins outside chat.db, so BlueBubbles can't see them); persisted to `$XDG_STATE_HOME/omaimsg/pins.json` so pins survive restarts. The daemon replies by broadcasting a fresh `chats` frame to all clients. |
| `{"t":"ping"}` | Liveness probe. |

## Daemon → client

| Frame | Meaning |
|---|---|
| `{"t":"state","connection":"connected\|connecting\|error","serverUrl":"...","unread":3,"lastError":""}` | Daemon/BlueBubbles link status. Sent on connect, on any status change, and in reply to `hello`. |
| `{"t":"chats","chats":[Chat],"unread":3}` | Reply to `chats`. |
| `{"t":"messages","chatGuid":"...","messages":[Message]}` | Reply to `messages`. |
| `{"t":"message","chatGuid":"...","message":Message,"chat":Chat,"unread":4}` | Push: a new message. The daemon always pushes the client's own sends too (BlueBubbles echoes them over Socket.IO with `tempGuid` stamped); an echoed send's `Message` carries `tempId` so the client can promote its optimistic row exactly. `chat` is the updated preview for the list. |
| `{"t":"ack","for":"send","chatGuid":"...","tempId":"...","guid":"...","ok":true}` | Send accepted by BlueBubbles. `guid` is the real message guid from the send response (`""` if unavailable). `ok:false` plus `message` on failure. |
| `{"t":"error","for":"chats\|messages\|send\|...","message":"..."}` | Request failed. |
| `{"t":"pong"}` | Reply to `ping`. |

## Objects

```
Chat    { guid, name, isGroup, pinned, lastMessage: { text, ts, fromMe }, unread }   // isGroup: >1 participant

Chat-list order: pinned chats first, then unpinned; most-recent lastMessage.ts first within each block, chats with no lastMessage at the end of their block.
Message { guid, text, ts, fromMe, sender, tempId? }   // ts = unix ms; sender = display name, "" when fromMe; tempId only on echoed own sends
```

Unread counts are daemon-owned, in-memory only (reset on daemon restart): +1 per inbound message to a chat that isn't marked read since, cleared by `read`.
