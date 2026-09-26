export interface GroupableMessage {
  id: string;
  senderType?: string;
  senderId?: string;
  messageType?: string;
  createdAt?: string;
}

export interface MessageGroupState {
  isFirstInGroup: boolean;
  showAvatar: boolean;
  showDayDivider: boolean;
  dayKey: string;
}

/** Oldest-first. A row continues the previous group only for the same sender, the same local day, and when neither row is a system message or marked standalone. */
export function computeMessageGrouping(
  messages: readonly GroupableMessage[],
  options: { timeZone?: string; standaloneIds?: ReadonlySet<string> } = {},
): Map<string, MessageGroupState> {
  const states = new Map<string, MessageGroupState>();
  let previousDay: string | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const previous = index > 0 ? messages[index - 1] : null;
    const dayKey = localDayKey(message.createdAt, options.timeZone);
    const showDayDivider = previousDay === null || dayKey !== previousDay;
    previousDay = dayKey;
    const continues = previous !== null
      && !showDayDivider
      && !isSystem(message)
      && !isSystem(previous)
      && !options.standaloneIds?.has(message.id)
      && !options.standaloneIds?.has(previous.id)
      && sameSender(message, previous);
    states.set(message.id, {
      isFirstInGroup: !continues,
      showAvatar: !continues && !isSystem(message),
      showDayDivider,
      dayKey,
    });
  }
  return states;
}

export function localDayKey(createdAt: string | undefined, timeZone?: string): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
}

function sameSender(a: GroupableMessage, b: GroupableMessage): boolean {
  return Boolean(a.senderId) && a.senderType === b.senderType && a.senderId === b.senderId;
}

function isSystem(message: GroupableMessage): boolean {
  return message.messageType === "system";
}

export function hiddenSystemIds(
  messages: readonly { id: string; messageType?: string }[],
  expanded: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  let index = 0;
  while (index < messages.length) {
    if (messages[index]?.messageType !== "system") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (messages[end]?.messageType === "system") end += 1;
    const head = messages[index];
    if (head && end - index > 1 && !expanded.has(head.id)) {
      for (let cursor = index + 1; cursor < end; cursor += 1) {
        const id = messages[cursor]?.id;
        if (id) hidden.add(id);
      }
    }
    index = end;
  }
  return hidden;
}

export function systemRunHeads(messages: readonly { id: string; messageType?: string }[]): Map<string, number> {
  const heads = new Map<string, number>();
  let index = 0;
  while (index < messages.length) {
    if (messages[index]?.messageType !== "system") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (messages[end]?.messageType === "system") end += 1;
    const count = end - index;
    if (count > 1) heads.set(messages[index].id, count);
    index = end;
  }
  return heads;
}
