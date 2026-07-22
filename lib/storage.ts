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

export async function putObject(params: PutObjectParams): Promise<void> {
  const { endpoint, accessKey, secretKey, bucket, key, body, contentType } = params;
  const url = `${endpoint}/${bucket}/${key}`;

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
    `/${bucket}/${key}`,
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
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`R2 upload failed (${res.status}): ${err}`);
  }
}
