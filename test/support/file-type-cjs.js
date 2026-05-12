/**
 * CJS shim for file-type (ESM-only v21+).
 *
 * Jest runs in CommonJS mode; the real file-type package has `"type":"module"`
 * and no CJS build, so `await import('file-type')` throws inside Jest's runtime.
 *
 * This shim implements the same `fileTypeFromBuffer` API used by
 * AiVisagismService.assertPhotoValid using pure magic-byte detection —
 * no dependencies on ESM packages. It handles the three MIME types accepted
 * by the service: image/jpeg, image/png, image/webp.
 */
'use strict';

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ext: string, mime: string} | undefined>}
 */
async function fileTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return undefined;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { ext: 'png', mime: 'image/png' };
  }

  // WebP: RIFF????WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }

  return undefined;
}

module.exports = { fileTypeFromBuffer };
