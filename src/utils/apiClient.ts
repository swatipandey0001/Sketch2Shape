import type { ApiStructuredError } from '../types/studio';

export type SafeApiResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
    }
  | {
      ok: false;
      status: number;
      error: ApiStructuredError;
    };

function isHtmlPayload(contentType: string, trimmedBody: string): boolean {
  return (
    contentType.includes('text/html') ||
    trimmedBody.startsWith('<!doctype') ||
    trimmedBody.startsWith('<!DOCTYPE') ||
    trimmedBody.startsWith('<html') ||
    trimmedBody.startsWith('<HTML')
  );
}

/**
 * Safely inspects HTTP status and Content-Type before parsing JSON.
 * Prevents "Unexpected token '<', \"<!doctype ...\" is not valid JSON" when a
 * reverse proxy, gateway timeout, or SPA fallback returns HTML instead of JSON.
 */
export async function readApiJson<T = Record<string, unknown>>(
  resp: Response,
  endpointLabel: string
): Promise<SafeApiResult<T>> {
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  let rawText = '';

  try {
    rawText = await resp.text();
  } catch (readErr: unknown) {
    return {
      ok: false,
      status: resp.status,
      error: {
        code: 'RESPONSE_READ_ERROR',
        title: 'Failed to Read Server Response',
        message:
          readErr instanceof Error
            ? readErr.message
            : `Could not read response stream from ${endpointLabel}.`,
        suggestion: 'Check network connectivity and retry the request.',
      },
    };
  }

  const trimmed = rawText.trim();

  if (isHtmlPayload(contentType, trimmed)) {
    const isWarmupPage = /Starting Server|warmup/i.test(trimmed);
    const isForbiddenPage = /403 Forbidden/i.test(trimmed);

    return {
      ok: false,
      status: resp.status,
      error: {
        code: 'UNEXPECTED_HTML_RESPONSE',
        title: isWarmupPage
          ? 'Backend Server Warming Up or Upstream Gateway Intercepted Error'
          : isForbiddenPage
            ? 'Request Blocked by Reverse Proxy (HTTP 403)'
            : 'Server Returned HTML Instead of JSON',
        message: isWarmupPage
          ? `${endpointLabel} returned an HTML warmup/gateway page (HTTP ${resp.status}, Content-Type: ${contentType || 'text/html'}) instead of JSON. This occurs when the server is restarting or an upstream 502/503/504 response was intercepted by the reverse proxy.`
          : `${endpointLabel} returned an HTML document (HTTP ${resp.status}, Content-Type: ${contentType || 'text/html'}) instead of application/json. Ensure the Express API server is running and reachable.`,
        suggestion:
          'The app retried automatically and still got a web page instead of the API. Make sure the Node server (npm run dev) is running and that the site is not served by a static host or proxy that rewrites /api/* to index.html. Meanwhile, you can use the local CV options below.',
      },
    };
  }

  if (!trimmed) {
    return {
      ok: false,
      status: resp.status,
      error: {
        code: 'EMPTY_SERVER_RESPONSE',
        title: 'Empty Response from Server',
        message: `${endpointLabel} returned an empty body (HTTP ${resp.status}, Content-Type: ${contentType || 'none'}).`,
        suggestion: 'Retry the request in a moment.',
      },
    };
  }

  if (!contentType.includes('application/json') && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return {
      ok: false,
      status: resp.status,
      error: {
        code: 'NON_JSON_CONTENT_TYPE',
        title: 'Unexpected Non-JSON Response from Server',
        message: `${endpointLabel} returned Content-Type "${contentType || 'unknown'}" (HTTP ${resp.status}): ${trimmed.slice(0, 180)}`,
        suggestion: 'Verify backend route configuration and retry.',
      },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      status: resp.status,
      error: {
        code: 'INVALID_JSON_PAYLOAD',
        title: 'Malformed JSON Returned by Server',
        message: `${endpointLabel} returned HTTP ${resp.status} with Content-Type "${contentType || 'unknown'}", but the body was not valid JSON.`,
        suggestion: 'Retry the request; if the issue persists, inspect server logs.',
      },
    };
  }

  if (!resp.ok) {
    const serverError = parsed?.error as ApiStructuredError | undefined;
    if (
      serverError &&
      typeof serverError === 'object' &&
      typeof serverError.title === 'string' &&
      typeof serverError.message === 'string'
    ) {
      return {
        ok: false,
        status: resp.status,
        error: {
          ...serverError,
          code: typeof serverError.code === 'string' ? serverError.code : `HTTP_${resp.status}`,
        },
      };
    }

    return {
      ok: false,
      status: resp.status,
      error: {
        code: `HTTP_${resp.status}`,
        title: `Request Failed (HTTP ${resp.status})`,
        message:
          typeof parsed?.message === 'string'
            ? parsed.message
            : `${endpointLabel} failed with HTTP status ${resp.status}.`,
        suggestion: 'Review the input and retry.',
      },
    };
  }

  return {
    ok: true,
    status: resp.status,
    data: parsed as unknown as T,
  };
}

const TRANSIENT_ERROR_CODES = new Set([
  'UNEXPECTED_HTML_RESPONSE',
  'EMPTY_SERVER_RESPONSE',
  'NON_JSON_CONTENT_TYPE',
]);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch + readApiJson with automatic retry/backoff for transient gateway
 * problems (HTML warm-up pages, 502/503/504, dropped connections). Real JSON
 * errors from the Express API (4xx/5xx with a structured body) are NOT retried.
 * The body must be re-sendable (FormData / string), which holds for this app.
 */
export async function fetchApiJsonWithRetry<T = Record<string, unknown>>(
  url: string,
  init: RequestInit,
  endpointLabel: string,
  opts: { retries?: number; baseDelayMs?: number; onRetry?: (attempt: number, total: number) => void } = {}
): Promise<SafeApiResult<T>> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1500;

  for (let attempt = 0; ; attempt += 1) {
    const isLast = attempt >= retries;
    try {
      const resp = await fetch(url, init);
      const result = await readApiJson<T>(resp, endpointLabel);
      const transient =
        !result.ok &&
        (TRANSIENT_ERROR_CODES.has(result.error.code ?? '') || TRANSIENT_STATUSES.has(result.status));
      if (!transient || isLast) return result;
    } catch (err) {
      if (isLast) throw err;
    }
    opts.onRetry?.(attempt + 1, retries);
    await sleep(baseDelayMs * 2 ** attempt);
  }
}
