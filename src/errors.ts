/**
 * Typed error taxonomy. Every error surfaced to the MCP client carries an
 * actionable, agent-facing message — never a raw stack trace or stderr dump.
 */

export type ErrorCode =
  | 'NEEDS_COOKIES'
  | 'PRIVATE_VIDEO'
  | 'VIDEO_UNAVAILABLE'
  | 'AGE_RESTRICTED'
  | 'MEMBERS_ONLY'
  | 'GEO_BLOCKED'
  | 'LIVE_NOT_SUPPORTED'
  | 'NO_CAPTIONS'
  | 'UNSUPPORTED_URL'
  | 'FILE_NOT_FOUND'
  | 'NOT_INGESTED'
  | 'STAGE_NOT_READY'
  | 'BINARY_MISSING'
  | 'TOOLCHAIN_UNSUPPORTED'
  | 'TOOLCHAIN_DOWNLOAD_FAILED'
  | 'TOOLCHAIN_INTEGRITY_FAILED'
  | 'TOOLCHAIN_UNUSABLE'
  | 'INSUFFICIENT_DISK'
  | 'CACHE_WRITE_FAILED'
  | 'INGEST_INTERRUPTED'
  | 'NETWORK'
  | 'VISUAL_FAILED'
  | 'ASR_FAILED'
  | 'EMBED_FAILED'
  | 'YTDLP_FAILED';

export class VcmError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VcmError';
  }
}

const COOKIES_HINT =
  'Set YTDLP_COOKIES_FILE to a Netscape-format cookies file exported from a logged-in ' +
  'browser session (e.g. via a "Get cookies.txt" extension), then re-run ingest_video with force=true.';

interface Rule {
  pattern: RegExp;
  code: ErrorCode;
  message: (cookiesConfigured: boolean) => string;
}

const YTDLP_RULES: Rule[] = [
  {
    pattern: /sign in to confirm you.{0,3}re not a bot/i,
    code: 'NEEDS_COOKIES',
    message: (c) =>
      `YouTube triggered its bot check. ${
        c ? 'The configured cookies file was not accepted — re-export fresh cookies. ' : ''
      }${COOKIES_HINT}`,
  },
  {
    pattern: /private video|this video is private/i,
    code: 'PRIVATE_VIDEO',
    message: () => `This video is private and requires an authorized account. ${COOKIES_HINT}`,
  },
  {
    pattern: /members-only|available to this channel's members/i,
    code: 'MEMBERS_ONLY',
    message: () => `This video is members-only. ${COOKIES_HINT}`,
  },
  {
    pattern: /age.restricted|confirm your age|inappropriate for some users/i,
    code: 'AGE_RESTRICTED',
    message: () => `This video is age-restricted. ${COOKIES_HINT}`,
  },
  {
    pattern: /not available in your country|geo.?restricted|blocked in your/i,
    code: 'GEO_BLOCKED',
    message: () => 'This video is geo-blocked in the current region.',
  },
  {
    pattern: /video unavailable|has been removed|no longer available|account.+terminated/i,
    code: 'VIDEO_UNAVAILABLE',
    message: () => 'The video is unavailable (removed, taken down, or the ID is wrong).',
  },
  {
    pattern: /this live event|live stream recording is not available|is a live/i,
    code: 'LIVE_NOT_SUPPORTED',
    message: () => 'Live streams are not supported; wait until the VOD is processed by YouTube.',
  },
  {
    pattern: /HTTP Error 403|403: Forbidden/i,
    code: 'YTDLP_FAILED',
    message: () =>
      'YouTube refused the media download (HTTP 403). The managed yt-dlp is probably out of date: update this package and run video-context-mcp setup --update, or set VCM_YTDLP_BIN to a current yt-dlp. If the video needs a signed-in session, configure YTDLP_COOKIES_FILE.',
  },
  {
    pattern: /unable to download|network|timed out|temporary failure|getaddrinfo|ECONNRE/i,
    code: 'NETWORK',
    message: () => 'Network failure while contacting YouTube. Check connectivity and retry.',
  },
];

/** Map a yt-dlp failure (stderr + spawn error) to an actionable VcmError. */
export function classifyYtdlpFailure(
  stderr: string,
  cookiesConfigured: boolean,
  spawnError?: NodeJS.ErrnoException,
): VcmError {
  if (spawnError?.code === 'ENOENT') {
    return new VcmError(
      'BINARY_MISSING',
      'yt-dlp was not found on PATH. Install it (e.g. via nix/brew/pipx) or set VCM_YTDLP_BIN.',
    );
  }
  for (const rule of YTDLP_RULES) {
    if (rule.pattern.test(stderr)) {
      return new VcmError(rule.code, rule.message(cookiesConfigured));
    }
  }
  return new VcmError(
    'YTDLP_FAILED',
    'yt-dlp failed for an unrecognized reason. Run video-context-mcp doctor, update the managed runtime, and retry; configure YTDLP_COOKIES_FILE if the video requires a signed-in session.',
  );
}

/** Format any thrown value into an MCP tool error payload (always bounded). */
export function toToolError(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const msg =
    err instanceof VcmError
      ? `[${err.code}] ${err.message}`
      : err instanceof Error
        ? `[INTERNAL] ${err.message.slice(0, 400)}`
        : `[INTERNAL] ${String(err).slice(0, 400)}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}
