# Exposing the bridge with Tailscale Funnel

The mod dials **out** from the Minecraft host, so nothing needs to be opened on the
game server. Tailscale Funnel publishes the bridge's WebSocket on a public `wss://`
URL with a certificate you don't have to manage.

A hosted Minecraft server cannot join your tailnet (you cannot install a VPN client
on it), so tailnet-only access is not an option — Funnel is what makes it reachable.

## 1. Install and sign in

Install Tailscale on the machine that runs the bridge, then:

```powershell
tailscale up
```

Note the machine name it reports; it becomes the public hostname.

## 2. Enable HTTPS and Funnel (once, in the admin console)

- **DNS** → enable HTTPS certificates.
- **Access controls** → allow the `funnel` node attribute for this machine:

```jsonc
"nodeAttrs": [
  { "target": ["autogroup:member"], "attr": ["funnel"] }
]
```

## 3. Start the bridge, then expose it

```powershell
.\anathema-bridge-node\run-bridge.cmd
tailscale funnel --bg 3000
```

Funnel prints something like `https://my-pc.tail1234.ts.net/`. The bridge keeps
listening on `127.0.0.1:3000`; Tailscale terminates TLS in front of it, so no
certificate work is needed locally.

Useful commands:

```powershell
tailscale funnel status
tailscale funnel reset      # stop exposing
```

## 4. Point the mod at it

In `fabric-server-launcher.properties` on the hosted server:

```properties
anathema.bridge.url=wss://my-pc.tail1234.ts.net/minecraft
anathema.bridge.secret=<the bridge.secret value from config.json>
```

The WebSocket path matters: the bridge serves `/minecraft`, and Funnel preserves it.

## 5. Verify

From any other machine:

```powershell
curl.exe -i https://my-pc.tail1234.ts.net/minecraft
```

A `401` (or a WebSocket-upgrade complaint) means TLS and routing work and the secret
gate is doing its job. Then start the Minecraft server and look for
`Connected to bridge.` in its log.

## Things to know

- **The endpoint is public.** The 64-character secret is the only gate, so treat it
  as a credential: rotate it if it leaks, and don't reuse it. Everything travels over
  TLS, so it is not readable in transit.
- **Uptime follows this machine.** If it sleeps, chat stops; the mod retries with
  exponential backoff and recovers on its own when the machine returns.
- Local ports `3001` and `3002` stay loopback-only and are never exposed.
- Funnel's public port is 443 by default; ports 8443 and 10000 are also allowed if
  443 is ever unavailable.
