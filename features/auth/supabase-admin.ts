// Thin, dependency-free client for the Supabase GoTrue Admin API. New Tirbeo
// accounts are real Supabase Auth users (email + temp password, confirmed) so
// the identity is backed by Supabase Auth; the app keeps using its proven
// __session/argon2 loop for actual sign-in. If Supabase is not configured the
// helpers degrade gracefully and the app runs standalone.

async function adminFetch(path: string, init?: RequestInit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return fetch(`${url}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

export async function createSupabaseAuthUser(input: {
  email: string;
  password: string;
  emailConfirm?: boolean;
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; id?: string; reason?: string }> {
  try {
    const res = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        email_confirm: input.emailConfirm ?? true,
        user_metadata: input.userMetadata ?? {},
        app_metadata: input.appMetadata ?? {},
      }),
    });
    if (!res) return { ok: false, reason: 'supabase_not_configured' };
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      return { ok: false, reason: data?.msg || `http_${res.status}` };
    }
    const user: any = await res.json();
    return { ok: true, id: user?.id };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// Generate a password-recovery link for an existing Supabase Auth user.
// Returns the full URL (GoTrue appends &email=...&type=recovery).
export async function generateSupabaseRecoveryLink(email: string): Promise<string | null> {
  try {
    const res = await adminFetch('/admin/generate_link', {
      method: 'POST',
      body: JSON.stringify({ email, type: 'recovery' }),
    });
    if (!res || !res.ok) return null;
    const data: any = await res.json();
    return typeof data?.action_link === 'string' ? data.action_link : null;
  } catch {
    return null;
  }
}