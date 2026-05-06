# Design: FM Bug Fix + Artist Loop + Playlist Fuzzy Search

Date: 2026-04-27

## Overview

Three features for the TeamSpeak Music Bot:
1. New `!artist <name>` command — loop playback filtered by artist
2. Fuzzy playlist name search in existing `!playlist` command
3. Fix `!fm` audio dropout bug (no sound after a few songs but status shows playing)

---

## Feature 1: `!artist` Command

### Behavior

`!artist <歌手名> [-q|-b|-y]` searches for songs by the artist, loads them into the queue, sets the queue mode to `Loop`, and starts playing.

### Flow

1. Parse command with optional platform flags (`-q`, `-b`, `-y`)
2. Call `provider.search(歌手名, 50)` to get up to 50 results
3. Filter results: only keep songs where `song.artist` contains the search query (case-insensitive)
4. If filtered list is empty, fall back to unfiltered search results (up to 20)
5. Clear current queue, add filtered songs, set mode to `Loop`
6. Play first song via `resolveAndPlay`

### Key Decisions

- **Why Loop mode?** The user said "循环播放" (loop playback). After the artist's songs are exhausted, they should restart.
- **Why filter client-side?** The search API doesn't support artist-only filtering. We search broadly then narrow down.
- **Why 50 results?** The default limit is 20, but for prolific artists we want more coverage. 50 balances API response size with coverage.

### Files Changed

- `src/bot/commands.ts`: Register `artist` in PUBLIC_COMMANDS, update help text
- `src/bot/instance.ts`: New `cmdArtist()` method

---

## Feature 2: Playlist Fuzzy Search

### Behavior

`!playlist <name or ID>` now accepts both playlist IDs and playlist names. When the input is not a pure numeric ID, it searches for matching playlists and uses the top result.

### Flow

1. Parse input — if it's a pure numeric ID or contains a URL with an ID, use existing logic
2. Otherwise, call `provider.search(input)` which already returns `playlists[]` in the result
3. Also call `provider.getUserPlaylists()` if the provider supports it (logged-in state)
4. Client-side fuzzy match user playlists: `playlist.name` contains input (case-insensitive)
5. Merge results: public search results first (sorted by API relevance), then user matches
6. Take the first playlist, load its songs, play

### Key Decisions

- **Why public search first?** It's already sorted by relevance from the API. User playlists are a secondary source.
- **Why client-side matching for user playlists?** The `getUserPlaylists()` API returns all user playlists without a search parameter, so we must filter locally.
- **Backward compatibility:** Numeric IDs and URL parsing are unchanged.

### Files Changed

- `src/bot/instance.ts`: Modify `cmdPlaylist()` to add search fallback
- `src/bot/commands.ts`: Update help text

---

## Feature 3: FM Bug Fix

### Root Cause Analysis

The `!fm` bug manifests as: audio stops after a few songs, but `!now` shows a playing song and the song name keeps changing.

`getPersonalFm()` returns only ~3 songs per API call. After those are consumed:
- In `Sequential` mode: `queue.next()` returns null → `player.stop()` is called → playback stops entirely. This does NOT match "歌还在轮播" (songs still rotating).
- In `Loop` mode (if user changed mode): the same 3 songs loop, but URLs may expire, causing silent playback failures.

The most likely scenario for "no audio but status shows playing + song names changing":
1. FM songs have URLs that resolve but don't produce playable audio (copyright/region restrictions)
2. ffmpeg spawns, connects to the URL, gets an HTTP error or silent stream
3. ffmpeg exits quickly (clean exit or error)
4. The frame loop detects ffmpeg gone + buffer empty → emits `trackEnd`
5. `playNext()` advances to the next song
6. This rapid cycle (spawn → fail → advance) makes it appear that songs are "playing and rotating" but with no audio
7. After 3 consecutive ffmpeg spawn failures, `consecutiveFailures >= MAX_CONSECUTIVE_FAILURES` → player refuses to spawn new ffmpeg processes
8. After that, `resolveAndPlay` still sets state via `player.play()` which immediately emits "error" → `playNext()` skips to next → cycle continues with no ffmpeg at all

### Fix Strategy

**Fix 1 — FM auto-refill (primary fix):**
- In `cmdFm()`, set queue mode to `RandomLoop` so the queue never "runs out"
- Add a `refillFm()` method that fetches more FM songs and appends to queue
- Hook into the `trackEnd` flow: when queue has ≤ 2 songs remaining and we're in FM mode, trigger a refill
- Track FM state with a boolean flag `isFmMode` on the instance

**Fix 2 — Reset consecutive failures on successful playback (safety net):**
- Reset `consecutiveFailures` when a track plays successfully for at least N frames (e.g., 50 frames = 1 second)
- This prevents transient URL failures from accumulating toward the hard limit

**Fix 3 — FM refill before queue exhaustion:**
- After `playNext()` successfully starts a song, check if `isFmMode` and `queue.size() - currentIndex <= 2`
- If so, fire an async refill (don't block playback)

### Files Changed

- `src/bot/instance.ts`: Modify `cmdFm()`, add `refillFm()`, add FM state tracking, modify `playNext()` to check for FM refill
- `src/audio/player.ts`: Add `framesPlayed` threshold check to reset `consecutiveFailures`

---

## Implementation Order

1. **FM bug fix** first — it's a bug fix affecting current users
2. **Playlist fuzzy search** — small change, quick win
3. **Artist loop** — new feature, depends on queue/player being stable

---

## Testing

- FM: Verify songs keep playing beyond the initial 3-song batch, verify auto-refill works
- Playlist: Test with numeric ID (backward compat), test with playlist name (fuzzy search)
- Artist: Test with known artist names, test edge case (no results), test with platform flags
