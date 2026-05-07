import { describe, it, expect } from "vitest";
import { parseLyrics, mapNeteaseAlbums } from "./netease.js";

describe("NetEase adapter", () => {
  it("parses LRC format lyrics", () => {
    const lrc = `[00:00.00] 作词 : 周杰伦
[00:01.00] 作曲 : 周杰伦
[00:12.50]故事的小黄花
[00:15.80]从出生那年就飘着`;

    const lines = parseLyrics(lrc);
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toBeCloseTo(12.5, 1);
    expect(lines[0].text).toBe("故事的小黄花");
    expect(lines[1].time).toBeCloseTo(15.8, 1);
    expect(lines[1].text).toBe("从出生那年就飘着");
  });

  it("handles empty lyrics", () => {
    const lines = parseLyrics("");
    expect(lines).toHaveLength(0);
  });

  it("merges translation lyrics", () => {
    const lrc = "[00:12.50]Hello world";
    const tlyric = "[00:12.50]你好世界";
    const lines = parseLyrics(lrc, tlyric);
    expect(lines[0].text).toBe("Hello world");
    expect(lines[0].translation).toBe("你好世界");
  });

  it("mapNeteaseAlbums maps raw cloudsearch albums to Album shape", () => {
    const raw = [
      {
        id: 42,
        name: "Album A",
        picUrl: "https://x/p.jpg",
        artists: [{ name: "Artist X" }, { name: "Featured Y" }],
        size: 12,
      },
      {
        id: 99,
        name: "Album B",
        picUrl: "",
        artists: [],
      },
    ];
    expect(mapNeteaseAlbums(raw)).toEqual([
      { id: "42", name: "Album A", artist: "Artist X / Featured Y", coverUrl: "https://x/p.jpg", songCount: 12, platform: "netease" },
      { id: "99", name: "Album B", artist: "", coverUrl: "", songCount: 0, platform: "netease" },
    ]);
  });

  it("mapNeteaseAlbums returns [] for empty/null input", () => {
    expect(mapNeteaseAlbums([])).toEqual([]);
    expect(mapNeteaseAlbums(null as any)).toEqual([]);
    expect(mapNeteaseAlbums(undefined as any)).toEqual([]);
  });
});
