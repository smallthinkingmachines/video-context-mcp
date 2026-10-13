import { describe, expect, it } from 'vitest';
import { classifyYtdlpFailure } from '../src/errors.js';

describe('classifyYtdlpFailure', () => {
  it('maps the bot check to NEEDS_COOKIES with actionable guidance', () => {
    const err = classifyYtdlpFailure(
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
      false,
    );
    expect(err.code).toBe('NEEDS_COOKIES');
    expect(err.message).toContain('YTDLP_COOKIES_FILE');
  });

  it('notes when configured cookies were rejected', () => {
    const err = classifyYtdlpFailure("Sign in to confirm you're not a bot", true);
    expect(err.message).toContain('re-export fresh cookies');
  });

  it('maps private videos', () => {
    expect(classifyYtdlpFailure('ERROR: Private video. Sign in if...', false).code).toBe(
      'PRIVATE_VIDEO',
    );
  });

  it('maps unavailable videos', () => {
    expect(classifyYtdlpFailure('ERROR: Video unavailable', false).code).toBe('VIDEO_UNAVAILABLE');
  });

  it('maps age restriction', () => {
    expect(
      classifyYtdlpFailure('ERROR: Sign in to confirm your age. This video may be...', false).code,
    ).toBe('AGE_RESTRICTED');
  });

  it('maps missing binary via spawn ENOENT', () => {
    const spawnErr = Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
    const err = classifyYtdlpFailure('', false, spawnErr);
    expect(err.code).toBe('BINARY_MISSING');
    expect(err.message).toContain('VCM_YTDLP_BIN');
  });

  it('explains HTTP 403 media failures as an outdated yt-dlp, not a network error', () => {
    const err = classifyYtdlpFailure(
      'ERROR: unable to download video data: HTTP Error 403: Forbidden',
      false,
    );
    expect(err.code).toBe('YTDLP_FAILED');
    expect(err.message).toContain('HTTP 403');
    expect(err.message).toContain('VCM_YTDLP_BIN');
  });

  it('still maps connectivity failures to NETWORK', () => {
    expect(
      classifyYtdlpFailure('ERROR: unable to download webpage: getaddrinfo failed', false).code,
    ).toBe('NETWORK');
  });

  it('falls back to YTDLP_FAILED without exposing raw stderr', () => {
    const err = classifyYtdlpFailure(`line1\nline2\n${'x'.repeat(2000)}`, false);
    expect(err.code).toBe('YTDLP_FAILED');
    expect(err.message.length).toBeLessThan(600);
    expect(err.message).not.toContain('line2');
    expect(err.message).not.toContain('xxx');
  });
});
