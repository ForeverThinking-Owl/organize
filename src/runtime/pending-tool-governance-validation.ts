import { isDeepStrictEqual } from "node:util";
import { buildCanonicalToolApprovalMetadata } from "../approvals/tool-approval-policy";
import { toolGateway } from "../tools/tool-gateway";
import { validateToolArguments } from "../tools/tool-schema-validation";
import type { PendingRunSnapshot } from "./pending-run-snapshot";

/** Bind a standalone recovery bundle to the currently registered Tool policy. */
export function assertPendingToolGovernance(
  pending: PendingRunSnapshot
): void {
  if (pending.pendingKind !== "tool_approval") return;
  const approval = pending.pendingToolApproval!.approvalRequest;
  const call = pending.pendingToolApproval!.pendingExec.pendingToolCall;
  const definition = toolGateway.getDefinition(call.toolName);
  if (!definition) {
    throw new Error(`Pending Tool ${call.toolName} is not registered`);
  }

  const available = pending.context.availableTools.filter((tool) => tool.name === call.toolName);
  const expectedView = {
    name: definition.toolName,
    description: definition.description,
    direction: definition.direction,
    riskLevel: definition.riskLevel,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  };
  const normalizedExpectedView = JSON.parse(JSON.stringify(expectedView)) as typeof expectedView;
  if (available.length !== 1 || !isDeepStrictEqual(available[0], normalizedExpectedView)) {
    throw new Error(`Pending Tool ${call.toolName} differs from the current Tool Registry`);
  }

  const argumentErrors = validateToolArguments(call.arguments, definition.inputSchema);
  if (argumentErrors.length > 0) {
    throw new Error(`Pending Tool ${call.toolName} has invalid arguments: ${argumentErrors.join("; ")}`);
  }
  const expectedApproval = buildCanonicalToolApprovalMetadata(definition, call.arguments);
  const actualApproval = {
    stage: approval.stage,
    riskLevel: approval.riskLevel,
    reason: approval.reason,
    proposedArguments: approval.proposedArguments,
    suggestedApproverRole: approval.suggestedApproverRole,
    policy: approval.policy,
  };
  if (!expectedApproval || !isDeepStrictEqual(actualApproval, expectedApproval)) {
    throw new Error(`Pending Tool ${call.toolName} differs from the current approval policy`);
  }
}
