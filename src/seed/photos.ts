import { DEMO_PHOTOS } from './photos.generated';

/** EXIF DateTime format: "YYYY:MM:DD HH:MM:SS" (19 ASCII chars, local time, no zone). */
export function exifDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Return the demo photo bytes with DateTimeOriginal rewritten to `takenAt`.
 * The placeholder and the replacement are both 19 bytes, so EXIF offsets stay valid.
 */
export function demoPhoto(id: string, takenAt: Date): { filename: string; bytes: Buffer; exifDate: string } {
  const photo = DEMO_PHOTOS.find((p) => p.id === id);
  if (!photo) throw new Error(`unknown demo photo ${id}`);
  const bytes = Buffer.from(photo.base64, 'base64');
  const needle = Buffer.from(photo.placeholder, 'ascii');
  const at = bytes.indexOf(needle);
  if (at < 0) throw new Error(`placeholder missing in ${id}`);
  const stamp = exifDate(takenAt);
  bytes.write(stamp, at, 'ascii');
  return { filename: photo.filename, bytes, exifDate: stamp };
}

export const demoPhotoIds = () => DEMO_PHOTOS.map((p) => p.id);
