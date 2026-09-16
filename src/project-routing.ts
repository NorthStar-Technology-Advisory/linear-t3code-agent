import type { RunnerProject } from "./runner.js";
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
export type ProjectQuery = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
export async function projectTitle(query: ProjectQuery, projectId: string | undefined): Promise<string> {
  const correction = 'Configure the Linear project label group "T3Code project" with exactly one selected child whose name matches a T3Code project title, then send resume.';
  if (!projectId) throw new Error(`This issue has no Linear project. ${correction}`);
  type Label = { id: string; name: string; isGroup: boolean; parent: { id: string } | null };
  const read = async (selected: boolean) => {
    const labels: Label[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      const selection = 'nodes { id name isGroup parent { id } } pageInfo { hasNextPage endCursor }';
      const data = await query<{ projectLabels?: Connection<Label>; project?: { labels: Connection<Label> } | null }>(selected
        ? `query BridgeProjectLabels($id: String!, $after: String) { project(id: $id) { labels(first: 100, after: $after) { ${selection} } } }`
        : `query BridgeProjectGroups($after: String) { projectLabels(first: 100, after: $after) { ${selection} } }`, { id: projectId, after });
      const connection = selected ? data.project?.labels : data.projectLabels;
      if (!connection) throw new Error(`Linear project labels are unavailable. ${correction}`);
      labels.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return labels;
      after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error("Linear project label pagination did not advance; restore access and send resume.");
      cursors.add(after);
    } while (true);
  };
  const groups = (await read(false)).filter(label => label.isGroup && label.name === "T3Code project");
  if (groups.length !== 1) throw new Error(`Found ${groups.length} groups named "T3Code project"; exactly one is required. ${correction}`);
  const selected = (await read(true)).filter(label => !label.isGroup && label.parent?.id === groups[0]!.id);
  if (selected.length !== 1) throw new Error(`Found ${selected.length} selected T3Code project labels; exactly one is required. ${correction}`);
  return selected[0]!.name;
}

export function matchProject(projects: RunnerProject[], title: string): RunnerProject {
  const matches = projects.filter(p => p.deletedAt === null && p.title === title);
  if (matches.length === 0) throw new Error(`No active T3Code project has the exact title "${title}". Correct the label or project title, then send resume.`);
  if (matches.length > 1) throw new Error(`Multiple T3Code projects have title "${title}": ${matches.map(p => p.workspaceRoot).join(", ")}. Rename them to unique titles, correct the label, then send resume.`);
  return matches[0]!;
}
