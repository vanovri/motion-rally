# motion-rally performance and technical debt

Reviewed 2026-11-08. These are proposals, not applied production changes. Line numbers refer to the reviewed working tree. No runtime speedup is claimed without measurement.

## 1. Bound buffered outbound snapshots

Location: `server/server.mjs:45-51,244-249`.

Room broadcasts check socket readiness but not queued bytes. A slow receiver can accumulate snapshots and base64 audio. The proposal applies the same policy to the top-level `send` at lines 244-248. The proposed 256 KiB threshold is a starting policy, not measured capacity. Dropping replaceable snapshots may be preferable to closing on brief congestion. Audio and control messages need an explicit priority policy.

Proposed change:

```diff
diff --git a/server/server.mjs b/server/server.mjs
--- a/server/server.mjs
+++ b/server/server.mjs
@@ -45,6 +45,10 @@
   send(connection, message) {
     const socket = connection?.socket ?? connection;
     if (socket && socket.readyState === 1) {
+      if (socket.bufferedAmount > 256 * 1024) {
+        socket.close(1013, 'client is too slow');
+        return;
+      }
       socket.send(JSON.stringify(message));
       this.onSend?.();
     }
@@ -243,6 +247,10 @@
 
   function send(connection, message) {
     if (connection?.socket?.readyState === 1) {
+      if (connection.socket.bufferedAmount > 256 * 1024) {
+        connection.socket.close(1013, 'client is too slow');
+        return;
+      }
       connection.socket.send(JSON.stringify(message));
       stats.messagesOut += 1;
     }
```

Validation: Use a deliberately stalled receiver and assert bounded memory and room cleanup. Confirm healthy controllers keep receiving recent snapshots and control messages.

## 2. Keep the Match input boundary as strict as the transport

Location: `server/game.mjs:82-83`.

`protocol.mjs` rejects non-integer sequences, but direct `Match.setInput` callers can supply NaN or omit seq. NaN passes the current comparison and can overwrite lastSeq with NaN, disabling later stale-sequence rejection. The exported model should declare whether it requires validated inputs. This proposal enforces the same safe-integer contract inside the model and may require updating direct callers that intentionally omit seq.

Proposed change:

```diff
diff --git a/server/game.mjs b/server/game.mjs
--- a/server/game.mjs
+++ b/server/game.mjs
@@ -79,7 +79,7 @@
     if (!player) return false;
     if (!Number.isFinite(x) || !Number.isFinite(swing)) return false;
     if (!Number.isFinite(timestamp)) return false;
-    if (typeof seq === "number" && seq <= player.lastSeq) return false;
+    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= player.lastSeq) return false;
     player.x = Math.max(-1, Math.min(1, x));
     player.swing = Math.max(0, Math.min(1, swing));
     player.inputAt = this.time;
```

Validation: Test NaN, Infinity, omitted, fractional, negative, stale, and safe-integer sequences. Verify rejection leaves all player state unchanged and run existing transport tests.
