/**
 * 二维码往返测试：生成 PNG → 自己解码 PNG → 用 jsqr 识别 → 断言内容一致。
 *
 * 这同时验证两件事：
 *  1. qr.ts 里手写的 1bit 灰度 PNG 编码器是合法的（pngjs 能正确解析）
 *  2. 画出来的图案是真能被扫出来的二维码（jsqr 能解出原文）
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderQr, toHalfBlockAscii, qrSummary } from "../extensions/im-relay/qr.ts";
// @ts-expect-error jsqr 没有类型声明，仅测试用
import jsQR from "jsqr";
import { PNG } from "pngjs";
import zlib from "node:zlib";

function decodeQrFromPng(pngBuffer: Buffer): string | null {
  const png = PNG.sync.read(pngBuffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result?.data ?? null;
}

test("生成的 PNG 是合法图片，并且能被解码回原文", () => {
  const url = "https://liteapp.weixin.qq.com/q/7GiRk2?token=pimrelay-demo-123456";
  const rendered = renderQr(url, 8, 3);

  assert.equal(rendered.image.mimeType, "image/png");
  const bytes = Buffer.from(rendered.image.base64, "base64");
  // PNG 签名
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  // 尺寸与 IHDR 一致
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, rendered.image.size);
  assert.equal(png.height, rendered.image.size);

  assert.equal(decodeQrFromPng(bytes), url, "二维码内容必须能被解码回原文");
});

test("PNG 体积极小（二维码是纯黑白块，压缩率极高）", () => {
  const rendered = renderQr("https://liteapp.weixin.qq.com/q/7GiRk2?token=pimrelay-demo-123456", 8, 3);
  const bytes = Buffer.from(rendered.image.base64, "base64");
  assert.ok(bytes.length < 3000, `体积应当很小，实际 ${bytes.length} 字节`);
});

test("长 URL 也能生成并可解码", () => {
  const url = `https://liteapp.weixin.qq.com/q/${"a".repeat(180)}`;
  const rendered = renderQr(url, 6, 3);
  const decoded = decodeQrFromPng(Buffer.from(rendered.image.base64, "base64"));
  assert.equal(decoded, url);
});

test("中文内容也能往返", () => {
  const text = "微信登录：请扫码并确认绑定本机 pi agent";
  const rendered = renderQr(text, 8, 3);
  assert.equal(decodeQrFromPng(Buffer.from(rendered.image.base64, "base64")), text);
});

test("cellSize 影响尺寸但不影响可解码性", () => {
  const url = "https://example.com/login?token=abc";
  const small = renderQr(url, 4, 2);
  const large = renderQr(url, 12, 4);
  assert.ok(large.image.size > small.image.size);
  assert.equal(decodeQrFromPng(Buffer.from(small.image.base64, "base64")), url);
  assert.equal(decodeQrFromPng(Buffer.from(large.image.base64, "base64")), url);
});

test("ASCII 版本用半块字符，行数约为模块数的一半", () => {
  const rendered = renderQr("https://example.com/x", 8, 3);
  const lines = rendered.ascii.split("\n");
  // 33 模块 + 上下各 2 行静默区 → 17 数据行 + 4 静默行 = 21 行左右
  assert.ok(lines.length >= 18 && lines.length <= 26, `实际 ${lines.length} 行`);
  const width = lines[0]!.length;
  for (const line of lines) assert.equal(line.length, width, "每行宽度必须一致");
  assert.ok(/[\u2580\u2584\u2588]/.test(rendered.ascii), "应当包含半块/全块字符");
});

test("ASCII 的黑白分布与矩阵一致（左上定位图案区域应有黑块）", () => {
  const rendered = renderQr("https://example.com/x", 8, 3);
  const lines = rendered.ascii.split("\n").filter((l) => l.trim().length > 0);
  // 静默区为 2 模块 → 每行开头 2 个空格；定位图案是实心黑边，所以接着就是 █
  const firstDataLine = lines[0]!;
  assert.ok(
    firstDataLine.startsWith("  \u2588"),
    `期望静默区后紧跟黑块，实际 ${JSON.stringify(firstDataLine.slice(0, 6))}`,
  );
});

test("内部 PNG 编码路径产出可被 zlib 解压的 IDAT", () => {
  // 直接验证 chunk 结构：签名 + IHDR + IDAT + IEND
  const bytes = Buffer.from(renderQr("https://example.com", 4, 2).image.base64, "base64");
  const types: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = bytes.readUInt32BE(offset + 8 + length);
    types.push(type);
    if (type === "IDAT") {
      assert.doesNotThrow(() => zlib.inflateSync(data), "IDAT 必须是合法的 zlib 流");
    }
    // 校验 CRC
    assert.equal(storedCrc, crc32OfChunk(bytes.subarray(offset + 4, offset + 8 + length)), `${type} chunk 的 CRC 必须正确`);
    offset += 12 + length;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
});

test("qrSummary 不会把整段内容打进日志", () => {
  assert.equal(qrSummary("short"), "short");
  assert.ok(qrSummary("x".repeat(200)).length <= 64);
});

// 测试用 CRC32（与实现独立，避免自我验证）
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32OfChunk(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export { toHalfBlockAscii };
