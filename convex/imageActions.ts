"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

// ─── Image processing actions (Node.js runtime) ────────────────────
// Pure JavaScript image processing using pngjs + jpeg-js.
// No native addons required — works in Convex's Node.js runtime.

/** Decode an image buffer (PNG or JPEG) to raw RGBA pixels. */
function decodeImage(buffer: Buffer): { data: Buffer; width: number; height: number } {
  // JPEG signature: FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const imageData = jpeg.decode(buffer, { maxResolutionInMP: 50 });
    return { data: Buffer.from(imageData.data), width: imageData.width, height: imageData.height };
  }
  // PNG signature: 89 50 4E 47
  const png = PNG.sync.read(buffer);
  return { data: png.data, width: png.width, height: png.height };
}

/** Encode raw RGBA pixels to PNG buffer. */
function encodePNG(data: Buffer, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  data.copy(png.data);
  return PNG.sync.write(png);
}

/** Bilinear resize of RGBA pixel data. */
function resizeRGBA(
  src: Buffer, srcW: number, srcH: number,
  dstW: number, dstH: number,
): Buffer {
  const dst = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = x * (srcW - 1) / Math.max(1, dstW - 1);
      const srcY = y * (srcH - 1) / Math.max(1, dstH - 1);
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = srcX - x0;
      const fy = srcY - y0;

      for (let c = 0; c < 4; c++) {
        const v00 = src[(y0 * srcW + x0) * 4 + c];
        const v10 = src[(y0 * srcW + x1) * 4 + c];
        const v01 = src[(y1 * srcW + x0) * 4 + c];
        const v11 = src[(y1 * srcW + x1) * 4 + c];
        dst[(y * dstW + x) * 4 + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy + v11 * fx * fy,
        );
      }
    }
  }
  return dst;
}

/** Crop a detected clothing item from the source image using bounding box coordinates.
 *  Returns the storageId of the uploaded crop image. */
export const cropDetectedItem = action({
  args: {
    sourceStorageId: v.id("_storage"),
    boundingBox: v.object({
      x: v.number(),
      y: v.number(),
      width: v.number(),
      height: v.number(),
    }),
  },
  handler: async (ctx, { sourceStorageId, boundingBox }) => {
    const sourceUrl = await ctx.storage.getUrl(sourceStorageId);
    if (!sourceUrl) throw new Error("Source image not found");

    // Download source image
    const sourceResp = await fetch(sourceUrl);
    const sourceBuffer = Buffer.from(await sourceResp.arrayBuffer());

    // Decode to raw RGBA pixels
    const { data, width, height } = decodeImage(sourceBuffer);

    // Normalize bounding box (0-1000 range → pixel coordinates with 8% padding)
    const bx = Math.max(0, Math.min(999, Math.round(boundingBox.x)));
    const by = Math.max(0, Math.min(999, Math.round(boundingBox.y)));
    const bw = Math.max(1, Math.min(1000 - bx, Math.round(boundingBox.width)));
    const bh = Math.max(1, Math.min(1000 - by, Math.round(boundingBox.height)));

    const rawLeft = (bx / 1000) * width;
    const rawTop = (by / 1000) * height;
    const rawWidth = (bw / 1000) * width;
    const rawHeight = (bh / 1000) * height;
    const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));

    const left = Math.max(0, Math.floor(rawLeft - padding));
    const top = Math.max(0, Math.floor(rawTop - padding));
    const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
    const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));

    const cropW = Math.max(1, right - left);
    const cropH = Math.max(1, bottom - top);

    // Extract crop region
    const cropData = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const srcIdx = ((top + y) * width + (left + x)) * 4;
        const dstIdx = (y * cropW + x) * 4;
        cropData[dstIdx] = data[srcIdx];
        cropData[dstIdx + 1] = data[srcIdx + 1];
        cropData[dstIdx + 2] = data[srcIdx + 2];
        cropData[dstIdx + 3] = data[srcIdx + 3];
      }
    }

    const cropBuffer = encodePNG(cropData, cropW, cropH);

    // Upload crop to Convex storage
    const uploadUrl = await ctx.storage.generateUploadUrl();
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: cropBuffer,
    });
    const { storageId: cropStorageId } = await uploadResp.json();
    return cropStorageId;
  },
});

/** Remove chroma key background from a garment image and frame it on 1024x1024 transparent canvas.
 *  Returns { garmentStorageId, failedStorageId } — the cleaned image and the raw (pre-cleanup) image. */
