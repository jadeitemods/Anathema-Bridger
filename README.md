# AnathemaBridger
Joins three chats into one: **Minecraft**, **Discord** and **Valour**. A message typed
in any of them appears in the other two, and files are shown as short labels such as
`[image]` or `[GIF]`.

It also watches your game server. Errors go to an alerts channel, and trusted staff can
restart the server or send it a console command from Discord or Valour.

Built and tested with BisectHosting. Nothing here depends on them: it works with any
host that runs Fabric, and it runs entirely on one computer if that is what you want.

## What you need
- A **Windows** computer that can stay switched on while people are chatting — this runs the bridge
- A Minecraft server running **1.20.1 with Fabric**
- A Discord bot and a channel for it to post in
- A Valour bot and a channel for it to post in
- A text editor (Notepad is fine) and about half an hour

### Software to install first
| Software | Version | Where to get it |
|---|---|---|
| Node.js | 20 or newer (we test on 24) | https://nodejs.org |
| .NET SDK | 11.0, preview build, matching the adapter's target | https://dotnet.microsoft.com/download/dotnet/11.0 |
| Java | 17 or newer, for the Minecraft server | https://adoptium.net |
| Fabric API | 0.92.2+ for 1.20.1, goes in the server's `mods` folder | https://modrinth.com/mod/fabric-api |

### Platforms
Everything here is built and tested on **Windows**. The launch scripts are Windows
`.cmd` and PowerShell files. You are very welcome to try macOS or Linux — the Node and
Java parts may well behave identically — but we cannot test or guarantee it, so it is
not officially supported. Expect to write your own start scripts, and please report
what happens if you do.


## Words used below
| Word | Meaning here |
|---|---|
| **bridge** | the two background programs that pass messages between the three chats |
| **mod** | the small add-on you drop into the Minecraft server |
| **token** | a long password-like string that lets the bridge act as your bot |
| **channel ID** | the number that identifies one channel |
| **config.json** | the single file you edit; it holds every setting and password |

## Setup
### 1. Make your settings file
Copy `config.example.json`, rename the copy to `config.json`, and open it in a text
editor. Everything below goes in that one file. The values inside `"quotes"` are the
ones you replace; numbers and the `true`/`false` words stay as they are.

### 2. Fill in the `discord` section
1. Go to [discord.com/developers](https://discord.com/developers/applications), create
   an application, open **Bot**, and press **Reset Token**. That long string is
   `botToken` — copy it once, because Discord will not show it again.
2. Turn on **Developer Mode** in Discord (User Settings → Advanced), then right-click
   the channel you want the bot to post in and choose **Copy Channel ID**. That is
   `targetChannelId`.
3. Invite the bot to your server using the **OAuth2 → URL Generator** page, ticking
   `bot` and `applications.commands`.

### 3. Fill in the `valour` section
1. In Valour, click the gear icon to open **General Settings**, then **Developer** at the
   bottom of the left-hand menu, then **Bots**.
2. Press **Create bot**, give it a name, and press **Copy** next to the token. Valour
   shows it once and warns you to save it now — that string is `botToken`.
3. Back in the bot list, the number shown as `ID:` under your bot's name is `botId`.
4. Right-click the channel you want it to post in and copy its id (`targetChannelId`),
   then do the same for your planet (`planetId`).

> **Careful:** Valour's Developer menu also contains **OAuth Apps**. Those are for
> applications that sign a *person* in. This bridge is a bot and needs the token from
> the **Bots** page — an OAuth app secret will not work.

### 4. Choose a secret
`bridge.secret` is a long random string that stops strangers connecting to your
bridge. Any 40+ random characters will do — mash the keyboard, or use a password
generator. You will paste the same value into the Minecraft server in step 7.

Leave `bridge.artifactToken` as a second random string; it only controls who can
download your built mod files.

### 5. Decide where the Minecraft server is
- **Server hosted elsewhere** — you need a public address for the Minecraft server to
  reach. We use Tailscale Funnel; [docs/tailscale.md](docs/tailscale.md) walks through
  it. Put the resulting address in `bridge.publicUrl`, e.g.
  `wss://my-pc.tail1234.ts.net/minecraft`.
- **Everything on one computer** — set `bridge.publicUrl` to
  `ws://127.0.0.1:3000/minecraft`. Nothing is exposed to the internet.

### 6. Optional: server panel details
If your host is BisectHosting, put your panel API key in `hostedserver.apiKey` and the
server's short identifier in `hostedserver.serverId` (panel → Account → API
Credentials). This is what enables alerts, `status`, `restart` and `power`.

Without it, chat still works; you just lose the monitoring and controls.

### 7. Install the mod and start
Upload `anathema-bridge-mod/build/libs/anathema-bridge-1.0.0.jar` (plus **Fabric API**,
which the mod requires) into the server's `mods` folder.

