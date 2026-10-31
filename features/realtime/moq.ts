/* Cloudflare MoQ Relay (Media over QUIC) configuration for live reels/streams.

   The relay speaks WebTransport/QUIC — browsers cannot open raw QUIC sockets,
   so the client side needs Cloudflare's moq client library; this module owns
   the server half: endpoint + scoped publish/subscribe tokens handed out only
   to authorized sessions. Tokens are long-lived JWTs from the dashboard —
   mint fresh ones and keep them in secrets, never committed. */

export interface MoqConfig {
  endpoint: string;
  publishToken: string;
  subscribeToken: string;
}

export function moqConfigured(): boolean {
  return !!(process.env.MOQ_CATALOG_TOKEN_PUB || process.env.MOQ_CATALOG_TOKEN_SUB);
}

export function getMoqConfig(): MoqConfig | null {
  const publishToken = process.env.MOQ_CATALOG_TOKEN_PUB || '';
  const subscribeToken = process.env.MOQ_CATALOG_TOKEN_SUB || '';
  if (!publishToken && !subscribeToken) return null;
  return {
    endpoint: process.env.MOQ_ENDPOINT || 'https://moq.cloudflare.com',
    publishToken,
    subscribeToken,
  };
}
