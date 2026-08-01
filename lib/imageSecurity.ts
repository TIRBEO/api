import { stat } from 'fs/promises';
import path from 'path';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const MAGIC_NUMBERS: Record<string, { bytes: number[]; offset: number }> = {
  'image/png': { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], offset: 0 },
  'image/jpeg': { bytes: [0xFF, 0xD8, 0xFF], offset: 0 },
  'image/gif': { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], offset: 0 },
  'image/webp': { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  'image/svg+xml': { bytes: [0x3C, 0x3F, 0x78, 0x6D, 0x6C], offset: 0 },
  'image/x-icon': { bytes: [0x00, 0x00, 0x01, 0x00], offset: 0 },
};

export async function validateImageFile(filePath: string, claimedContentType: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) return false;
    if (stats.size === 0) return false;

    const fd = await (await import('fs')).promises.open(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(stats.size, 16));
    await fd.read(buffer, 0, buffer.length, 0);
    await fd.close();

    const expected = MAGIC_NUMBERS[claimedContentType];
    if (!expected) return true;

    for (let i = 0; i < expected.bytes.length; i++) {
      if (buffer[expected.offset + i] !== expected.bytes[i]) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