Then add two lines to the server's `fabric-server-launcher.properties`:

```properties
anathema.bridge.url=wss://YOUR-MACHINE.YOUR-TAILNET.ts.net/minecraft
anathema.bridge.secret=the secret from step 4
```

Both come straight from `config.json`. On BisectHosting you can instead run
`node tools/deploy.js --restart`, which writes them through the panel for you.

### 8. Start the bridge
```powershell (or any command terminal on your computer, really)
.\anathema-bridge-node\run-bridge.cmd
.\anathema-bridge-valour\run-adapter.cmd
```

Leave both windows open. Success looks like `Connected to bridge.` in the Minecraft
server's console and `Mod connected.` in the bridge window.

## The whole config file at a glance
| Section | What it holds |
|---|---|
| `discord` | bot token and the channel it posts in |
| `valour` | bot token, bot id, channel id and planet id |
| `minecraft` | the server's address, used for a reachability check |
| `hostedserver` | optional panel key and server id (alerts and controls) |
| `bridge` | shared secret, public address, ports, download token |
| `consolealerts` | the two alert channels and how often to check |
| `control` | who is allowed to run commands (Discord ids, Valour ids) |

Services say exactly what is missing if a value is blank, e.g.
`required setting "valour.botToken" is missing or empty`.

## Commands
Only the people listed in `control.allowedUserIds` (Discord) or
`control.valourUserIds` (Valour) may use these, and only in the alerts channels.
Discord also offers them as `/bridger restart`, `/bridger power` and so on, which
lists them as you type.

```
!bridger restart     restart the server, with a 15 second countdown for players
!bridger power       stop the server if it is running, start it if it is stopped
!bridger status      current state, ticks per second and player count
!bridger cmd [text]  send a console command, brackets required
!bridger help        brings up this guide in chat (not Minecraft chat)
```

Replies come back to whichever platform asked. Restarts, starts and stops are
announced in all three chats, and a power action updates one message rather than
posting a new line every few seconds.

## Alerts
Every 60 seconds the bridge reads the server's console and state, then posts only what
changed: errors, the server going offline or coming back, commands players ran, and a
one-line summary of the bridge's own connection. A crash loop cannot flood the channel
— after five alerts in ten minutes it summarises and goes quiet.

Console `say` messages appear as `[Minecraft] Console: …`, so a staff member using the
panel is visible in chat even with nobody online.

## Files sent in chat
| What was sent | What Minecraft shows |
|---|---|
| one image | `[image]` |
| one GIF | `[GIF]` |
| one video / audio / anything else | `[video]` / `[audio]` / `[file]` |
| several at once | `[3 files]` |

Text plus a file becomes `look at this [GIF]`.

## Self-hosting on one computer
Covered in step 5, in short: set `bridge.publicUrl` to `ws://127.0.0.1:3000/minecraft`,
leave `hostedserver` blank, and let the mod read this file directly by putting this in
the server's `config/anathema-bridge.json`:

```json
{ "sharedConfig": "C:\\…\\AnathemaBridger\\config.json", "enabled": true }
```

Nothing is then exposed to the internet, and no panel API is involved.

## Building it yourself
Only needed if you change the code.

```powershell (or any command terminal on your computer, really)
cd anathema-bridge-mod
.\gradlew build        # the jar lands in build\libs
dotnet build ..\anathema-bridge-valour\AnathemaValourAdapter.csproj
dotnet test ..\anathema-bridge-valour-tests\AnathemaValourAdapter.Tests.csproj
```

## Extra tools
- `node tools/deploy.js [--restart] [--dry-run]` — optional shortcut that writes the mod
  settings and copies the jar through the BisectHosting panel.
- `node tools/format-config.js` — tidies `config.json` back into aligned columns.
- `node tools/anonymize.js <folder> --brand Anathema` — makes a renamed copy with no
  credentials, for publishing. All you have to do is replace the branding text "Anathema"
  with your chosen name.

## Security in one paragraph
Every part of the bridge listens only on `127.0.0.1`, and the Minecraft mod must send
the shared secret before it is accepted. `config.json` holds four credentials and is
excluded from version control; only `config.example.json` is published. If you expose
the bridge through Funnel, that address is public, so treat the secret like a password.

## Licence
**AGPL-3.0-or-later** — the full text is in [LICENSE](LICENSE).
Copyright (c) 2026 Anathema_Core (github.com/jadeitemods).

This project links against the Valour SDK, which is itself AGPL-3.0, so the whole
project is licensed the same way. In plain terms:

- you may run, study, change and share it;
- if you share a modified version, you must publish its source under the same licence;
- if you run a modified version as a network service, its users are entitled to the source.

Forks are therefore allowed, provided they stay open. If you would rather nobody could
modify or redistribute it, keep the repository private — a public AGPL project cannot
prevent that.
