/**
 * Does the content actually match the type the upload claimed?
 *
 * A browser reports `file.type` from the filename; whoever crafts the request
 * controls it entirely. Without this check an account can store a document
 * under `image/png` and get it served back from the media origin with an image
 * content type — which is the shape of every "stored XSS via upload" story.
 * The magic numbers are the only thing here that the bytes themselves say.
 */
const MAGIC_NUMBERS: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  // GIF really is "GIF87a" or "GIF89a" — the fifth byte differs between them.
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  // RIFF covers webp (the container); the WEBP marker two bytes along is the
  // part that says it is not some other RIFF document.
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

/** A type the list above knows nothing about is refused rather than waved
 *  through: an unknown claim is the suspicious case, not the benign one. */
export function imageBytesMatchType(buffer: Buffer, claimedType: string): boolean {
  const magic = MAGIC_NUMBERS[claimedType.toLowerCase().trim()];
  if (!magic) return false;
  if (buffer.length < magic.length) return false;
  return magic.every((byte, i) => buffer[i] === byte);
}