export const processGarmentImage = action({
  args: {
    imageBase64: v.string(),
    chromaKey: v.string(),
  },
  handler: async (ctx, { imageBase64, chromaKey }) => {
    const rawBuffer = Buffer.from(imageBase64, "base64");

    // Decode garment PNG (always PNG from OpenAI)
    const { data, width, height } = decodeImage(rawBuffer);

    // Parse chroma key target color
    const chromaTarget = [1, 3, 5].map((offset) =>
      Number.parseInt(chromaKey.slice(offset, offset + 2), 16),
    );
    const tolerance = 46;
    const feather = 80;

    // Chroma key removal: pixel-level alpha manipulation
    for (let idx = 0; idx < data.length; idx += 4) {
      const distance = Math.sqrt(
        ((data[idx] - chromaTarget[0]) ** 2) +
        ((data[idx + 1] - chromaTarget[1]) ** 2) +
        ((data[idx + 2] - chromaTarget[2]) ** 2),
      );

      if (distance <= tolerance) {
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 0;
      } else {
        if (distance < tolerance + feather) {
          data[idx + 3] = Math.round(data[idx + 3] * ((distance - tolerance) / feather));
        }
        if (data[idx + 3] <= 8) {
          data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 0;
        }
      }
    }

    // Find bounding box of non-transparent pixels
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let idx = 0, px = 0; idx < data.length; idx += 4, px += 1) {
      if (data[idx + 3] <= 8) continue;
      const x = px % width;
      const y = Math.floor(px / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }

    let processedBuffer: Buffer;

    if (maxX >= minX && maxY >= minY) {
      // Trim to bounding box
      const trimW = maxX - minX + 1;
      const trimH = maxY - minY + 1;
      const trimmed = Buffer.alloc(trimW * trimH * 4);
      for (let y = 0; y < trimH; y++) {
        for (let x = 0; x < trimW; x++) {
          const srcIdx = ((minY + y) * width + (minX + x)) * 4;
          const dstIdx = (y * trimW + x) * 4;
          trimmed[dstIdx] = data[srcIdx];
          trimmed[dstIdx + 1] = data[srcIdx + 1];
          trimmed[dstIdx + 2] = data[srcIdx + 2];
          trimmed[dstIdx + 3] = data[srcIdx + 3];
        }
      }

      // Resize to fit within 88% of 1024px canvas
      const targetSize = Math.max(1, Math.round(1024 * 0.88));
      const scaleX = targetSize / trimW;
      const scaleY = targetSize / trimH;
      const scale = Math.min(scaleX, scaleY);
      const resizedW = Math.max(1, Math.round(trimW * scale));
      const resizedH = Math.max(1, Math.round(trimH * scale));

      const resized = (trimW !== resizedW || trimH !== resizedH)
        ? resizeRGBA(trimmed, trimW, trimH, resizedW, resizedH)
        : trimmed;

      // Frame on 1024×1024 transparent canvas
      const canvasData = Buffer.alloc(1024 * 1024 * 4); // all zeros = transparent
      const left = Math.floor((1024 - resizedW) / 2);
      const top_ = Math.floor((1024 - resizedH) / 2);

      for (let y = 0; y < resizedH; y++) {
        for (let x = 0; x < resizedW; x++) {
          const srcIdx = (y * resizedW + x) * 4;
          const dstIdx = ((top_ + y) * 1024 + (left + x)) * 4;
          canvasData[dstIdx] = resized[srcIdx];
          canvasData[dstIdx + 1] = resized[srcIdx + 1];
          canvasData[dstIdx + 2] = resized[srcIdx + 2];
          canvasData[dstIdx + 3] = resized[srcIdx + 3];
        }
      }

      processedBuffer = encodePNG(canvasData, 1024, 1024);
    } else {
      // Background removal left nothing visible — use raw output as fallback
      processedBuffer = rawBuffer;
    }

    // Upload raw (failed-source) for cleanup editor fallback
    const failedUploadUrl = await ctx.storage.generateUploadUrl();
    const failedResp = await fetch(failedUploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: rawBuffer,
    });
    const { storageId: failedStorageId } = await failedResp.json();

    // Upload processed (cleaned) garment to Convex storage
    const garmentUploadUrl = await ctx.storage.generateUploadUrl();
    const garmentResp = await fetch(garmentUploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: processedBuffer,
    });
    const { storageId: garmentStorageId } = await garmentResp.json();

    return { garmentStorageId, failedStorageId };
  },
});
