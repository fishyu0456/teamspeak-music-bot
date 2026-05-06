# FM Bug Fix + Artist Loop + Playlist Fuzzy Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix FM audio dropout bug, add `!artist` command for artist-based loop playback, and support playlist name fuzzy search in `!playlist`.

**Architecture:** All changes stay within existing files. The FM fix adds auto-refill logic and a success-tracking mechanism in the player. Playlist search reuses the existing `provider.search()` API that already returns playlists. The `!artist` command is a new command method following the same pattern as `cmdPlay`/`cmdFm`.

**Tech Stack:** TypeScript, Node.js, ffmpeg-static, @honeybbq/teamspeak-client

---

## File Map

| File | Change | Purpose |
|------|--------|---------|
| `src/bot/instance.ts` | Modify | Add `isFmMode`, `refillFm()`, fix `cmdFm()`, modify `cmdPlaylist()`, add `cmdArtist()`, modify `playNext()` to trigger FM refill |
| `src/bot/commands.ts` | Modify | Register `artist` in PUBLIC_COMMANDS, update help text |
| `src/audio/player.ts` | Modify | Track healthy frame count, reset `consecutiveFailures` after sustained successful playback |

---

### Task 1: Fix FM — Track healthy playback in AudioPlayer

**Files:**
- Modify: `src/audio/player.ts:62-82` (add field)
- Modify: `src/audio/player.ts:243-261` (sendNextFrame — track healthy frames)

- [ ] **Step 1: Add healthy frame counter field**

In `src/audio/player.ts`, after the `consecutiveFailures` field (line ~80), add:

```typescript
private healthyFrames = 0;
private static readonly HEALTHY_FRAME_RESET = 50; // ~1 second of audio
```

- [ ] **Step 2: Track healthy frames and reset failures in sendNextFrame**

In `src/audio/player.ts`, in the `sendNextFrame()` method, after line 257 (`this.framesPlayed++;`), add:

```typescript
this.healthyFrames++;
if (this.healthyFrames >= AudioPlayer.HEALTHY_FRAME_RESET) {
  this.consecutiveFailures = 0;
  this.healthyFrames = 0;
}
```

- [ ] **Step 3: Reset healthyFrames in play() and stop()**

In `play()`, after `this.framesPlayed = 0;` (line ~95), add:

```typescript
this.healthyFrames = 0;
```

In `stop()`, after `this.framesPlayed = 0;` (line ~181), add:

```typescript
this.healthyFrames = 0;
```

- [ ] **Step 4: Commit**

```bash
git add src/audio/player.ts
git commit -m "fix(player): reset consecutiveFailures after sustained healthy playback"
```

---

### Task 2: Fix FM — Add auto-refill logic in BotInstance

**Files:**
- Modify: `src/bot/instance.ts:62-66` (add fields)
- Modify: `src/bot/instance.ts:557-573` (cmdFm)
- Modify: `src/bot/instance.ts:642-673` (playNext — add refill trigger)

- [ ] **Step 1: Add isFmMode field**

In `src/bot/instance.ts`, after `private profileManager: BotProfileManager;` (line ~66), add:

```typescript
private isFmMode = false;
```

- [ ] **Step 2: Add refillFm method**

