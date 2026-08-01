import { createHmac, createHash } from 'crypto';

interface PutObjectParams {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}

interface GetObjectParams {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
}

const ALLOWED_ENDPOINTS = new Set([
  'https://api.cloudflare.com/client/v4/accounts',
  'https://d1a3744znw0a9b.cloudflare.net',
]);

function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (!ALLOWED_ENDPOINTS.has(url.origin) && !url.hostname.endsWith('.r2.cloudflarestorage.com') && !url.hostname.endsWith('.storage.googleapis.com')) {
    throw new Error('Invalid endpoint');
  }
  return url.origin;
}

export async function putObject(params: PutObjectParams): Promise<void> {
  const { endpoint, accessKey, secretKey, bucket, key, body, contentType } = params;

  const normalizedKey = decodeURIComponent(key).replace(/^\//, '');
  if (!/^[a-zA-Z0-9._\-/]+$/.test(normalizedKey)) {
    throw new Error('Invalid key format');
  }
  if (normalizedKey.includes('..')) {
    throw new Error('Invalid key format');
  }

  const origin = validateEndpoint(endpoint);
  const url = `${origin}/${bucket}/${normalizedKey}`;

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateOnly = dateStr.slice(0, 8);

  const payloadHash = createHash('sha256').update(body).digest('hex');

  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-amz-date': dateStr,
    'x-amz-content-sha256': payloadHash,
  };

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k]}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    'PUT',
    `/${bucket}/${normalizedKey}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStr,
    `${dateOnly}/auto/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: string | Buffer, msg: string) =>
    createHmac('sha256', key).update(msg).digest();

  const signingKey = [
    `AWS4${secretKey}`,
    dateOnly,
    'auto',
    's3',
    'aws4_request',
  ].reduce((k, part) => hmac(k, part), Buffer.alloc(0));

  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${dateOnly}/auto/s3/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-amz-date': dateStr,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authHeader,
    },
    body: new Uint8Array(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`R2 upload failed (${res.status}): ${err}`);
  }
}

export async function getObject(params: GetObjectParams): Promise<{ data: Buffer; contentType: string } | null> {
  const { endpoint, accessKey, secretKey, bucket, key } = params;

  if (!key || typeof key !== 'string') return null;

  const normalizedKey = decodeURIComponent(key).replace(/^\//, '');
  if (!/^[a-zA-Z0-9._\-/]+$/.test(normalizedKey)) {
    throw new Error('Invalid key format');
  }
  if (normalizedKey.includes('..')) {
    throw new Error('Invalid key format');
  }

  const origin = validateEndpoint(endpoint);
  const url = `${origin}/${bucket}/${normalizedKey}`;

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateOnly = dateStr.slice(0, 8);

  const headers: Record<string, string> = {
    'x-amz-date': dateStr,
  };

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k]}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    'GET',
    `/${bucket}/${normalizedKey}`,
    '',
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStr,
    `${dateOnly}/auto/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: string | Buffer, msg: string) =>
    createHmac('sha256', key).update(msg).digest();

  const signingKey = [
    `AWS4${secretKey}`,
    dateOnly,
    'auto',
    's3',
    'aws4_request',
  ].reduce((k, part) => hmac(k, part), Buffer.alloc(0));

  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${dateOnly}/auto/s3/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-date': dateStr,
      'Authorization': authHeader,
    },
  });

  if (!res.ok) return null;

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const data = Buffer.from(await res.arrayBuffer());

  return { data, contentType };
}
