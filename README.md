# AnathemaBridger

Three-way chat bridge between Minecraft, Discord and Valour.

Built and tested against BisectHosting, but nothing is specific to them: it works with
any host that runs Fabric and allows outbound connections, and it runs entirely
self-hosted on one machine. See [Hosting](#hosting) for the differences.

```
config.json                    <- the only file you edit
├── anathema-bridge-node/       Node bridge (Discord side, WebSocket server)
├── anathema-bridge-valour/     .NET adapter (Valour side, E2EE)
├── anathema-bridge-valour-tests/
└── anathema-bridge-mod/        Fabric mod (Minecraft side)
```

## Configuration

Copy `config.example.json` to `config.json` and fill it in. Every process reads that
one file; no secrets live in source or in per-service configs.

| Section | Keys | Used by |
|---|---|---|
| `discord` | `botToken`, `targetChannelId` | Node bridge |
| `valour` | `botToken`, `botId`, `targetChannelId`, `planetId` | Valour adapter |
| `minecraft` | `serverAddress` | Node bridge (reachability check) |
| `hostedserver` | `apiKey`, `serverId` | Node bridge (alerts, power, console) |
| `bridge` | `secret`, `publicUrl`, ports, `websocketPath`, `artifactToken` | all three |
| `consolealerts` | `discordChannelId`, `valourChannelId`, `pollSeconds` | Node bridge |
| `control` | `allowedUserIds` (Discord), `valourUserIds` (Valour) | bridge / adapter |

Where the values come from:

- **`discord.*`** — Developer Portal → your app → Bot → Reset Token; channel ids from
  right-click → Copy ID with Developer Mode on.
- **`valour.*`** — Valour bot token and its user id, plus the channel and planet ids.
- **`hostedserver.*`** — BisectHosting panel → Account → API Credentials, and the
  server identifier from the panel.
- **`bridge.secret`** — any long random string; the mod sends it as a header.
- **`bridge.publicUrl`** — what the Minecraft server dials: your Tailscale Funnel URL
  for a hosted server, or `ws://127.0.0.1:3000/minecraft` on one machine.
- **`bridge.artifactToken`** — random string that lets the panel fetch built jars.

Services fail fast and name the missing key, e.g.
`required setting "valour.botToken" is missing or empty in …\config.json`.
`ANATHEMA_CONFIG` points at the file from another location.

## Minecraft end

The mod lives inside the server's directory, which hosted panels rarely expose for
editing, so it gets a pointer — two lines in `fabric-server-launcher.properties`:

```properties
anathema.bridge.url=wss://YOUR-MACHINE.YOUR-TAILNET.ts.net/minecraft
anathema.bridge.secret=<the same bridge.secret from config.json>
```

Both values come from `config.json`. Either paste them by hand, or let
`tools/deploy.js` write them through the panel API.

When the server runs on the same machine as the bridge, the mod can read `config.json`
directly instead, via `"sharedConfig": "…\\AnathemaBridger\\config.json"` in its own
`config/anathema-bridge.json`, or `ANATHEMA_CONFIG` in the launch script.

## Running

```powershell
.\anathema-bridge-node\run-bridge.cmd
.\anathema-bridge-valour\run-adapter.cmd
```

Both write to `logs\`. `run-adapter.ps1 -Foreground` runs in the console instead.

## Hosting

### Hosted Minecraft server (what we run)

The bridge lives on a machine you control and the game server dials out to it, so no
inbound port is opened on the host. Publish the WebSocket with Tailscale Funnel —
[details](docs/tailscale.md) — and set `bridge.publicUrl` to the resulting
`wss://…ts.net/minecraft`.

The panel API (`hostedserver.*`) is optional; without it you lose alerts, `status`,
`restart`, `power` and the deploy script, but chat still flows both ways.

### Self-hosting everything on one machine

1. Install Node 20+, the .NET runtime, and Java for the server.
2. In `config.json`, set `publicUrl` to `ws://127.0.0.1:3000/minecraft` and leave
   `hostedserver` blank — there is no panel to talk to.
3. Start `run-bridge.cmd`, then `run-adapter.cmd`.
4. Give the mod the same address and secret. Because the server is on this machine,
   it can read `config.json` directly instead of duplicating values:

   ```json
   { "sharedConfig": "C:\\…\\AnathemaBridger\\config.json", "enabled": true }
   ```

   saved as `config/anathema-bridge.json` in the server directory.

No Funnel, no panel, no public exposure: everything stays on loopback. The mod's
`anathema.bridge.url` / `anathema.bridge.secret` properties work here too if you prefer
not to use `sharedConfig`.

## Commands

Whitelisted by `control.allowedUserIds` / `control.valourUserIds`, and only accepted in
the alerts channels. Discord also exposes them as `/bridger <subcommand>`.

```
!bridger restart     restart with a 15s countdown (warnings at 15s, 10s, 5s)
!bridger power       stop if running, start if stopped
!bridger status      state, TPS and player count
!bridger cmd [text]  send a console command, brackets required
!bridger help
```

Replies return only to the platform that asked. Power results and state changes are
announced everywhere: both alerts channels and all three chat channels.

A power action posts one message and edits it rather than posting each tick, and a
second command mid-transition is answered with "already restarting (34s)".

## Alerts

Every 60 seconds the bridge reads the console tail and server state, then reports only
what changed: console errors, offline/online transitions, player commands, and a single
summary of bridge-link activity (`connected ×2, not connected ×1`). Repeated errors are
capped at five per ten minutes with a suppressed count.

Console `say` from the panel is relayed to Discord and Valour as `[Minecraft] Console: …`
— no player needs to be online, and join/leave notices are ignored.

## Relaying attachments

| Attachment | Relayed as |
|---|---|
| one image | `[image]` |
| one GIF | `[GIF]` |
| one video / audio / anything else | `[video]` / `[audio]` / `[file]` |
| several | `[3 files]` |

A post with no text relays just the tag; text plus a file becomes `look at this [GIF]`.

## Build

```powershell
cd anathema-bridge-mod
.\gradlew build        # jar lands in build\libs
dotnet build ..\anathema-bridge-valour\AnathemaValourAdapter.csproj
dotnet test ..\anathema-bridge-valour-tests\AnathemaValourAdapter.Tests.csproj
```

## Tools

- `node tools/deploy.js [--restart] [--dry-run]` — optional: writes the mod settings and
  pulls the jar through the panel API. Equivalent to copying the lines by hand.
- `node tools/format-config.js` — re-aligns `config.json` after a programmatic edit.
- `node tools/anonymize.js <dir> --brand Anathema` — renamed, credential-free copy for
  publishing: config, E2EE keys, logs and build output excluded, host names replaced.

## Security

- Every listener binds to `127.0.0.1`. The mod socket authenticates with
  `X-Bridge-Secret` during the handshake and rejects unknown clients with 401.
- `config.json` holds four credentials and is gitignored; only
  `config.example.json` is committed.
- Exposing the bridge through Funnel makes that endpoint public — the secret is the
  only gate, so treat it as a password.

## Licence

Proprietary, all rights reserved — see [LICENSE](LICENSE). The source is published so
it can be read and run, not modified or redistributed. Running an unmodified copy for
your own servers is permitted; publishing altered copies, or bundling this with a
modpack or paid service, is not.
