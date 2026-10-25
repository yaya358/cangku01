/**
 * 头像图片规整。
 *
 * 后端只收 PNG（解析器按 PNG 签名校验），但用户手里的图可能是 JPEG、WebP，
 * 尺寸也可能几千像素 —— 让用户自己转格式不现实。
 * 所以在浏览器端统一处理：裁成正方形、缩到 512 以内、编码成 PNG 再上传。
 *
 * 这样服务端逻辑保持简单，用户也能直接选手机里的照片。
 */

/** 头像边长上限（像素）。够清晰，又不至于让头像文件动辄几 MB。 */
const AVATAR_SIZE = 512;

/** 超过这个体积的原始文件直接拒绝，避免把浏览器内存吃爆。 */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export class AvatarError extends Error {}

/** 把任意图片文件转成正方形 PNG。 */
export async function toAvatarPng(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new AvatarError('请选一张图片（PNG / JPEG / WebP）');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new AvatarError('图片太大了，请选 20MB 以内的');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarError('这张图片读不出来，换一张试试');
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sourceX = Math.floor((bitmap.width - side) / 2);
    const sourceY = Math.floor((bitmap.height - side) / 2);
    const target = Math.min(AVATAR_SIZE, side);

    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;

    const context = canvas.getContext('2d');
    if (!context) throw new AvatarError('当前浏览器不支持图片处理');

    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, sourceX, sourceY, side, side, 0, 0, target, target);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (!blob) throw new AvatarError('图片转换失败');
    return blob;
  } finally {
    bitmap.close();
  }
}
