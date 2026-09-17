/**
 * 纯逻辑单元测试：不依赖 pi 运行时，可直接 `node --test test/*.test.ts` 跑。
 *
 * 覆盖：文本分段 / markdown 清理 / 去重 / 限流 / OneBot11 消息段解析 /
 *       iLink 消息解析 / 配置合并。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { segmentText, stripMarkdown, formatReply, DedupeSet, RateLimiter } from "../extensions/im-relay/text.ts";
import {
  asSegments,
  segmentsToText,
  isMentioned,
  extractImages,
  stripSelfMentions,
} from "../extensions/im-relay/channels/onebot11.ts";
import { parseInbound, messageKey } from "../extensions/im-relay/channels/ilink-client.ts";
import { ItemType, packVersion } from "../extensions/im-relay/channels/ilink-types.ts";
import { parseCommand } from "../extensions/im-relay/router.ts";

test("segmentText 短文本不切分", () => {
  assert.deepEqual(segmentText("hello", 100), ["hello"]);
});

test("segmentText 超长文本按上限切分且不丢内容", () => {
  const source = Array.from({ length: 40 }, (_, i) => `这是第 ${i} 行内容，用于测试分段。`).join("\n");
  const chunks = segmentText(source, 120);
  assert.ok(chunks.length > 1, "应当被切成多段");
  for (const chunk of chunks) assert.ok(chunk.length <= 120, `分段超长: ${chunk.length}`);
  assert.equal(chunks.join("\n").replace(/\s+/g, ""), source.replace(/\s+/g, ""));
});

test("segmentText 优先在空行断开", () => {
  const source = `${"a".repeat(80)}\n\n${"b".repeat(80)}`;
  const chunks = segmentText(source, 100);
  assert.equal(chunks[0], "a".repeat(80));
});

test("stripMarkdown 去掉常见标记但保留代码块内容", () => {
  const input = [
    "# 标题",
    "",
    "**粗体** 和 *斜体* 还有 `code`",
    "",
    "- 列表项",
    "> 引用",
    "",
    "```ts",
    "const a = 1; // **不处理**",
    "```",
    "",
    "[链接](https://example.com)",
  ].join("\n");
  const output = stripMarkdown(input);
  assert.ok(output.includes("标题"));
  assert.ok(!output.includes("**粗体**"));
  assert.ok(output.includes("粗体 和 斜体 还有 code"));
  assert.ok(output.includes("• 列表项"));
  assert.ok(output.includes("引用"));
  assert.ok(output.includes("const a = 1; // **不处理**"), "代码块内容必须原样保留");
  assert.ok(output.includes("链接 (https://example.com)"));
});

test("formatReply 先清 markdown 再分段", () => {
  const chunks = formatReply(`# 标题\n\n${"x".repeat(200)}`, 60);
  assert.ok(chunks.length >= 3);
  assert.ok(!chunks.join("").includes("#"));
});

test("DedupeSet 识别重复", () => {
  const set = new DedupeSet(10);
  assert.equal(set.add("a"), true);
  assert.equal(set.add("a"), false);
  assert.equal(set.add("b"), true);
});

test("RateLimiter 按窗口限流", () => {
  const limiter = new RateLimiter(3);
  assert.equal(limiter.allow("u"), true);
  assert.equal(limiter.allow("u"), true);
  assert.equal(limiter.allow("u"), true);
  assert.equal(limiter.allow("u"), false);
  assert.equal(limiter.allow("other"), true);
});

test("OneBot11 消息段转文本", () => {
  const message = [
    { type: "at", data: { qq: "999", name: "bot" } },
    { type: "text", data: { text: " 帮我看下 " } },
    { type: "image", data: {} },
    { type: "face", data: {} },
    { type: "reply", data: { text: "被引用的内容" } },
  ];
  const text = segmentsToText(message, "999");
  assert.ok(text.includes("帮我看下"));
  assert.ok(text.includes("[图片]"));
  assert.ok(text.includes("[表情]"));
  assert.ok(text.includes("被引用的内容"));
  assert.ok(!text.includes("@999"), "@自己不应出现在正文里");
});

test("OneBot11 @ 检测与自我提及剥离", () => {
  const message = asSegments([
    { type: "at", data: { qq: "123" } },
    { type: "text", data: { text: "hello" } },
  ]);
  assert.equal(isMentioned(message, "123"), true);
  assert.equal(isMentioned(message, "456"), false);
  assert.equal(stripSelfMentions(message, "123").length, 1);
  assert.equal(stripSelfMentions(message, "456").length, 2);
});

test("OneBot11 图片段提取", () => {
  const images = extractImages(asSegments([
    { type: "text", data: { text: "x" } },
    { type: "image", data: { file: "a.jpg" } },
  ]));
  assert.equal(images.length, 1);
  assert.equal(images[0]?.file, "a.jpg");
});

test("iLink 消息解析：文本 + 图片 + 语音转写 + 引用", () => {
  const parsed = parseInbound({
    item_list: [
      { type: ItemType.TEXT, text_item: { text: "看下这个" } },
      { type: ItemType.IMAGE, image_item: { media: { encrypt_query_param: "q" } } },
      { type: ItemType.VOICE, voice_item: { text: "语音转写内容" } },
      { type: ItemType.TEXT, text_item: { text: "然后呢" }, ref_msg: { title: "之前的消息" } },
    ],
  });
  assert.ok(parsed.text.includes("看下这个"));
  assert.ok(parsed.text.includes("然后呢"));
  assert.ok(parsed.text.includes("之前的消息"));
  assert.equal(parsed.images.length, 1);
  assert.deepEqual(parsed.voiceTexts, ["语音转写内容"]);
});

test("iLink 去重键优先用 message_id", () => {
  assert.equal(messageKey({ message_id: 42, client_id: "c" }), "42");
  assert.equal(messageKey({ client_id: "c" }), "c");
  assert.equal(messageKey({}).length, 32);
});

test("iLink 客户端版本号打包", () => {
  assert.equal(packVersion("2.4.6"), String((2 << 16) | (4 << 8) | 6));
  assert.equal(packVersion("0.2.4"), String((2 << 8) | 4));
});

test("parseCommand 只认斜杠开头的英文命令", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status", args: "" });
  assert.deepEqual(parseCommand("/resume 3"), { name: "resume", args: "3" });
  assert.deepEqual(parseCommand("  /model deepseek/x  "), { name: "model", args: "deepseek/x" });
  assert.equal(parseCommand("你好"), undefined);
  assert.equal(parseCommand("/中文"), undefined);
  assert.equal(parseCommand("帮我改 /etc/hosts"), undefined);
});
