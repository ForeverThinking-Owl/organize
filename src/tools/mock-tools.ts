// ============================================================================
// Mock Tools — 第一版三个 Tool 的 Mock 实现
// ============================================================================

import { ToolCallRequest, ToolObservation, ToolDefinition } from "../core/types/tool";

/**
 * Mock Tool 实现接口
 */
export interface MockToolExecutor {
  execute(request: ToolCallRequest): Promise<ToolObservation>;
}

/**
 * query_order_info — 查询订单信息
 */
export const queryOrderInfoTool: ToolDefinition = {
  toolName: "query_order_info",
  displayName: "查询订单信息",
  description: "查询订单、支付、物流和商品信息",
  direction: "read",
  riskLevel: "low",
  inputSchema: {
    type: "object",
    required: ["order_id"],
    properties: {
      order_id: { type: "string" },
    },
  },
};

export class QueryOrderInfoExecutor implements MockToolExecutor {
  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    const orderId = request.arguments.order_id as string;
    return {
      toolCallId: request.toolCallId,
      toolName: "query_order_info",
      status: "success",
      data: {
        orderId,
        product: "SCANNER-X1",
        productName: "无线扫码枪 SCANNER-X1",
        purchaseDate: "2026-05-15",
        warrantyMonths: 12,
        warrantyStatus: "in_warranty",
        status: "delivered",
        price: 680,
        customerId: "C001",
      },
      executedAt: new Date().toISOString(),
    };
  }
}

/**
 * query_ticket_history — 查询历史工单
 */
export const queryTicketHistoryTool: ToolDefinition = {
  toolName: "query_ticket_history",
  displayName: "查询工单历史",
  description: "查询客户历史工单记录",
  direction: "read",
  riskLevel: "low",
  inputSchema: {
    type: "object",
    required: ["customer_id"],
    properties: {
      customer_id: { type: "string" },
    },
  },
};

export class QueryTicketHistoryExecutor implements MockToolExecutor {
  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    const customerId = request.arguments.customer_id as string;
    return {
      toolCallId: request.toolCallId,
      toolName: "query_ticket_history",
      status: "success",
      data: {
        customerId,
        totalTickets: 2,
        tickets: [
          {
            ticketId: "TK-001",
            type: "technical",
            status: "resolved",
            summary: "扫码枪蓝牙连接不稳定",
            createdAt: "2026-06-10",
          },
          {
            ticketId: "TK-002",
            type: "after_sales",
            status: "open",
            summary: "客户询问扫码枪使用手册",
            createdAt: "2026-06-20",
          },
        ],
      },
      executedAt: new Date().toISOString(),
    };
  }
}

/**
 * create_ticket — 创建工单
 */
export const createTicketTool: ToolDefinition = {
  toolName: "create_ticket",
  displayName: "创建工单",
  description: "创建新的工单",
  direction: "write",
  riskLevel: "medium",
  inputSchema: {
    type: "object",
    required: ["title", "type", "priority"],
    properties: {
      title: { type: "string" },
      type: { type: "string" },
      priority: { type: "string" },
      description: { type: "string" },
      order_id: { type: "string" },
      customer_id: { type: "string" },
    },
  },
  approvalPolicy: {
    beforeCall: {
      requiredWhen: [
        {
          field: "priority",
          operator: "==",
          value: "urgent",
        },
      ],
      allowModifyArguments: true,
      allowReject: true,
      allowComment: true,
    },
  },
};

export class CreateTicketExecutor implements MockToolExecutor {
  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    return {
      toolCallId: request.toolCallId,
      toolName: "create_ticket",
      status: "success",
      data: {
        ticketId: `TK-${Date.now()}`,
        title: request.arguments.title,
        type: request.arguments.type,
        priority: request.arguments.priority,
        status: "open",
        createdAt: new Date().toISOString(),
      },
      executedAt: new Date().toISOString(),
    };
  }
}
