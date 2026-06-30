export interface ProjectScopedTestActor {
  actorId: string;
  projectId: string;
  partitionId?: string;
}

export interface CreateProjectScopedTestActorOptions {
  actorId: string;
  projectId?: string;
  partitionId?: string;
}

export interface CreateProjectScopedActorHeadersOptions {
  actorHeader?: string;
  projectHeader?: string;
  partitionHeader?: string;
  extraHeaders?: Record<string, string>;
}

export function createProjectScopedTestActor(
  options: CreateProjectScopedTestActorOptions
): ProjectScopedTestActor {
  return {
    actorId: options.actorId,
    projectId: options.projectId ?? 'p0',
    ...(options.partitionId ? { partitionId: options.partitionId } : {}),
  };
}

export function createProjectScopedActorHeaders(
  actor: ProjectScopedTestActor,
  options: CreateProjectScopedActorHeadersOptions = {}
): Record<string, string> {
  return {
    [options.actorHeader ?? 'x-actor-id']: actor.actorId,
    [options.projectHeader ?? 'x-project-id']: actor.projectId,
    ...(actor.partitionId
      ? { [options.partitionHeader ?? 'x-partition-id']: actor.partitionId }
      : {}),
    ...options.extraHeaders,
  };
}

export function createProjectMembership(
  actors: readonly ProjectScopedTestActor[]
): Record<string, string[]> {
  const membership = new Map<string, Set<string>>();

  for (const actor of actors) {
    const projects = membership.get(actor.actorId) ?? new Set<string>();
    projects.add(actor.projectId);
    membership.set(actor.actorId, projects);
  }

  return Object.fromEntries(
    Array.from(membership.entries()).map(([actorId, projects]) => [
      actorId,
      Array.from(projects).sort(),
    ])
  );
}
