# Motion rally architecture

Reviewed against the local working tree on 2026-11-07. Source paths below are relative to this repository.

## System context and data flow

A local Node HTTP/WebSocket server owns room membership and match physics. One court browser hosts a room and two phone browsers pair through a room code plus token. Phone orientation or touch messages become validated server inputs. Optional commentary uses a separately enabled Gemini adapter; the tests inject a transport and make no provider requests.

```mermaid
graph TD
    Court[Court browser public/host.js] <-->|WebSocket snapshots| Server[server/server.mjs]
    Phones[Phone browsers public/controller.js] -->|Pairing and motion or touch| Protocol[server/protocol.mjs]
    Protocol --> Server
    Server --> Rooms[Room map and pairing state]
    Rooms --> Match[server/game.mjs Match]
    Match -->|points and rally events| Rooms
    Rooms --> Commentary[server/commentary.mjs]
    Commentary -. explicit opt-in .-> Gemini[External TTS provider]
    Server --> Health[HTTP health and local static files]
    Match -->|authoritative snapshots| Server
```

## Main execution sequence

```mermaid
sequenceDiagram
    actor Host
    actor Phone
    participant Server
    participant Room
    participant Match
    Host->>Server: hello role host
    Server->>Room: allocate random code and token
    Server-->>Host: pairing token and room snapshot
    Phone->>Server: hello with room token and slot
    Server->>Server: validate origin, message and token
    Server->>Room: attach controller
    Phone->>Server: increasing sequence and timestamp, or touch
    Server->>Match: normalized input
    loop both controllers present
        Server->>Match: elapsed seconds
        Match->>Match: fixed 120 Hz simulation ticks
        Match-->>Room: point or rally events
        Room-->>Host: authoritative state and commentary text
        Room-->>Phone: state and presence
    end
    Host->>Server: disconnect
    Server->>Room: close controllers and remove room
```

## Modules and ownership

- `server/protocol.mjs` owns byte/range/schema checks, pairing message validation, names, random room codes, and calibrated motion normalization.
- `server/game.mjs` owns deterministic seeded serves, 120 Hz fixed-step physics, stale-input neutralization, scoring, and detached snapshots.
- `server/server.mjs` owns HTTP/static serving, upgrade origin checks, 32-room/64-connection limits, room tokens, connection lifecycle, input-rate limits, scheduling, and health stats.
- `server/commentary.mjs` owns explicit enablement, a request budget, single in-flight request, abort timeout, and audio extraction.
- `public/host.js` renders the court and pairing UI. `public/controller.js` manages phone permissions, calibration, transport, and touch fallback.
- `tools/load_test.mjs` and `tools/browser_qa.mjs` provide separate load and browser exercises.

## State and failure handling

The server stores rooms in a Map. Each room owns one Match and controller slots. The server is the score and ball authority. Tokens stay in room/connection memory and are excluded from health output. Motion sequence and timestamps must increase. The physics model accumulates elapsed time in 1/120 second steps and caps catch-up input at 0.25 seconds per call. Physics stops when either controller is absent. The adapter shares a request budget and busy flag across its callers. It clears busy state and the timeout in finally. No durable match storage exists.

## Reproduce the checks

```sh
npm test
npm start
```

The added tests cover in-flight commentary rejection, recovery after HTTP failure and timeout, and the real local HTTP HEAD/method boundary. Provider calls use an injected transport. Browser motion permissions, audio playback, and external provider delivery remain separate checks.
