export interface StoreMediaResult {
  url: string;
  storedInDb: boolean;
}

export function r2Configured(): boolean {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY &&
    process.env.R2_SECRET_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
}

export async function storeMediaFile(opts: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<StoreMediaResult> {
  if (r2Configured()) {
    const { putObject } = await import('./storage');
    await putObject({
      endpoint: process.env.R2_ENDPOINT!,
      accessKey: process.env.R2_ACCESS_KEY!,
      secretKey: process.env.R2_SECRET_KEY!,
      bucket: process.env.R2_BUCKET!,
      key: opts.key,
      body: opts.body,
      contentType: opts.contentType,
    });
    return { url: `${process.env.R2_PUBLIC_URL}/${opts.key}`, storedInDb: false };
  }

  const base64 = Buffer.from(opts.body).toString('base64');
  return { url: `data:${opts.contentType};base64,${base64}`, storedInDb: true };
}
