import { uid } from "./model.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 1600;
const QUALITY = 0.82;

export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name || "");
}

function canvasToBlob(canvas, type, quality, timeout = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeout);
    canvas.toBlob(
      (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(blob);
      },
      type,
      quality
    );
  });
}

async function loadImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await Promise.race([
        createImageBitmap(file, { imageOrientation: "from-image" }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("image decoder timeout")), 1200)
        )
      ]);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close()
      };
    } catch {
      // Fall through to the <img> decoder for browsers without HEIC/AVIF support.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("这张照片的格式暂时读不出来，请换成 JPG 或 PNG。"));
      element.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url)
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function compressPhoto(file) {
  if (!isImageFile(file)) throw new Error("只能添加图片文件。");
  if (file.size > MAX_FILE_BYTES) throw new Error("这张照片超过 25 MB，换一张小一点的吧。");

  const decoded = await loadImageSource(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("照片尺寸读取失败。");

    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("浏览器无法处理这张照片。");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded.source, 0, 0, width, height);

    let blob = await canvasToBlob(canvas, "image/webp", QUALITY);
    let type = "image/webp";
    if (!blob) {
      blob = await canvasToBlob(canvas, "image/jpeg", QUALITY);
      type = "image/jpeg";
    }
    if (!blob) throw new Error("照片压缩失败，请换一张试试。");

    return {
      blob,
      type,
      width,
      height,
      name: file.name || "photo"
    };
  } finally {
    decoded.cleanup();
  }
}

export function makePhoto(compressed) {
  return {
    id: uid("photo"),
    blob: compressed.blob,
    type: compressed.type,
    width: compressed.width,
    height: compressed.height,
    name: compressed.name || "photo",
    createdAt: new Date().toISOString()
  };
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("照片读取失败"));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("照片数据格式不正确");
  const type = match[1] || "image/jpeg";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";

  if (!isBase64) {
    return new Blob([decodeURIComponent(payload)], { type });
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

export function photoSize(photo) {
  return photo?.blob?.size || 0;
}
