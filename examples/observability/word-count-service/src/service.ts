/**
 * @file Implements an HTTP word-count service with one wide record per request.
 *
 * HTTP results remain authoritative. Diagnostics accumulate useful request
 * context, but a diagnostic refusal can never rewrite a response or status code.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { toPublicError, type JsonObject } from '@archer/core';
import type { DiagnosticHub, DiagnosticSpan } from '@archer/core/diagnostics';

/** Input for one listening word-count service. */
export type StartWordCountServiceOptions = Readonly<{
  /** Product-neutral diagnostics owner used around every HTTP request. */
  diagnostics: Pick<DiagnosticHub, 'beginSpan'>;
  /** Network interface, defaulting to loopback for safe local execution. */
  host?: string;
  /** TCP port, where zero asks the operating system for an available port. */
  port?: number;
}>;

/** Retained listening application with explicit lifecycle ownership. */
export interface WordCountService {
  /** Complete base URL assigned after the server starts listening. */
  readonly url: URL;
  /** Stops accepting requests and waits for active connections to close. */
  close(): Promise<void>;
}

/** Maximum request bytes retained before JSON admission. */
const REQUEST_LIMIT_BYTES = 64 * 1024;

/**
 * Writes one complete JSON response with explicit content metadata.
 * @param response - Node response owned by the active request.
 * @param statusCode - HTTP status selected by application behavior.
 * @param value - JSON-compatible response body.
 */
function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  /** Complete encoding establishes the exact content length before headers leave. */
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  });
  response.end(body);
}

/**
 * Reads one bounded request body without trusting content-length metadata.
 * @param request - Incoming request stream supplied by Node.
 * @returns Complete caller-owned bytes after the size limit is enforced.
 */
async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  /** Copied chunks cannot be mutated by later stream reuse. */
  const chunks: Uint8Array[] = [];
  /** Running size rejects oversized bodies before another chunk is retained. */
  let byteLength = 0;
  /** Every transport chunk is copied before request-stream buffers may be reused. */
  for await (const value of request) {
    /** Node request streams produce Buffer values, which implement Uint8Array. */
    const chunk = Uint8Array.from(value as Uint8Array);
    byteLength += chunk.byteLength;
    if (byteLength > REQUEST_LIMIT_BYTES) throw new RangeError('Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  /** One complete body makes JSON parsing independent from transport chunking. */
  const body = new Uint8Array(byteLength);
  /** Offset preserves arrival order during flattening. */
  let offset = 0;
  /** Copied chunks are flattened without changing their observed transport order. */
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Admits the small request contract used by this service.
 * @param body - Complete request bytes already bounded by transport policy.
 * @returns Text whose Unicode whitespace-delimited words will be counted.
 */
function parseText(body: Uint8Array): string {
  /** Fatal decoding rejects malformed UTF-8 instead of inserting replacement characters. */
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  /** JSON parsing remains an application boundary rather than a diagnostic concern. */
  const value = JSON.parse(decoded) as unknown;
  if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string') {
    throw new TypeError('Request body must be a JSON object with a text string');
  }
  return value.text;
}

/**
 * Counts human-readable whitespace-delimited words for the service response.
 * @param text - Admitted request text.
 * @returns Zero for blank input or the number of non-empty word segments.
 */
function countWords(text: string): number {
  /** Trimming makes every blank string the same explicit zero case. */
  const normalized = text.trim();
  return normalized.length === 0 ? 0 : normalized.split(/\s+/u).length;
}

/**
 * Adds context best-effort so observability cannot become response authority.
 * @param span - Active request observation.
 * @param namespace - Stable top-level context namespace.
 * @param attributes - Complete replacement value for that namespace.
 */
function enrich(span: DiagnosticSpan, namespace: string, attributes: JsonObject): void {
  span.enrich(namespace, attributes);
}

/**
 * Handles one real HTTP request and settles exactly one diagnostic span.
 * @param request - Incoming Node request.
 * @param response - Response paired with that request.
 * @param diagnostics - Non-authoritative span factory supplied by the application.
 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  diagnostics: Pick<DiagnosticHub, 'beginSpan'>,
): Promise<void> {
  /** Route excludes query parameters so aggregation remains stable. */
  const route = new URL(request.url ?? '/', 'http://localhost').pathname;
  /** Request observation starts before body work and emits only at settlement. */
  const span = diagnostics.beginSpan({
    name: 'http.request',
    component: 'examples.observability.word-count-service',
    correlation: {},
    attributes: { http: { method: request.method ?? 'UNKNOWN', route } },
  });

  if (request.method !== 'POST' || route !== '/count') {
    enrich(span, 'http', { method: request.method ?? 'UNKNOWN', route, statusCode: 404 });
    sendJson(response, 404, { error: 'not found' });
    span.complete({ outcome: 'not-found' });
    return;
  }

  try {
    /** Complete bytes support both admission and wide-record request size context. */
    const body = await readBody(request);
    /** Domain input is admitted before any successful response context is recorded. */
    const text = parseText(body);
    /** Word count is the authoritative application result returned to the caller. */
    const words = countWords(text);
    enrich(span, 'http', { method: 'POST', route, statusCode: 200 });
    enrich(span, 'request', { bytes: body.byteLength });
    enrich(span, 'result', { words });
    sendJson(response, 200, { words });
    span.complete({ outcome: 'completed' });
  } catch (error) {
    /** Invalid caller input is bounded and receives a stable client response. */
    const statusCode = error instanceof SyntaxError || error instanceof TypeError ? 400 : 413;
    enrich(span, 'http', { method: 'POST', route, statusCode });
    sendJson(response, statusCode, { error: statusCode === 400 ? 'invalid request' : 'request too large' });
    span.fail({
      outcome: 'rejected',
      error: toPublicError(error, {
        code: 'word_count_request_rejected',
        message: 'The word-count request was rejected',
      }),
    });
  }
}

