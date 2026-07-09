// ============================================================================
// Actor Registry
// v0.5.0: organization actor discovery
// ============================================================================

export interface RegisteredActor {
  actorId: string;
  role: string;
  skills: string[];
  responsibility?: string;
}

export class ActorRegistry {
  private actors = new Map<string, RegisteredActor>();

  register(actor: RegisteredActor): void {
    this.actors.set(actor.actorId, actor);
  }

  unregister(actorId: string): void {
    this.actors.delete(actorId);
  }

  get(actorId: string): RegisteredActor | undefined {
    return this.actors.get(actorId);
  }

  list(): RegisteredActor[] {
    return Array.from(this.actors.values());
  }

  clear(): void {
    this.actors.clear();
  }
}

export const actorRegistry = new ActorRegistry();
