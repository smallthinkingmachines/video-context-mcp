import { describe, expect, it } from 'vitest';
import { collapseBursts, filterByGap, parseShowinfo } from '../src/pipeline/frames.js';

const SHOWINFO_STDERR = `
[Parsed_showinfo_2 @ 0x600002] n:   0 pts:  12345 pts_time:1.234   duration:512 duration_time:0.0426667 fmt:yuvj420p cl:left sar:1/1 s:1280x720 i:P iskey:1 type:I checksum:ABC plane_checksum:[X Y Z] mean:[113 126 130] stdev:[52.5 5.2 6.1]
[Parsed_showinfo_2 @ 0x600002] n:   1 pts:  98765 pts_time:9.876   duration:512 duration_time:0.0426667 fmt:yuvj420p cl:left sar:1/1 s:1280x720 i:P iskey:0 type:P checksum:DEF plane_checksum:[X Y Z] mean:[113 126 130] stdev:[52.5 5.2 6.1]
[Parsed_showinfo_2 @ 0x600002] n:   2 pts: 250000 pts_time:25.0   duration:512 duration_time:0.0426667 fmt:yuvj420p cl:left sar:1/1 s:1280x720 i:P iskey:0 type:P checksum:GHI plane_checksum:[X Y Z] mean:[113 126 130] stdev:[52.5 5.2 6.1]
frame=    3 fps=0.0 q=4.0 Lsize=N/A time=00:00:25.00 bitrate=N/A speed= 50x
`;

describe('parseShowinfo', () => {
  it('extracts frame index, timestamp, and scaled dimensions', () => {
    const frames = parseShowinfo(SHOWINFO_STDERR);
    expect(frames).toEqual([
      { index: 0, tsMs: 1234, width: 1280, height: 720 },
      { index: 1, tsMs: 9876, width: 1280, height: 720 },
      { index: 2, tsMs: 25000, width: 1280, height: 720 },
    ]);
  });

  it('returns empty on unrelated stderr', () => {
    expect(parseShowinfo('ffmpeg version 8.0 ...\nOutput file is empty')).toEqual([]);
  });
});

describe('filterByGap', () => {
  const mk = (...ts: number[]) => ts.map((tsMs) => ({ tsMs }));

  it('drops frames closer than the minimum gap', () => {
    const kept = filterByGap(mk(0, 3000, 11000, 15000, 30000), 10_000, 100);
    expect(kept.map((f) => f.tsMs)).toEqual([0, 11000, 30000]);
  });

  it('enforces the total cap', () => {
    const frames = mk(...Array.from({ length: 50 }, (_, i) => i * 20_000));
    expect(filterByGap(frames, 10_000, 5)).toHaveLength(5);
  });

  it('keeps everything when gaps are large', () => {
    expect(filterByGap(mk(0, 60_000, 120_000), 10_000, 100)).toHaveLength(3);
  });
});

describe('collapseBursts', () => {
  const mk = (...ts: number[]) => ts.map((tsMs) => ({ tsMs }));
  const times = (frames: { tsMs: number }[]) => frames.map((f) => f.tsMs);

  it('keeps isolated frames untouched', () => {
    expect(times(collapseBursts(mk(0, 5000, 20_000), 1000, 5000))).toEqual([0, 5000, 20_000]);
  });

  it('keeps only the last frame of a burst', () => {
    const frames = mk(1000, 1100, 1200, 1300, 9000);
    expect(times(collapseBursts(frames, 1000, 5000))).toEqual([1300, 9000]);
  });

  it('bridges small gaps inside a burst', () => {
    expect(times(collapseBursts(mk(0, 800, 1600, 2400), 1000, 5000))).toEqual([2400]);
  });

  it('cuts a long burst so continuous motion still yields frames', () => {
    const frames = mk(...Array.from({ length: 13 }, (_, i) => i * 500));
    expect(times(collapseBursts(frames, 1000, 2000))).toEqual([2000, 4500, 6000]);
  });

  it('handles empty input and preserves extra fields', () => {
    expect(collapseBursts([], 1000, 5000)).toEqual([]);
    const frames = [
      { tsMs: 0, path: 'a' },
      { tsMs: 100, path: 'b' },
    ];
    expect(collapseBursts(frames, 1000, 5000)).toEqual([{ tsMs: 100, path: 'b' }]);
  });
});