/**
 * Waits for Node to bind one listener or report its startup failure.
 * @param server - Newly constructed server that is not listening yet.
 * @param host - Explicit network interface.
 * @param port - Validated TCP port, including zero for automatic assignment.
 */
async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolveListening, rejectListening) => {
    /**
     * Rejects startup once without retaining an error listener after success.
     * @param error - Listener failure reported by Node before binding completes.
     */
    function onError(error: Error): void {
      rejectListening(error);
    }
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveListening();
    });
  });
}

/**
 * Starts the instrumented HTTP application.
 * @param options - Diagnostics owner and optional listener selection.
 * @returns Listening service whose close operation is retained and idempotent.
 */
export async function startWordCountService(options: StartWordCountServiceOptions): Promise<WordCountService> {
  /** Loopback is the safe default for a local runnable example. */
  const host = options.host ?? '127.0.0.1';
  /** Port zero delegates collision-free test selection to the operating system. */
  const port = options.port ?? 3000;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError('Port must be 0 through 65535');

  /** Request callback isolates asynchronous application failure within its paired response. */
  const server = createServer((request, response) => {
    void handleRequest(request, response, options.diagnostics).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.destroy(error instanceof Error ? error : new Error('Unhandled request failure'));
    });
  });
  await listen(server, host, port);
  /** A listening TCP server always reports an address object rather than a pipe name. */
  const address = server.address() as AddressInfo;
  /** Retaining the first close promise makes repeated owners observe one lifecycle settlement. */
  let closePromise: Promise<void> | undefined;
  /** Public handle exposes only application URL and orderly listener cleanup. */
  const service: WordCountService = {
    url: new URL(`http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`),
    /**
     * Stops admission and waits for active requests instead of aborting application work.
     * @returns Retained settlement shared by every caller closing this service.
     */
    close() {
      closePromise ??= new Promise<void>((resolveClosed, rejectClosed) => {
        server.close((error) => (error === undefined ? resolveClosed() : rejectClosed(error)));
      });
      return closePromise;
    },
  };
  return Object.freeze(service);
}