In `src/bot/instance.ts`, before the `cmdVote` method (after `cmdFm`'s closing brace), add:

```typescript
private async refillFm(): Promise<void> {
  if (!this.isFmMode || !this.neteaseProvider.getPersonalFm) return;
  try {
    const songs = await this.neteaseProvider.getPersonalFm();
    if (songs.length === 0) return;
    for (const song of songs) {
      this.queue.add({ ...song, platform: "netease" });
    }
    this.logger.debug({ count: songs.length }, "FM queue refilled");
  } catch (err) {
    this.logger.error({ err }, "Failed to refill FM queue");
  }
}
```

- [ ] **Step 3: Modify cmdFm to set isFmMode and use RandomLoop**

Replace the existing `cmdFm` method (lines 557-573) with:

```typescript
private async cmdFm(): Promise<string> {
  if (!this.neteaseProvider.getPersonalFm) {
    return "Personal FM is only available for NetEase Cloud Music";
  }
  const songs = await this.neteaseProvider.getPersonalFm();
  if (songs.length === 0)
    return "No FM songs available (need to login first)";

  this.queue.clear();
  for (const song of songs) {
    this.queue.add({ ...song, platform: "netease" });
  }
  this.queue.setMode(PlayMode.RandomLoop);
  this.isFmMode = true;
  this.player.resetFailures();

  const first = this.queue.play();
  if (first) await this.resolveAndPlay(first);
  this.emit("stateChange");
  return `Personal FM started: ${first?.name ?? "unknown"} - ${first?.artist ?? ""}`;
}
```

- [ ] **Step 4: Modify playNext to trigger FM refill and check isFmMode**

In `playNext()`, replace the `else` branch (lines 665-668) that handles `queue.next() === null`:

```typescript
} else {
  // FM mode: try to refill instead of stopping
  if (this.isFmMode) {
    await this.refillFm();
    const refillNext = this.queue.next();
    if (refillNext) {
      const started = await this.resolveAndPlay(refillNext);
      if (!started) {
        this.player.stop();
        this.profileManager.onSongChange(null).catch(() => {});
      }
      this.emit("stateChange");
    } else {
      this.player.stop();
      this.profileManager.onSongChange(null).catch(() => {});
    }
  } else {
    this.player.stop();
    this.profileManager.onSongChange(null).catch(() => {});
  }
}
```

Also add a proactive refill after successful advance. At the end of the `if (next)` block, after `this.emit("stateChange");` is handled outside the if/else, add this right after `resolveAndPlay` succeeds (inside the `if (next)` block, after the retry loop):

After the `if (!started)` block and before the closing `}` of `if (next)`, insert:

```typescript
// Proactive FM refill when running low
if (this.isFmMode && this.queue.size() - (this.queue.getCurrentIndex()) <= 3) {
  this.refillFm().catch(err => this.logger.error({ err }, "Proactive FM refill failed"));
}
```

Wait — `this.emit("stateChange")` is outside the `if (next)` block. Let me re-read the original code structure...

The original `playNext()` structure is:
```
if (next) {
    let started = await resolveAndPlay(next)
    if (!started) { retry loop... }
    if (!started) { stop }
} else {
    stop
}
emit("stateChange")
```

So I need to add the proactive refill inside the `if (next)` block, right after `resolveAndPlay` succeeds. Let me write this more carefully:

```typescript
private async playNext(): Promise<void> {
    if (this.isAdvancing || !this.connected) return;
    this.isAdvancing = true;
    try {
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      if (next) {
        let started = await this.resolveAndPlay(next);
        if (!started) {
          for (let i = 0; i < 3 && this.connected; i++) {
            const retry = this.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        } else if (this.isFmMode && this.queue.size() - this.queue.getCurrentIndex() <= 3) {
          // Proactive refill: when queue is running low, fetch more FM songs
          this.refillFm().catch(err => this.logger.error({ err }, "Proactive FM refill failed"));
        }
      } else {
        // Queue exhausted — in FM mode, refill instead of stopping
        if (this.isFmMode) {
          await this.refillFm();
          const refillNext = this.queue.next();
          if (refillNext) {
            await this.resolveAndPlay(refillNext);
          } else {
            this.player.stop();
            this.profileManager.onSongChange(null).catch(() => {});
          }
        } else {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        }
      }
      this.emit("stateChange");
    } finally {
      this.isAdvancing = false;
    }
  }
```

OK this is getting complex. Let me simplify the plan — I'll structure it more clearly.

Also I need to clear `isFmMode` when user issues stop/clear or manually plays something else.

- [ ] **Step 5: Clear isFmMode in stop/clear/play commands**

In `cmdStop()`, after `this.queue.clear();`, add:

```typescript
this.isFmMode = false;
```

In `cmdClear()` (same line), add:

```typescript
this.isFmMode = false;
```

In `cmdPlay()`, after `this.queue.clear();`, add:

```typescript
this.isFmMode = false;
```

In `cmdPlaylist()`, after `this.queue.clear();`, add:

```typescript
this.isFmMode = false;
```

In `cmdAlbum()`, after `this.queue.clear();`, add:

```typescript
this.isFmMode = false;
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/instance.ts
git commit -m "fix: FM auto-refill to prevent audio dropout after initial batch"
```

---

### Task 3: Playlist Fuzzy Search

**Files:**
- Modify: `src/bot/instance.ts:524-539` (cmdPlaylist)

- [ ] **Step 1: Modify cmdPlaylist to support name search**

Replace the `cmdPlaylist` method (lines 524-539) with:

```typescript
private async cmdPlaylist(cmd: ParsedCommand): Promise<string> {
  if (!cmd.args) return "Usage: !playlist <playlist name or ID>";
  const provider = this.getProvider(cmd.flags);

  // Determine if input is a numeric ID or a name search
  const id = this.extractId(cmd.args);
  const isNumericId = /^\d+$/.test(cmd.args.trim());

  let playlistId: string;

  if (isNumericId || id !== cmd.args) {
    // Input is a numeric ID or URL containing an ID — use existing logic
    playlistId = id;
  } else {
    // Name-based search
    const result = await provider.search(cmd.args);
    let playlists = result.playlists ?? [];

    // Also search user's personal playlists if logged in
    if (provider.getUserPlaylists) {
      try {
        const userPlaylists = await provider.getUserPlaylists();
        const query = cmd.args.toLowerCase();
        const matched = userPlaylists.filter(
          p => p.name.toLowerCase().includes(query)
        );
        // Merge: public results first (API-ranked), then user matches
        playlists = [...playlists, ...matched];
      } catch {
        // User playlists unavailable — continue with public results
      }
    }

    if (playlists.length === 0)
      return `No playlists found for: ${cmd.args}`;
    playlistId = playlists[0].id;
  }

  const songs = await provider.getPlaylistSongs(playlistId);
  if (songs.length === 0) return "Playlist is empty or not found";

  this.queue.clear();
  this.isFmMode = false;
  for (const song of songs) {
    this.queue.add({ ...song, platform: provider.platform });
  }
  const first = this.queue.play();
  if (first) await this.resolveAndPlay(first);
  this.emit("stateChange");
  return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
}
```

- [ ] **Step 2: Update help text to reflect new usage**

In `cmdHelp()` (line ~633), change the playlist line from:

```
`${p}playlist <id> — Load playlist`
```

to:

```
`${p}playlist <name or id> — Load playlist by name or ID`
```

- [ ] **Step 3: Commit**

```bash
git add src/bot/instance.ts
git commit -m "feat: support playlist name fuzzy search in !playlist command"
```

---

### Task 4: Artist Loop Command

**Files:**
- Modify: `src/bot/commands.ts:8-11` (PUBLIC_COMMANDS)
- Modify: `src/bot/commands.ts:248-260` (AUDIO_COMMANDS in instance.ts — actually in instance.ts)
- Modify: `src/bot/instance.ts:244-314` (executeCommand switch + add cmdArtist)

Wait, AUDIO_COMMANDS is in instance.ts executeCommand. Let me check...

Actually looking back at instance.ts, the AUDIO_COMMANDS set is local to executeCommand. I don't need to add artist there since it will be handled in the switch.

- [ ] **Step 1: Register `artist` in PUBLIC_COMMANDS**

In `src/bot/commands.ts`, line 9, add `"artist"` to the PUBLIC_COMMANDS set:

```typescript
export const PUBLIC_COMMANDS = new Set([
  "play", "add", "queue", "list", "now", "lyrics", "vote", "help",
  "playlist", "album", "fm", "prev", "next", "skip", "pause", "resume",
  "artist",
]);
```

- [ ] **Step 2: Add `artist` to the AUDIO_COMMANDS set in executeCommand**

In `src/bot/instance.ts`, in the `executeCommand` method, add `"artist"` to the AUDIO_COMMANDS set (line ~253):

```typescript
const AUDIO_COMMANDS = new Set([
  "play", "add", "next", "skip", "prev", "playlist", "album", "fm",
  "artist",
]);
```

- [ ] **Step 3: Add `artist` case to the switch in executeCommand**

In `src/bot/instance.ts`, after the `case "fm":` block (line ~300), add:

```typescript
case "artist":
  return this.cmdArtist(cmd);
```

- [ ] **Step 4: Implement cmdArtist method**

Add the `cmdArtist` method in `src/bot/instance.ts`, after `cmdFm()`:

```typescript
private async cmdArtist(cmd: ParsedCommand): Promise<string> {
  if (!cmd.args) return "Usage: !artist <artist name>";
  const provider = this.getProvider(cmd.flags);
  const result = await provider.search(cmd.args, 50);
  if (result.songs.length === 0)
    return `No results found for artist: ${cmd.args}`;

  const query = cmd.args.toLowerCase();
  let filtered = result.songs.filter(
    s => s.artist.toLowerCase().includes(query)
  );

  // Fallback to unfiltered results if filtering drops everything
  if (filtered.length === 0) {
    filtered = result.songs.slice(0, 20);
  }

  this.queue.clear();
  this.isFmMode = false;
  for (const song of filtered) {
    this.queue.add({ ...song, platform: provider.platform });
  }
  this.queue.setMode(PlayMode.Loop);
  this.player.resetFailures();

  const first = this.queue.play();
  if (first) await this.resolveAndPlay(first);
  this.emit("stateChange");
  return `Artist mode: ${cmd.args} — ${filtered.length} songs loaded. Now playing: ${first?.name ?? "unknown"}`;
}
```

- [ ] **Step 5: Update help text**

In `cmdHelp()`, add the artist help line after the fm line:

```
`${p}artist <name> — Play songs by artist (loop)`
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands.ts src/bot/instance.ts
git commit -m "feat: add !artist command for artist-based loop playback"
```

---

### Task 5: Type-check and verify

**Files:**
- All modified files

- [ ] **Step 1: Run type check**

```bash
cd /home/proxxy/project/teamspeak-music-bot && npm run typecheck
```

Expected: No errors.

- [ ] **Step 2: Verify command parsing**

```bash
cd /home/proxxy/project/teamspeak-music-bot && node --loader ts-node/esm -e "
const { parseCommand } = await import('./src/bot/commands.ts');
console.log(parseCommand('!artist 周杰伦', '!'));
console.log(parseCommand('!artist 周杰伦 -q', '!'));
console.log(parseCommand('!playlist 华语经典', '!'));
console.log(parseCommand('!playlist 123456', '!'));
"
```

Expected: All parse correctly; `artist` with args "周杰伦", `playlist` with args "华语经典" and "123456".

- [ ] **Step 3: Commit any fixes from type check**

```bash
git add -A && git commit -m "chore: type fixes from final verification"
```
(Only if there were issues)

---

### Self-Review Checklist

1. **Spec coverage:**
   - FM bug fix → Tasks 1, 2 (healthy frame tracking + auto-refill)
   - Playlist fuzzy search → Task 3
   - Artist loop → Task 4
   - Verification → Task 5

2. **No placeholders** — all steps have exact code.

3. **Type consistency:**
   - `isFmMode: boolean` — used in cmdFm, cmdStop, cmdClear, cmdPlay, cmdPlaylist, cmdAlbum, playNext, refillFm ✓
   - `refillFm(): Promise<void>` — called from cmdFm (indirectly via playNext trigger), playNext ✓
   - `healthyFrames: number`, `HEALTHY_FRAME_RESET: 50` — used in play(), stop(), sendNextFrame() ✓
