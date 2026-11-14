# ERYON Identity Server

Optional Fabric server mod for Minecraft Java 1.21.1. The client can identify
other launcher users on servers without this mod by using shared Eryon game
presence; install this server mod only when its server-side configuration and
controlled identity list are needed. Build the projects from the launcher
root with `npm run build:identity`; the server jar is written to
`build/eryon-identity-server-1.21.1.jar`. Put that jar and Fabric API in the
dedicated server's `mods` directory, then restart the server. The Eryon client
mod is separate and is installed automatically by Eryon Launcher for
supported 1.21.1 Fabric launches.

On each connection the Eryon client sends one versioned custom-payload
handshake. The server records only the player's UUID for that connection and
sends the current identity list to compatible clients. Duplicate handshakes
are ignored, payload versions are checked, and state updates are bounded.
This identifies compatible clients, not a trusted account: modified clients
can forge the packet. Never use Eryon Identity for authentication,
authorization, or gameplay advantages.

The server creates `config/eryon-identity.json` on first startup:

```json
{
  "enabled": true,
  "showTab": true,
  "showNametag": true,
  "identifyAllPlayers": false,
  "logoSize": "medium"
}
```

- `enabled`: globally enables or disables identity rendering.
- `showTab`: render the logo in the player list.
- `showNametag`: render the logo over player characters.
- `identifyAllPlayers`: `false` marks only clients that completed the Eryon
  handshake; `true` marks every online player for clients that support Eryon.
- `logoSize`: `small`, `medium`, or `large`.

After editing the file, run `/eryonidentity reload` as an operator. Clients
without the Eryon mod receive no custom payload and are not disconnected.

Compile both client and server jars from the launcher root with
`npm run build:identity`. The client jar is also written to
`build/eryon-identity-client-1.21.1.jar`. A JDK 21 or newer is required (for
example, `winget install EclipseAdoptium.Temurin.21.JDK` on Windows). The
launcher automatically installs this client jar when launching Minecraft
1.21.1 with Vanilla or Fabric; no manual client mod installation is needed.

Vanilla clients cannot render the custom logo from this mod alone. The server
mod deliberately does not force a resource pack; making the glyph available
to unmodded clients would require distributing and accepting a server resource
pack.
