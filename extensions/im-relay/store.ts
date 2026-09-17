/**
 * 会话备注存储：记录每个 IM 会话最近说过什么，
 * 用于 /status 展示与 「谁在跟我说话」的判断。
 */
import { CHAT_MAP_FILE, readJsonFile, writeJsonFile } from "./config.ts";
import { createLogger } from "./log.ts";

const log = createLogger("store");

export interface ChatRecord {
  conversationKey: string;
  channel: string;
  label: string;
  senderId: string;
  lastText: string;
  lastAt: number;
  inboundCount: number;
}

interface ChatMapFile {
  version: 1;
  chats: Record<string, ChatRecord>;
}

const MAX_CHATS = 200;

export class ChatMapStore {
  private data: ChatMapFile = { version: 1, chats: {} };
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly file: string;

  /** 传入自定义路径便于测试；默认写到 <agentDir>/im-relay/state/chat-map.json。 */
  constructor(file: string = CHAT_MAP_FILE) {
    this.file = file;
  }

  load(): void {
    const parsed = readJsonFile<ChatMapFile>(this.file);
    if (parsed && parsed.version === 1 && parsed.chats && typeof parsed.chats === "object") {
      this.data = parsed;
    }
  }

  record(input: {
    conversationKey: string;
    channel: string;
    label: string;
    senderId: string;
    text: string;
  }): void {
    const existing = this.data.chats[input.conversationKey];
    this.data.chats[input.conversationKey] = {
      conversationKey: input.conversationKey,
      channel: input.channel,
      label: input.label,
      senderId: input.senderId,
      lastText: input.text.slice(0, 200),
      lastAt: Date.now(),
      inboundCount: (existing?.inboundCount ?? 0) + 1,
    };
    this.trim();
    this.scheduleSave();
  }

  get(conversationKey: string): ChatRecord | undefined {
    return this.data.chats[conversationKey];
  }

  list(): ChatRecord[] {
    return Object.values(this.data.chats).sort((a, b) => b.lastAt - a.lastAt);
  }

  private trim(): void {
    const entries = Object.entries(this.data.chats);
    if (entries.length <= MAX_CHATS) return;
    entries.sort((a, b) => b[1].lastAt - a[1].lastAt);
    this.data.chats = Object.fromEntries(entries.slice(0, MAX_CHATS));
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 2000);
    // 不要因为这个定时器阻止 pi 退出
    this.saveTimer.unref?.();
  }

  flush(): void {
    try {
      writeJsonFile(this.file, this.data);
    } catch (error) {
      log.warn(`保存会话备注失败: ${String(error)}`);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.flush();
  }
}
