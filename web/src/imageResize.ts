// Client-side resize + re-encode of photos before upload, no library:
// menu photos (M1-5b, WebP <= 800px/200 KB) and slip pages (JPEG <= 1600px,
// EXIF rotation applied — the slip reader phase 1 contract).

const MAX_SIDES = [800, 600] // px, longer side
const QUALITIES = [0.8, 0.7, 0.6, 0.5]
const MAX_BYTES = 200 * 1024

interface DecodedImage {
  source: ImageBitmap | HTMLImageElement
  cleanup: () => void
}

/** createImageBitmap with an <img> + object-URL fallback for old Safari. */
async function decodeImage(file: File, options?: ImageBitmapOptions): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      return { source: await createImageBitmap(file, options), cleanup: () => undefined }
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('อ่านรูปไม่ได้'))
      img.src = url
    })
    return { source: img, cleanup: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

function drawScaled(source: ImageBitmap | HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const w = source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width
  const h = source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height
  const scale = Math.min(1, maxSide / Math.max(w, h)) // never upscale
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('อ่านรูปไม่ได้')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality))
}

/**
 * Resize (longer side <= 800, never upscale) and re-encode to WebP, falling
 * back to JPEG where the browser can't encode WebP (iOS Safari). Steps the
 * quality down, then the size, until the blob fits in 200 KB.
 */
export async function prepareMenuImage(file: File): Promise<Blob> {
  const { source, cleanup } = await decodeImage(file)
  try {
    let type = 'image/webp'
    for (const maxSide of MAX_SIDES) {
      const canvas = drawScaled(source, maxSide)
      for (const quality of QUALITIES) {
        let blob = await canvasToBlob(canvas, type, quality)
        // browsers that can't encode webp silently return png/jpeg instead
        if (blob !== null && type === 'image/webp' && blob.type !== 'image/webp') {
          type = 'image/jpeg'
          blob = await canvasToBlob(canvas, type, quality)
        }
        if (blob !== null && blob.size <= MAX_BYTES) return blob
      }
    }
    throw new Error('รูปใหญ่เกินไป')
  } finally {
    cleanup()
  }
}

// ---- slip pages (slip reader phase 1) ----
// The backend stores pages as JPEG only and allows 3 MB each; the reader wants
// readable text, so these stay much larger than menu photos.

const SLIP_MAX_SIDE = 1600 // px, longer side
const SLIP_QUALITIES = [0.85, 0.7, 0.55]
const SLIP_MAX_BYTES = 3 * 1024 * 1024

/**
 * One receipt photo: EXIF rotation applied (createImageBitmap 'from-image'),
 * longer side <= 1600 (never upscaled), JPEG q0.85. Slips are photographed in
 * one quick tap, so the phone orientation must be baked in, not trusted.
 */
export async function prepareSlipPage(file: File): Promise<Blob> {
  // <img> fallback also honours EXIF (image-orientation: from-image is the default)
  const { source, cleanup } = await decodeImage(file, { imageOrientation: 'from-image' })
  try {
    const canvas = drawScaled(source, SLIP_MAX_SIDE)
    for (const quality of SLIP_QUALITIES) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
      if (blob !== null && blob.type === 'image/jpeg' && blob.size <= SLIP_MAX_BYTES) return blob
    }
    throw new Error('รูปใหญ่เกินไป')
  } finally {
    cleanup()
  }
}
