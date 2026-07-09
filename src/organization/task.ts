// ============================================================================
// Organization Task
// ============================================================================

export type TaskStatus = "created" | "assigned" | "running" | "completed" | "failed";

export interface Task {
  taskId: string;
  title: string;
  description?: string;
  createdBy: string;
  assignedTo?: string;
  status: TaskStatus;
  context?: Record<string, unknown>;
  createdAt: string;
}

export class TaskManager {
  private tasks = new Map<string, Task>();

  create(input: Omit<Task, "taskId" | "status" | "createdAt">): Task {
    const task: Task = {
      ...input,
      taskId: `task_${Date.now()}`,
      status: "created",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  assign(taskId: string, actorId: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.assignedTo = actorId;
    task.status = "assigned";
    return task;
  }

  complete(taskId: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = "completed";
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }
}

export const taskManager = new TaskManager();
