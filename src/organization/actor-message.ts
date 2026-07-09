// ============================================================================
// Actor Message
// ============================================================================

export type ActorMessageType = "task_request" | "task_response" | "information";

export interface ActorMessage {
  messageId: string;
  fromActor: string;
  toActor: string;
  type: ActorMessageType;
  payload: unknown;
  createdAt: string;
}

export function createActorMessage(
  fromActor: string,
  toActor: string,
  type: ActorMessageType,
  payload: unknown
): ActorMessage {
  return {
    messageId: `msg_${Date.now()}`,
    fromActor,
    toActor,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}
