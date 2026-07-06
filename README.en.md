# organize — Self-Operating Organization

> foreverthinking | Single Actor Kernel Demo — Verified ✅

## Overview

organize is an AI-Agent system for the future of organizational operation. Currently at MVP Phase 1: **Single Actor Minimum Closed Loop**.

## Quick Start

```bash
npm install
npm run demo
```

## Project Structure

```
organize/
  docs/                   # Design documentation
  src/
    core/types/           # Core type definitions
      actor.ts            # ActorProfile, ActorContext, ToolForActor
      actor-decision.ts   # ActorDecision (discriminated union)
      skill.ts            # Skill, SkillStep
      tool.ts             # ToolDefinition, ToolCallRequest, ToolObservation
      approval.ts         # ApprovalRequest, ApprovalDecision
      memory.ts           # MemoryEntry, MemoryCandidate
      trace.ts            # TraceEvent, ActorRunTrace

    runtime/              # Core runtime
      actor-context-builder.ts   # Builds ActorContext
      actor-runtime.ts           # Actor Kernel main executor
      skill-runtime.ts           # Skill step executor
      actor-decision-engine.ts   # Decision engine (Mock LLM)
      actor-decision-executor.ts # Unified ToolCall pipeline

    policy/
      policy-engine.ts    # Permission & approval policy engine

    tools/
      tool-gateway.ts     # Tool gateway (routing + execution)
      mock-tools.ts       # 3 Mock Tool implementations

    approvals/
      approval-gate.ts    # Approval gate (supports pause/resume)

    memory/
      memory-service.ts   # Memory service

    trace/
      trace-logger.ts     # Trace logger

    examples/
      customer-after-sales.demo.ts  # Verification demo
```

## MVP Acceptance — 13/13 ✅

| # | Criteria | Status |
|---|----------|--------|
| 1 | ActorContext correctly built | ✅ |
| 2 | Actor reads its own memory | ✅ |
| 3 | Actor only sees authorized Tools | ✅ |
| 4 | Skill executes step by step | ✅ |
| 5 | query_order_info invoked | ✅ |
| 6 | query_ticket_history invoked | ✅ |
| 7 | Actor generates structured judgment | ✅ |
| 8 | Actor generates create_ticket ToolCall | ✅ |
| 9 | ApprovalGate identifies urgent tickets require approval | ✅ |
| 10 | ToolGateway executes create_ticket after approval | ✅ |
| 11 | Actor outputs final_output | ✅ |
| 12 | memory_candidate generated | ✅ |
| 13 | Trace records complete execution chain | ✅ |

## Roadmap

- Integrate real LLM
- Integrate real database
- Expand to Scene (multi-Actor orchestration)
- Add more Tool types (SQL, RPA, MCP)
