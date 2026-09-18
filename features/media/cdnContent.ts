function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * HTTP headers must be Latin-1; macOS filenames often contain U+202F etc.
 * Sends both an ASCII fallback and a UTF-8 encoded filename.
 */
export function buildContentDisposition(filename: string, disposition = 'attachment'): string {
  const asciiFallback =
    filename
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\;]/g, '_')
      .slice(0, 200) || 'download';

  const encoded = encodeRFC5987(filename);

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
