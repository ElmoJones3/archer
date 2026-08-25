/** @file Serves the generated API contract and a local Swagger UI without a CDN. */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';

/** Runtime CommonJS bridge used only for swagger-ui-dist's path helper. */
const require = createRequire(import.meta.url);

/** Narrow function published by swagger-ui-dist for locating browser-ready assets. */
type SwaggerAssetPath = () => string;

/** Installed browser assets keep the example documentation usable without loading its browser bundle in Node. */
const SWAGGER_ASSET_DIRECTORY = (require('swagger-ui-dist/absolute-path.js') as SwaggerAssetPath)();

/** Complete page that renders the generated contract served by this process. */
const SWAGGER_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Durable customer webhook API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener('load', function () {
        SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
      });
    </script>
  </body>
</html>`;

/** Browser asset names admitted by the documentation handler. */
type SwaggerAsset = 'swagger-ui.css' | 'swagger-ui-bundle.js';

/** Writes one complete non-streaming response with basic browser protections. */
function send(response: ServerResponse, contentType: string, body: string | Uint8Array): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes.byteLength),
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; connect-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  response.end(bytes);
}

/**
 * Serves the Swagger page or one allow-listed local asset.
 * @param pathname - Parsed request path from the webhook HTTP server.
 * @param response - Current Node response.
 * @returns Whether this function handled the path.
 */
export async function serveApiDocumentation(pathname: string, response: ServerResponse): Promise<boolean> {
  if (pathname === '/docs' || pathname === '/docs/') {
    send(response, 'text/html; charset=utf-8', SWAGGER_PAGE);
    return true;
  }

  /** Exact mapping prevents a public URL from becoming an arbitrary file read. */
  const asset: SwaggerAsset | undefined =
    pathname === '/docs/swagger-ui.css'
      ? 'swagger-ui.css'
      : pathname === '/docs/swagger-ui-bundle.js'
        ? 'swagger-ui-bundle.js'
        : undefined;
  if (asset === undefined) return false;

  /** Assets are fixed package files, never caller-selected paths. */
  const bytes = await readFile(join(SWAGGER_ASSET_DIRECTORY, asset));
  send(response, asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', bytes);
  return true;
}
