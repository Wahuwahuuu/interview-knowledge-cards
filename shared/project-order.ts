import { z } from 'zod';
import { AppError, type Project } from './model';

export const projectOrderRequestSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  project_ids: z.array(z.string().min(1).max(128)).max(1000),
});
export type ProjectOrderRequest = z.infer<typeof projectOrderRequestSchema>;
export type ProjectOrderResult = { revision: number; projects: Project[] };

export function orderedProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function moveProject(ids: string[], source: string, target: string, after = false): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

export function applyProjectOrder(projects: Project[], ids: string[], now = new Date().toISOString()): Project[] {
  const byId = new Map(projects.map(project => [project.id, project]));
  if (ids.length !== projects.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) {
    throw new AppError(422, '项目列表已变化或排序不完整，请刷新后重新调整', 'INVALID_PROJECT_ORDER');
  }
  return ids.map((id, sort_order) => {
    const project = byId.get(id)!;
    return project.sort_order === sort_order ? project : { ...project, sort_order, revision: project.revision + 1, updated_at: now };
  });
}
