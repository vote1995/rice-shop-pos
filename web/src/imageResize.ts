// Client-side resize + re-encode of menu photos before upload (M1-5b).
// Keeps uploads small enough for the 200 KB backend limit without a library.

const MAX_SIDES = [800, 600] // px, longer side
const QUALITIES = [0.8, 0.7, 0.6, 0.5]
const MAX_BYTES = 200 * 1024

interface DecodedImage {
  source: ImageBitmap | HTMLImageElement
  cleanup: () => void
}

/** createImageBitmap with an <img> + object-URL fallback for old Safari. */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      return { source: await createImageBitmap(file), cleanup: () => undefined }
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
