/* WebRTC credential minting for Tirbeo calls (TURN + RealtimeKit).

   A browser cannot connect a P2P call without ICE servers, and the TURN part
   needs short-lived scoped credentials — minted here, server-side, from the
   Cloudflare account token that never reaches the client. One API call per
   session; the TTL keeps leaked credentials expiring on their own. */

const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export interface IceServers {
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
}

/** Short-lived TURN/STUN set for one RTCPeerConnection. Default TTL 1h. */
export async function generateTurnIceServers(ttlSeconds = 3600): Promise<IceServers> {
  const keyId = process.env.TURN_KEY_ID || '';
  const apiToken = process.env.TURN_API_TOKEN || '';
  if (!keyId || !apiToken) throw new Error('TURN_KEY_ID / TURN_API_TOKEN are not configured');

  const res = await fetch(`${TURN_API}/${keyId}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ttl: ttlSeconds }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`TURN credential mint failed: HTTP ${res.status}`);
  return (await res.json()) as IceServers;
}

/** RealtimeKit meeting tokens (SDK-free REST path). Configured-but-unused is
    fine: the app can run TURN-only until a meetings UI ships. */
export function realtimeKitConfig(): { appId: string; apiToken: string } | null {
  const appId = process.env.REALTIMEKIT_APP_ID || '';
  const apiToken = process.env.REALTIMEKIT_API_TOKEN || '';
  return appId && apiToken ? { appId, apiToken } : null;
}
