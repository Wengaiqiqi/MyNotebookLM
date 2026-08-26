export type SessionOwner = Readonly<{ projectId: string; userId: string }>;

/** Main-process-only registry of active chat AbortControllers, keyed by opaque request ID. */
export class ChatSessionRegistry {
  private readonly active = new Map<string, { controller: AbortController; owner: SessionOwner }>();

  /** Returns the owning controller so aliases (e.g. conversation keys) can share one abort source. */
  register(requestId: string, owner: SessionOwner): AbortController {
    const controller = new AbortController();
    this.active.set(requestId, { controller, owner });
    return controller;
  }

  isActive(requestId: string): boolean {
    return this.active.has(requestId);
  }

  /** Only the owning project/user may cancel; false on cross-owner or unknown IDs. */
  cancel(requestId: string, owner: SessionOwner): boolean {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    if (!this.sameOwner(entry.owner, owner)) return false;
    entry.controller.abort();
    return true;
  }

  complete(requestId: string, owner: SessionOwner): void {
    const entry = this.active.get(requestId);
    if (!entry) return;
    if (!this.sameOwner(entry.owner, owner)) return;
    this.active.delete(requestId);
  }

  /** Returns the owning conversation key of an active request, if any. */
  findConversationKey(conversationKey: string): string | undefined {
    return this.active.has(conversationKey) ? conversationKey : undefined;
  }

  activeRequests(): string[] {
    return [...this.active.keys()];
  }

  private sameOwner(a: SessionOwner, b: SessionOwner): boolean {
    return a.projectId === b.projectId && a.userId === b.userId;
  }
}
