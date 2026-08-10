const CF_API = 'https://api.cloudflare.com/client/v4';

function getConfig() {
  return {
    token: process.env.CLOUDFLARE_API_TOKEN || '',
    zoneId: process.env.CLOUDFLARE_ZONE_ID || '',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  };
}

function headers(token: string) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function cfCreateForwardRule(
  address: string,
  domain: string,
  forwardTo: string,
  ruleName?: string,
): Promise<{ ok: boolean; ruleId?: string; error?: string }> {
  const { token, zoneId } = getConfig();
  if (!token || !zoneId) {
    return { ok: false, error: 'Cloudflare not configured (missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID)' };
  }

  try {
    const res = await fetch(`${CF_API}/zones/${zoneId}/email/routing/rules`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        name: ruleName || `Forward ${address}#${domain}`,
        priority: 0,
        enabled: true,
        matchers: [{
          type: 'literal',
          field: 'to',
          value: `${address}@${domain}`,
        }],
        actions: [{
          type: 'forward',
          value: [forwardTo],
        }],
      }),
    });

    const data: any = await res.json();
    if (data.success) {
      return { ok: true, ruleId: data.result?.id };
    }
    const errMsg = data.errors?.[0]?.message || 'Unknown Cloudflare error';
    console.error('[CF] Create rule failed:', errMsg);
    return { ok: false, error: errMsg };
  } catch (err: any) {
    console.error('[CF] API call failed:', err?.message || err);
    return { ok: false, error: 'Cloudflare API connection failed' };
  }
}

export async function cfDeleteForwardRule(
  address: string,
  domain: string,
): Promise<{ ok: boolean; error?: string }> {
  const { token, zoneId } = getConfig();
  if (!token || !zoneId) return { ok: true };

  try {
    const listRes = await fetch(`${CF_API}/zones/${zoneId}/email/routing/rules`, {
      headers: headers(token),
    });
    const listData: any = await listRes.json();
    if (!listData.success) return { ok: false, error: 'Failed to list rules' };

    const targetValue = `${address}@${domain}`;
    const rule = listData.result?.find((r: any) =>
      r.matchers?.some((m: any) => m.value === targetValue)
    );

    if (!rule) return { ok: true };

    const delRes = await fetch(`${CF_API}/zones/${zoneId}/email/routing/rules/${rule.tag}`, {
      method: 'DELETE',
      headers: headers(token),
    });
    const delData: any = await delRes.json();
    return { ok: delData.success, error: delData.errors?.[0]?.message };
  } catch (err: any) {
    console.error('[CF] Delete rule failed:', err?.message || err);
    return { ok: false, error: 'Cloudflare API connection failed' };
  }
}

export async function cfUpdateForwardRule(
  address: string,
  domain: string,
  newForwardTo: string,
): Promise<{ ok: boolean; error?: string }> {
  const { token, zoneId } = getConfig();
  if (!token || !zoneId) return { ok: true };

  try {
    const listRes = await fetch(`${CF_API}/zones/${zoneId}/email/routing/rules`, {
      headers: headers(token),
    });
    const listData: any = await listRes.json();
    if (!listData.success) return { ok: false, error: 'Failed to list rules' };

    const targetValue = `${address}@${domain}`;
    const rule = listData.result?.find((r: any) =>
      r.matchers?.some((m: any) => m.value === targetValue)
    );

    if (!rule) {
      return cfCreateForwardRule(address, domain, newForwardTo);
    }

    const updRes = await fetch(`${CF_API}/zones/${zoneId}/email/routing/rules/${rule.tag}`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({
        ...rule,
        actions: [{ type: 'forward', value: [newForwardTo] }],
      }),
    });
    const updData: any = await updRes.json();
    return { ok: updData.success, error: updData.errors?.[0]?.message };
  } catch (err: any) {
    console.error('[CF] Update rule failed:', err?.message || err);
    return { ok: false, error: 'Cloudflare API connection failed' };
  }
}

export async function cfVerifyDestination(
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const { token, accountId } = getConfig();
  if (!token || !accountId) return { ok: true };

  try {
    const res = await fetch(`${CF_API}/accounts/${accountId}/email/routing/addresses`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ email }),
    });
    const data: any = await res.json();
    return { ok: data.success, error: data.errors?.[0]?.message };
  } catch (err: any) {
    return { ok: false, error: 'Failed to verify destination' };
  }
}

export function cfIsConfigured(): boolean {
  const { token, zoneId } = getConfig();
  return !!(token && zoneId);
}
