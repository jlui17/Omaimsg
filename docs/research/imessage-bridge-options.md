# iMessage bridge options for a custom Linux client

Question: which existing iMessage-bridge project should the Omarchy menu-bar client build on? The client is a thin keyboard-native UI on Linux; the bridge owns iMessage sync/relay. Justin has a Mac that can stay on 24/7, so Mac-server bridges are in play. Researched 2026-08-28 against primary sources (repos, official docs, live API checks); citations per claim.

## Recommendation: BlueBubbles

**BlueBubbles is the only candidate that is both alive and built for third-party clients.** It ships a documented REST API plus Socket.IO/webhooks for realtime events, its docs have a dedicated developer-guides section for exactly this use case, and the project has commits within the last month. Runner-up is the Matrix route (mautrix-imessage's BlueBubbles connector), which puts a homeserver between us and the same BlueBubbles server: sane architecture, heavy stack for one account. The fact that would have flipped this: no always-on Mac, which would have forced the OpenBubbles/rustpush path (and that path has no network API to build against anyway, plus SSPL licensing).

| | BlueBubbles | AirMessage | mautrix-imessage (Matrix) | OpenBubbles / rustpush / pypush |
|---|---|---|---|---|
| Needs a Mac | Yes, always-on | Yes, always-on | Yes (every backend) | One-time (Mac) or always-on jailbroken iPhone |
| API for a custom client | REST + Socket.IO + webhooks, documented | Custom binary protocol, source-only, maintainers ask you not to | Matrix client-server API (open spec) | None (in-process FFI library only) |
| Maintained | Yes (commits 2026-07) | Dead since 2022 | Maintenance-only | rustpush active; key deps closed/broken |
| License | Apache-2.0 | Apache-2.0 | AGPL-3.0 | SSPL (rustpush/pypush) |

## BlueBubbles

**Requirements.** A real Mac running the server app, signed into iMessage; macOS Sierra+ ([docs.bluebubbles.app/server](https://docs.bluebubbles.app/server)). The optional Private API layer (typing indicators, reactions with better fidelity, edits/unsends) hooks Apple's private `IMCore.framework` and needs SIP considerations on the Mac ([docs.bluebubbles.app/private-api](https://docs.bluebubbles.app/private-api)). VMs work but the maintainers recommend real hardware "to avoid compromising your Apple ID" ([server docs, VM section](https://docs.bluebubbles.app/server)).

**API surface.** Third-party clients are an explicitly documented use case ([developer guides](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks)). The reference is a Postman collection ([documenter.getpostman.com/view/765844/UV5RnfwM](https://documenter.getpostman.com/view/765844/UV5RnfwM)); no OpenAPI spec exists. Auth is the server password as a `guid`/`password` query param. Coverage, verified against the collection:

- Send: `POST /api/v1/message/text`, `/message/multipart`, plus edit and unsend endpoints.
- Read: `POST /api/v1/chat/query`, `GET /api/v1/chat/<GUID>/message`, `POST /api/v1/message/query`.
- Realtime: Socket.IO (what the official app uses) or webhooks; events cover new messages, delivery/read updates, typing indicators, group changes.
- Attachments: upload, download, blurhash previews. Reactions: `POST /api/v1/message/react`. Typing: `POST`/`DELETE /api/v1/chat/<GUID>/typing`.

**Maintenance.** Last tagged server release v1.9.9 (2025-05-16), but commits continue through 2026-07-23 and the Flutter client released 2026-08-13 ([releases](https://github.com/BlueBubblesApp/bluebubbles-server/releases), [commits](https://github.com/BlueBubblesApp/bluebubbles-server/commits/master), [app release](https://github.com/BlueBubblesApp/bluebubbles-app/releases/tag/v2.1.1%2B91)). 101 open issues; macOS 26 "Tahoe" broke the Private API helper and fixes are community-driven ([#776](https://github.com/BlueBubblesApp/bluebubbles-server/issues/776), [#779](https://github.com/BlueBubblesApp/bluebubbles-server/issues/779)).

**Risks.** Apple revoked BlueBubbles' developer account, so the server app is unsigned (Gatekeeper bypass to install; [server docs](https://docs.bluebubbles.app/server)). Every macOS major release breaks the Private API layer for a while ([#669](https://github.com/BlueBubblesApp/bluebubbles-server/issues/669), [#776](https://github.com/BlueBubblesApp/bluebubbles-server/issues/776)); the core AppleScript/chat.db path degrades more gracefully. License Apache-2.0 ([LICENSE](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/LICENSE)).

## AirMessage — rejected: abandoned

Same shape as BlueBubbles (Mac server, custom clients) but effectively dead: no commits or releases in any repo since late 2022 ([releases](https://github.com/airmessage/airmessage-server/releases)), the maintainer said in 2023 they may shut the servers down ([#43](https://github.com/airmessage/airmessage-server/issues/43)), and airmessage.org's TLS cert has been expired since 2025-11 (verified live via `curl`). The protocol is a custom binary format defined only in Swift source with no spec ([CommConst.swift](https://github.com/airmessage/airmessage-server/blob/main/AirMessage/Connection/CommConst.swift)), no typing-indicator support at all, and the READMEs ask third parties not to use the official Connect servers ([README](https://github.com/airmessage/airmessage-server#readme)). Apache-2.0, so self-hosting is legal, but there's nothing here BlueBubbles doesn't do better with a living community.

## mautrix-imessage (Matrix route) — runner-up

Architecture: our client speaks the open, versioned [Matrix client-server API](https://spec.matrix.org/v1.19/client-server-api/) to a homeserver; the bridge translates to iMessage server-side. The client-side story is genuinely clean (login, `/sync`, send; mature SDKs like [matrix-rust-sdk](https://github.com/matrix-org/matrix-rust-sdk)), and the bridge's best backend today is literally a BlueBubbles connector ([imessage/bluebubbles](https://github.com/mautrix/imessage/blob/master/imessage/bluebubbles/README.md)) — so this route is BlueBubbles plus a homeserver, a websocket proxy, and the bridge.

Rejected for the POC on weight and health: running Synapse + wsproxy + bridge for one account is a federation-grade stack; the bridge is maintenance-only (no releases or tags ever, last real commits 2025, maintainer absent from issue threads — [commits](https://github.com/mautrix/imessage/commits/master), [#216](https://github.com/mautrix/imessage/issues/216)); the non-BlueBubbles backends are dead (Barcelona unmaintained per the project's own [ROADMAP](https://github.com/mautrix/imessage/blob/master/ROADMAP.md); Beeper archived its whole iMessage stack — [beeper/imessage](https://github.com/beeper/imessage)). AGPL-3.0. Worth revisiting only if we later want many networks in one client, since Matrix bridges exist for everything.

## OpenBubbles / rustpush / pypush (no-Mac path) — rejected: no API, licensing

The reverse-engineered path doesn't actually need an always-on Mac (OpenBubbles registers once from a real Mac's hardware identifiers, then the Mac can go away — [FAQ](https://openbubbles.app/docs/faq.html), [renewal docs](https://openbubbles.app/docs/renewal.html)), which is its one real advantage. It's rejected anyway:

- **Nothing to build against.** rustpush is an in-process Rust library ([Cargo.toml](https://github.com/OpenBubbles/rustpush/blob/master/Cargo.toml), no bin targets); OpenBubbles embeds it via Flutter FFI. Neither exposes a network API a separate Linux client could talk to. pypush is mid-rewrite and currently does APNs only, no iMessage ([README](https://github.com/JJTech0130/pypush/blob/main/README.md)).
- **Licensing.** rustpush and pypush are SSPL, with a carve-out granting full rights to OpenBubbles only ([LICENSE.exceptions](https://github.com/OpenBubbles/rustpush/blob/master/LICENSE.exceptions)); a third-party client doesn't get that carve-out. pypush was bought by Beeper.
- **Account risk and breakage.** OpenBubbles' own docs warn of temporary/permanent Apple ID blocks ([FAQ](https://openbubbles.app/docs/faq.html)); pypush contributors describe non-genuine-hardware accounts stuck permanently throttled ([#90](https://github.com/JJTech0130/pypush/issues/90)); macOS 26 broke the registration path with the fix open since April ([rustpush #21](https://github.com/OpenBubbles/rustpush/issues/21)). With a real always-on Mac available, taking this risk buys nothing.

Interestingly, rustpush's default validation-data feature depends on `open-absinthe`, whose public repo is an explicit stub ("closed source... does not contain any actual functionality" — [OpenAbsinthe-Stub](https://github.com/OpenBubbles/OpenAbsinthe-Stub/blob/main/README.md)): the working no-Mac core isn't actually published.

## What flips the choice

- **Losing the always-on Mac** → OpenBubbles for personal use, but a custom client would mean linking rustpush directly under SSPL; realistically we'd stop the project or accept OpenBubbles' own app.
- **Wanting multiple networks in one client** → revisit the Matrix route; the client we write against BlueBubbles' API would be rewritten as a Matrix client.
- **BlueBubbles going the way of AirMessage** → its Apache-2.0 server is forkable, and the Matrix bridge's BlueBubbles connector shares the same server API, so the client-side investment survives.
