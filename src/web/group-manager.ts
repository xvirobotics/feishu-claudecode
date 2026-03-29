/**
 * Server-side group manager: stores groups of bots for group chat.
 * Groups are stored in-memory (ephemeral) — they can be recreated easily.
 */

export interface ChatGroup {
  id: string;
  name: string;
  members: string[];   // bot names
  createdAt: number;
}

export class GroupManager {
  private groups = new Map<string, ChatGroup>();

  create(name: string, members: string[]): ChatGroup {
    const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const group: ChatGroup = { id, name, members, createdAt: Date.now() };
    this.groups.set(id, group);
    return group;
  }

  get(id: string): ChatGroup | undefined {
    return this.groups.get(id);
  }

  delete(id: string): boolean {
    return this.groups.delete(id);
  }

  list(): ChatGroup[] {
    return Array.from(this.groups.values());
  }
}
