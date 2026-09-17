/**
 * 二维码生成：同一份矩阵同时产出「PNG 图片」和「终端 ASCII」。
 *
 * 为什么自己写 PNG 编码器：
 *  - 二维码是纯黑白 1bit 图，用 1bit 灰度 PNG + zlib 压缩，体积只有 1~2KB，
 *    比 GIF 更安全（所有多模态模型都接受 PNG，GIF 有被拒的风险）。
 *  - 不引入图像库依赖，只依赖 Node 自带的 zlib。
 *
 * 为什么同时产出 ASCII：
 *  - 终端 TUI 渲染不了图片，只能渲染文本；pi-web 这类 Web UI 则能渲染图片。
 *    同一个二维码按界面能力选投递方式，见 index.ts 的 deliverLoginQr。
 */
import { createRequire } from "node:module";
import zlib from "node:zlib";

const nodeRequire = createRequire(import.meta.url);

interface QrCodeInstance {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

type QrCodeFactory = ((typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H") => QrCodeInstance) & {
  /** 默认按 charCode 处理，中文/emoji 会乱码；把 UTF-8 变换挂上去修正。 */
  stringToBytesFuncs?: Record<string, (text: string) => number[]>;
  stringToBytes?: (text: string) => number[];
};

let factory: QrCodeFactory | undefined;

function qrFactory(): QrCodeFactory {
  if (!factory) {
    // qrcode-generator 是 UMD/CJS，用 createRequire 兼容 ESM 与 jiti
    const loaded = nodeRequire("qrcode-generator") as QrCodeFactory;
    // 登录链接虽然总是 ASCII，但接口不应在中文上出错
    const utf8 = loaded.stringToBytesFuncs?.["UTF-8"];
    if (utf8) loaded.stringToBytes = utf8;
    factory = loaded;
  }
  return factory;
}

/** 纠错级别 M：容错约 15%，屏幕扫码场景性价比最高的档位。 */
const EC_LEVEL = "M" as const;

export interface QrImage {
  /** 图片 MIME，UI 直接拼 `data:<mimeType>;base64,<base64>` */
  mimeType: string;
  /** 不含 data URI 前缀的 base64 */
  base64: string;
  /** 像素边长 */
  size: number;
}

export interface QrRender {
  text: string;
  image: QrImage;
  /** 终端 ASCII（半块字符，2 行并作 1 行，宽高比近似正方形） */
  ascii: string;
}

/**
 * 生成二维码。
 * cellSize 越大越清晰、体积越大；400px 左右在手机上是好扫的尺寸。
 */
export function renderQr(text: string, cellSize = 8, marginModules = 3): QrRender {
  const qr = qrFactory()(0, EC_LEVEL);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count * cellSize + marginModules * cellSize * 2;
  const png = encodeMonoPng(size, size, (x, y) => {
    const col = Math.floor(x / cellSize) - marginModules;
    const row = Math.floor(y / cellSize) - marginModules;
    if (row < 0 || col < 0 || row >= count || col >= count) return false;
    return qr.isDark(row, col);
  });

  return {
    text,
    image: { mimeType: "image/png", base64: png.toString("base64"), size },
    ascii: toHalfBlockAscii(qr, 2),
  };
}

/**
 * 半块字符 ASCII 二维码。
 *
 * 终端字符格子高约为宽的 2 倍，所以用 ▀ ▄ █ 把一个字符竖着塞两个模块，
 * 出来的图形是近似正方形的 —— 这是终端里能被手机扫出来的关键。
 */
export function toHalfBlockAscii(qr: QrCodeInstance, marginModules = 2): string {
  const count = qr.getModuleCount();
  const dark = (row: number, col: number): boolean => {
    if (row < 0 || col < 0 || row >= count || col >= count) return false;
    return qr.isDark(row, col);
  };

  const width = count + marginModules * 2;
  const lines: string[] = [];
  for (let i = 0; i < marginModules; i += 1) lines.push(" ".repeat(width));

  for (let row = -marginModules; row < count + marginModules; row += 2) {
    let line = "";
    for (let col = -marginModules; col < count + marginModules; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      // 上黑下白 = ▀，上白下黑 = ▄，全黑 = █，全白 = 空格
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }

  for (let i = 0; i < marginModules; i += 1) lines.push(" ".repeat(width));
  return lines.join("\n");
}

export function qrSummary(text: string): string {
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

/* ------------------------------------------------------------------ */
/* 极简 PNG 编码器（1bit 灰度）                                        */
/* ------------------------------------------------------------------ */

/**
 * 把 isDark(x, y) 描述的位图编码成 1bit 灰度 PNG。
 *
 * PNG 结构：签名 + IHDR + IDAT(zlib) + IEND，每个 chunk 带 CRC32。
 * 1bit 灰度每行先放一个 filter 字节（0 = None），随后 8 个像素打包成 1 字节，高位在前。
 */
function encodeMonoPng(
  width: number,
  height: number,
  isDark: (x: number, y: number) => boolean,
): Buffer {
  const bytesPerRow = 1 + Math.ceil(width / 8);
  const raw = Buffer.alloc(bytesPerRow * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * bytesPerRow;
    raw[rowStart] = 0; // filter type: None
    // 灰度 1bit 中 0 = 黑、1 = 白；先整行填白，再把二维码模块写成黑。
    raw.fill(0xff, rowStart + 1, rowStart + bytesPerRow);
    for (let x = 0; x < width; x += 1) {
      if (!isDark(x, y)) continue;
      const byteIndex = rowStart + 1 + (x >> 3);
      raw[byteIndex] = raw[byteIndex]! & ~(0x80 >> (x & 7));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
