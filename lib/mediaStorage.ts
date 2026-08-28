export interface StoreMediaResult {
  url: string;
  storedInDb: boolean;
}

function getR2Env() {
  const endpoint = process.env.R2_ENDPOINT || process.env.S3_API_ENDPOINT || process.env.S3_ENDPOINT || '';
  const accessKey = process.env.R2_ACCESS_KEY || process.env.ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || '';
  const secretKey = process.env.R2_SECRET_KEY || process.env.SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || '';
  const bucket = process.env.R2_BUCKET || process.env.S3_BUCKET || '';
  const publicUrl = process.env.R2_PUBLIC_URL || process.env.S3_PUBLIC_URL || endpoint;
  return { endpoint, accessKey, secretKey, bucket, publicUrl };
}

export function r2Configured(): boolean {
  const { endpoint, accessKey, secretKey, bucket } = getR2Env();
  return !!(endpoint && accessKey && secretKey && bucket);
}

export async function storeMediaFile(opts: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<StoreMediaResult> {
  const env = getR2Env();
  if (r2Configured()) {
    const { putObject } = await import('./storage');
    await putObject({
      endpoint: env.endpoint,
      accessKey: env.accessKey,
      secretKey: env.secretKey,
      bucket: env.bucket,
      key: opts.key,
      body: opts.body,
      contentType: opts.contentType,
    });
    return { url: `${env.publicUrl.replace(/\/$/, '')}/${opts.key}`, storedInDb: false };
  }

  const base64 = Buffer.from(opts.body).toString('base64');
  return { url: `data:${opts.contentType};base64,${base64}`, storedInDb: true };
}
