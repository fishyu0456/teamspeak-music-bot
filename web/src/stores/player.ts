import { defineStore } from 'pinia';
import axios from 'axios';

export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: 'netease' | 'qq' | 'bilibili' | 'youtube';
}

export type Source = 'netease' | 'qq';

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: Song | null;
  queueSize: number;
  volume: number;
  playMode: string;
  elapsed?: number;
}

export interface PlaylistItem {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  platform: string;
}

interface TimingState {
  serverElapsed: number;
  serverSyncTime: number;
  wasPlaying: boolean;
}

const HOME_CACHE_TTL = 5 * 60 * 1000;

function defaultTiming(): TimingState {
  return { serverElapsed: 0, serverSyncTime: 0, wasPlaying: false };
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    bots: [] as BotStatus[],
    activeBotId: null as string | null,
    /** Per-bot queues keyed by botId */
    queues: {} as Record<string, Song[]>,
    /** Per-bot timing state keyed by botId */
    timings: {} as Record<string, TimingState>,
    theme: 'dark' as 'dark' | 'light',

    // Home page cache, split by source
    recommendPlaylists: { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[] },
    dailySongs:         { netease: [] as Song[],         qq: [] as Song[] },
    userPlaylists:      { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[] },
    bilibiliPopular: [] as Song[],
    authStatus: { netease: false, qq: false },
    lastFetchTime: 0,
  }),

  getters: {
    activeBot(): BotStatus | null {
      return this.bots.find((b) => b.id === this.activeBotId) ?? this.bots[0] ?? null;
    },
    currentSong(): Song | null {
      return this.activeBot?.currentSong ?? null;
    },
    isPlaying(): boolean {
      return this.activeBot?.playing ?? false;
    },
    isPaused(): boolean {
      return this.activeBot?.paused ?? false;
    },
    /** Queue for the currently active bot */
    queue(): Song[] {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId) return [];
      return this.queues[botId] ?? [];
    },
    /** Interpolated elapsed for the active bot */
    elapsed(): number {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId || !this.activeBot?.currentSong) return 0;
      const timing = this.timings[botId] ?? defaultTiming();
      const maxDuration = this.activeBot.currentSong.duration || Infinity;
      if (!timing.wasPlaying || timing.serverSyncTime === 0) return Math.min(timing.serverElapsed, maxDuration);
      if (this.isPaused) return Math.min(timing.serverElapsed, maxDuration);
      return Math.min(timing.serverElapsed + (Date.now() - timing.serverSyncTime) / 1000, maxDuration);
    },
  },

  actions: {
    _getTiming(botId: string): TimingState {
      if (!this.timings[botId]) {
        this.timings[botId] = defaultTiming();
      }
      return this.timings[botId];
    },

    _setTiming(botId: string, partial: Partial<TimingState>) {
      const current = this._getTiming(botId);
      this.timings[botId] = { ...current, ...partial };
    },

    getQueueForBot(botId: string): Song[] {
      return this.queues[botId] ?? [];
    },

    setActiveBotId(id: string) {
      this.activeBotId = id;
      // Fetch queue for newly active bot if we don't have it yet
      if (!this.queues[id]) {
        this.fetchQueue();
      }
    },

    updateBotStatus(botId: string, status: BotStatus) {
      const prev = this.bots.find((b) => b.id === botId);
      const prevSongId = prev?.currentSong?.id;

      const index = this.bots.findIndex((b) => b.id === botId);
      if (index >= 0) {
        this.bots[index] = status;
      } else {
        this.bots.push(status);
      }

      // Sync elapsed from server status — always per-bot
      if (status.elapsed !== undefined) {
        this._setTiming(botId, {
          serverElapsed: status.elapsed,
          serverSyncTime: Date.now(),
          wasPlaying: status.playing && !status.paused,
        });
      }

      // Song changed — reset timing for this bot
      if (status.currentSong?.id !== prevSongId) {
        this._setTiming(botId, {
          serverElapsed: status.elapsed ?? 0,
          serverSyncTime: Date.now(),
          wasPlaying: status.playing && !status.paused,
        });
      }
    },

    removeBotStatus(botId: string) {
      this.bots = this.bots.filter((b) => b.id !== botId);
      delete this.queues[botId];
      delete this.timings[botId];
    },

    setQueue(botId: string, queue: Song[]) {
      this.queues[botId] = queue;
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
    },

    loadTheme() {
      const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
      if (saved) this.theme = saved;
    },

    async startBotInstance(id: string) {
      await axios.post(`/api/bot/${id}/start`);
    },

    async stopBotInstance(id: string) {
      await axios.post(`/api/bot/${id}/stop`);
    },

    async fetchBots() {
      const res = await axios.get('/api/bot');
      this.bots = res.data.bots;
      if (!this.activeBotId && this.bots.length > 0) {
        this.activeBotId = this.bots[0].id;
      }
      // Sync elapsed from each bot's status
      for (const bot of this.bots) {
        if (bot.elapsed !== undefined) {
          this._setTiming(bot.id, {
            serverElapsed: bot.elapsed,
            serverSyncTime: Date.now(),
            wasPlaying: bot.playing && !bot.paused,
          });
        }
      }
    },

    /** Poll server for real elapsed time for active bot */
    async syncElapsed() {
      if (!this.activeBotId || !this.isPlaying) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/elapsed`);
        this._setTiming(this.activeBotId, {
          serverElapsed: res.data.elapsed,
          serverSyncTime: Date.now(),
          wasPlaying: true,
        });
      } catch {
        // ignore
      }
    },

    async fetchQueue() {
      if (!this.activeBotId) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/queue`);
        this.queues[this.activeBotId] = res.data.queue ?? [];
      } catch {
        // ignore
      }
    },

    async fetchQueueForBot(botId: string) {
      try {
        const res = await axios.get(`/api/player/${botId}/queue`);
        this.queues[botId] = res.data.queue ?? [];
      } catch {
        // ignore
      }
    },

    _syncAfterAction() {
      if (!this.activeBotId) return;
      this._setTiming(this.activeBotId, {
        serverSyncTime: Date.now(),
        wasPlaying: true,
      });
      // Sync from server after a short delay for accuracy
      setTimeout(() => this.syncElapsed(), 500);
    },

    async playAtIndex(index: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-at`, { index });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async play(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play`, { query, platform });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async playById(songId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-by-id`, { songId, platform });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async playSong(song: Song) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-song`, { song });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async addToQueue(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add`, { query, platform });
    },

    async addToQueueById(songId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add-by-id`, { songId, platform });
    },

    async addSong(song: Song) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add-song`, { song });
    },

    async playPlaylist(playlistId: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play-playlist`, { playlistId, platform });
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async pause() {
      if (!this.activeBotId) return;
      // Freeze elapsed at current interpolated value
      this._setTiming(this.activeBotId, {
        serverElapsed: this.elapsed,
        wasPlaying: false,
      });
      await axios.post(`/api/player/${this.activeBotId}/pause`);
    },

    async resume() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/resume`);
      this._setTiming(this.activeBotId, {
        serverSyncTime: Date.now(),
        wasPlaying: true,
      });
      setTimeout(() => this.syncElapsed(), 300);
    },

    async next() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/next`);
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async prev() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/prev`);
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },

    async stop() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/stop`);
      this._setTiming(this.activeBotId, {
        serverElapsed: 0,
        serverSyncTime: 0,
        wasPlaying: false,
      });
    },

    async seek(position: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/seek`, { position });
      this._setTiming(this.activeBotId, { serverElapsed: position });
      this._syncAfterAction();
    },

    async setVolume(volume: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/volume`, { volume });
    },

    async setMode(mode: string) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/mode`, { mode });
    },

    async fetchHomeData() {
      if (this.lastFetchTime > 0 && Date.now() - this.lastFetchTime < HOME_CACHE_TTL) {
        return;
      }

      // 1. Fetch auth status for both platforms first.
      const [neAuthRes, qqAuthRes] = await Promise.allSettled([
        axios.get('/api/auth/status', { params: { platform: 'netease' } }),
        axios.get('/api/auth/status', { params: { platform: 'qq' } }),
      ]);
      this.authStatus.netease =
        neAuthRes.status === 'fulfilled' && !!neAuthRes.value.data?.loggedIn;
      this.authStatus.qq =
        qqAuthRes.status === 'fulfilled' && !!qqAuthRes.value.data?.loggedIn;

      // 2. NetEase data: recommend playlists work anonymously; daily/user
      // playlists need login but Promise.allSettled isolates failures.
      const neteasePromises = [
        axios.get('/api/music/recommend/playlists', { params: { platform: 'netease' } }),
        axios.get('/api/music/recommend/songs',     { params: { platform: 'netease' } }),
        axios.get('/api/music/user/playlists',      { params: { platform: 'netease' } }),
      ];

      // 3. QQ data: only fetch when QQ is logged in. When not logged in,
      // resolve to empty payloads so the same indexed handling works.
      const emptyPlaylists = { data: { playlists: [] } };
      const emptySongs     = { data: { songs: [] } };
      const qqPromises = this.authStatus.qq
        ? [
            axios.get('/api/music/recommend/playlists', { params: { platform: 'qq' } }),
            axios.get('/api/music/recommend/songs',     { params: { platform: 'qq' } }),
            axios.get('/api/music/user/playlists',      { params: { platform: 'qq' } }),
          ]
        : [
            Promise.resolve(emptyPlaylists),
            Promise.resolve(emptySongs),
            Promise.resolve(emptyPlaylists),
          ];

      const biliPromise = axios.get('/api/music/bilibili/popular?limit=12');

      const results = await Promise.allSettled([
        ...neteasePromises,
        ...qqPromises,
        biliPromise,
      ]);

      const [neRecPL, neDaily, neUserPL, qqRecPL, qqDaily, qqUserPL, bili] = results;

      if (neRecPL.status === 'fulfilled') {
        this.recommendPlaylists.netease = neRecPL.value.data.playlists ?? [];
      }
      if (neDaily.status === 'fulfilled') {
        this.dailySongs.netease = neDaily.value.data.songs ?? [];
      }
      if (neUserPL.status === 'fulfilled') {
        this.userPlaylists.netease = neUserPL.value.data.playlists ?? [];
      }
      if (qqRecPL.status === 'fulfilled') {
        this.recommendPlaylists.qq = qqRecPL.value.data.playlists ?? [];
      }
      if (qqDaily.status === 'fulfilled') {
        this.dailySongs.qq = qqDaily.value.data.songs ?? [];
      }
      if (qqUserPL.status === 'fulfilled') {
        this.userPlaylists.qq = qqUserPL.value.data.playlists ?? [];
      }
      if (bili.status === 'fulfilled') {
        this.bilibiliPopular = bili.value.data.songs ?? [];
      }

      this.lastFetchTime = Date.now();
    },
  },
});
