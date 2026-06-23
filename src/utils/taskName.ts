export const MAX_TASK_NAME_LENGTH = 40;

export const normalizeTaskName = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, MAX_TASK_NAME_LENGTH) : undefined;
};

export const formatDefaultTaskName = (id: string) =>
  `任务 #${id.slice(0, 6).toUpperCase()}`;

export const getTaskDisplayName = (task: { id: string; name?: string }) =>
  normalizeTaskName(task.name) || formatDefaultTaskName(task.id);
