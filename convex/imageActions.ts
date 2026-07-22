"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import sharp from "sharp";

// ─── Image processing actions (Node.js runtime) ────────────────────
// Mirrors the original upstream pipeline (scripts/import-job-api.mjs):
//   cropDetectedItem — sharp-based crop with EXIF-aware normalize
//   processGarmentImage — removeChromaBackground + frameTransparentGarment + verify
// sharp is listed in convex.json "externalPackages" so Convex installs
// the linux-arm64 build in its Node.js runtime.

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeBoundingBox(value: { x: number; y: number; width: number; height: number }) {
  const number = (key: "x" | "y" | "width" | "height", fallback: number) =>
    Number.isFinite(Number(value[key])) ? Math.round(Number(value[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

async function normalizeImage(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

function removeKeyedSpill(data: Buffer, index: number, keyedChannels: number[], neutralLevel: number) {
  let remaining = Math.ceil(
    keyedChannels.reduce((total, channel) => total + data[index + channel], 0)
    - (neutralLevel * keyedChannels.length),
  );
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next: number[] = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
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

    const sourceResp = await fetch(sourceUrl);
    const sourceBuffer = Buffer.from(await sourceResp.arrayBuffer());

    // Normalize (EXIF rotate, sRGB, PNG) then extract crop region
    const normalized = await normalizeImage(sourceBuffer);
    const { width, height } = await sharp(normalized).metadata();
    const box = normalizeBoundingBox(boundingBox);
    const rawLeft = (box.x / 1000) * width!;
    const rawTop = (box.y / 1000) * height!;
    const rawWidth = (box.width / 1000) * width!;
    const rawHeight = (box.height / 1000) * height!;
    const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
    const left = Math.max(0, Math.floor(rawLeft - padding));
    const top = Math.max(0, Math.floor(rawTop - padding));
    const right = Math.min(width!, Math.ceil(rawLeft + rawWidth + padding));
    const bottom = Math.min(height!, Math.ceil(rawTop + rawHeight + padding));

    const cropBuffer = await sharp(normalized)
      .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
      .png()
      .toBuffer();

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

/** Frame a transparent garment on a 1024×1024 canvas at 88% occupancy. */
async function frameTransparentGarment(bytes: Buffer, canvasSize = 1024, occupancy = 0.88): Promise<Buffer> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({
    create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

/** Count chroma-key contamination left in the transparent garment. */
async function verifyNoChromaSpill(bytes: Buffer, key: string) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null) as number[];
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null) as number[];
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

/** Core chroma key removal algorithm (3-pass + framing + verification).
 *  Extracted so both processGarmentImage and cleanupGarmentPreview can use it.
 *  Returns the processed buffer and verification result. */
async function processChromaBackground(
  rawBuffer: Buffer,
  chromaKey: string,
  tolerance: number,
): Promise<{ processed: Buffer; verification: { contaminatedPixels: number; maxSpill: number } }> {
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(chromaKey.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null) as number[];
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null) as number[];

  const { data, info } = await sharp(rawBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // Pass 1: chroma key removal + keyed spill reduction
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) {
        data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      }
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }

  // Pass 2: residual spill sweep
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }

  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);

  // Pass 3: post-frame residual spill sweep
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const processed = await sharp(framedData, { raw: framedInfo }).png().toBuffer();

  const verification = await verifyNoChromaSpill(processed, chromaKey);
  console.log(`Chroma cleanup (tolerance=${tolerance}): ${verification.contaminatedPixels} contaminated pixels, max spill ${verification.maxSpill.toFixed(2)}`);

  return { processed, verification };
}

/** Remove chroma key background from a garment image and frame it on 1024x1024 transparent canvas.
 *  Port of original processChromaBackground + frameTransparentGarment + verifyNoChromaSpill.
 *  Returns { garmentStorageId, failedStorageId, verification, chromaSuccess } — the cleaned image,
 *  the raw (pre-cleanup) image, the chroma-spill verification result, and whether chroma
 *  removal succeeded (false = processing threw, garment image is raw/unusable). */
export const processGarmentImage = action({
  args: {
    imageBase64: v.string(),
    chromaKey: v.string(),
  },
  handler: async (ctx, { imageBase64, chromaKey }) => {
    const rawBuffer = Buffer.from(imageBase64, "base64");

    let processedBuffer: Buffer;
    let verification = { contaminatedPixels: 0, maxSpill: 0 };
    let chromaSuccess = false;

    try {
      const result = await processChromaBackground(rawBuffer, chromaKey, 46);
      processedBuffer = result.processed;
      verification = result.verification;
      chromaSuccess = true;
    } catch (chromaError) {
      console.warn("Chroma key removal failed, using raw garment:", chromaError);
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

    return { garmentStorageId, failedStorageId, verification, chromaSuccess };
  },
});

/** Cleanup editor: re-process a failed garment image with a user-specified tolerance.
 *  Downloads the raw failed-source image, runs chroma removal with the given tolerance,
 *  uploads the preview, and returns the preview storage ID + verification. */
export const cleanupGarmentPreview = action({
  args: {
    failedStorageId: v.id("_storage"),
    chromaKey: v.string(),
    tolerance: v.number(),
  },
  handler: async (ctx, { failedStorageId, chromaKey, tolerance }) => {
    // Clamp tolerance to [18, 110] like the original upstream
    const clampedTolerance = Math.max(18, Math.min(110, tolerance));

    // Download the raw failed-source image
    const failedUrl = await ctx.storage.getUrl(failedStorageId);
    if (!failedUrl) throw new Error("Failed-source image not found");
    const failedResp = await fetch(failedUrl);
    const rawBuffer = Buffer.from(await failedResp.arrayBuffer());

    // Process with user-specified tolerance (non-strict — never throws)
    const { processed, verification } = await processChromaBackground(rawBuffer, chromaKey, clampedTolerance);

    // Upload preview
    const previewUploadUrl = await ctx.storage.generateUploadUrl();
    const previewResp = await fetch(previewUploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: processed,
    });
    const { storageId: previewStorageId } = await previewResp.json();

    return { previewStorageId, verification, tolerance: clampedTolerance };
  },
});
