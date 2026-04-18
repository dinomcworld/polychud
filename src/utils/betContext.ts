const TTL_MS = 10 * 60 * 1000;

type Entry = {
  channelId: string;
  messageId: string;
  expiresAt: number;
};

const store = new Map<string, Entry>();

function key(userId: string, conditionId: string, outcome: string): string {
  return `${userId}:${conditionId}:${outcome}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

export function rememberMarketMessage(
  userId: string,
  conditionId: string,
  outcome: string,
  channelId: string,
  messageId: string,
): void {
  sweep();
  store.set(key(userId, conditionId, outcome), {
    channelId,
    messageId,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function takeMarketMessage(
  userId: string,
  conditionId: string,
  outcome: string,
): { channelId: string; messageId: string } | null {
  sweep();
  const k = key(userId, conditionId, outcome);
  const entry = store.get(k);
  if (!entry) return null;
  store.delete(k);
  return { channelId: entry.channelId, messageId: entry.messageId };
}
