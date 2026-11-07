# motion-rally performance and technical debt

Reviewed 2026-11-07. These are proposals, not applied production changes. Line numbers refer to the reviewed working tree. No runtime speedup is claimed without measurement.

## 1. Bound buffered outbound snapshots

Location: `server/server.mjs:47-51`.

Room broadcasts check socket readiness but not queued bytes. A slow receiver can accumulate snapshots and base64 audio. Apply the same policy to the top-level `send` at lines 244-248. The proposed 256 KiB threshold is a starting policy, not measured capacity. Dropping replaceable snapshots may be preferable to closing on brief congestion. Audio and control messages need an explicit priority policy.

Proposed change:

```diff
--- a/server/server.mjs
+++ b/server/server.mjs
@@ -1,4 +1,8 @@
     if (socket && socket.readyState === 1) {
+      if (socket.bufferedAmount > 256 * 1024) {
+        socket.close(1013, 'client is too slow');
+        return;
+      }
       socket.send(JSON.stringify(message));
       this.onSend?.();
     }
```

Validation: Use a deliberately stalled receiver and assert bounded memory and room cleanup. Confirm healthy controllers keep receiving recent snapshots and control messages.

## 2. Keep the Match input boundary as strict as the transport

Location: `server/game.mjs:82-83`.

`protocol.mjs` rejects non-integer sequences, but direct `Match.setInput` callers can supply NaN or omit seq. NaN passes the current comparison and can overwrite lastSeq with NaN, disabling later stale-sequence rejection. The exported model should declare whether it requires validated inputs. This proposal enforces the same safe-integer contract inside the model and may require updating direct callers that intentionally omit seq.

Proposed change:

```diff
--- a/server/game.mjs
+++ b/server/game.mjs
@@ -1 +1 @@
-    if (typeof seq === "number" && seq <= player.lastSeq) return false;
+    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= player.lastSeq) return false;
```

Validation: Test NaN, Infinity, omitted, fractional, negative, stale, and safe-integer sequences. Verify rejection leaves all player state unchanged and run existing transport tests.
