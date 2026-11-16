# Anathema Bridge (Fabric mod)

Server-side Fabric mod that attaches a Minecraft server to the Anathema bridge
(`anathema-bridge-node`), giving one chat between Minecraft, Discord and Valour.

## Requirements

- Minecraft 1.20.1, Fabric Loader 0.17.2+, Fabric API 0.92.2+
- Java 17+
- The bridge (`anathema-bridge-node`) running on the **same machine**

## Setup

1. Drop the built jar in the server's `mods/` folder.
2. Point the mod at the shared config, which holds the bridge secret and address:

   ```json
   {
     "sharedConfig": "C:\\…\\AnathemaBridger\\config.json",
     "enabled": true
   }
   ```

   Save that as `config/anathema-bridge.json` in your server directory. It is the only
   thing the Minecraft end needs; everything else comes from the shared file.

   Alternatively set `ANATHEMA_CONFIG` to the shared config path in the server's
   launch script and leave this file alone.
3. Restart the server. On boot you should see:

   ```
   Loaded bridge settings from shared config C:\…\config.json.
   Connected to bridge.
   ```

If neither is configured, the mod logs an error and refuses to connect rather than
opening an unauthenticated socket.

## Behaviour

- **Minecraft → Discord/Valour**: every player chat line (commands excluded).
- **Discord/Valour → Minecraft**: broadcast to all players, with `§` codes and
  control characters stripped and lengths clamped.
- Reconnects with exponential backoff (5s doubling to 60s, jittered); the
  handshake times out after 15s rather than hanging.
- A 30s heartbeat detects half-open connections on both ends.
- Chat is dropped while disconnected, with one warning per outage.

## Build

```powershell
.\gradlew build
```

Output lands in `build/libs/`. Unit tests run as part of `build`, or alone with
`.\gradlew test`.
