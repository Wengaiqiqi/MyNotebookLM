export type RetrievalCandidate = { chunkId: string; contentHash: string; sourceId?: string; score?: number; [key: string]: unknown };
export function fuseRrf(lists: RetrievalCandidate[][], k = 60): RetrievalCandidate[] { const map = new Map<string, RetrievalCandidate & { score: number }>(); lists.forEach(list => list.forEach((item, i) => { const old = map.get(item.contentHash); map.set(item.contentHash, { ...(old ?? item), score: (old?.score ?? 0) + 1 / (k + i + 1) }); })); return [...map.values()].sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)); }
export function reciprocalRankFusion(lists: RetrievalCandidate[][], limit: number, k = 60): RetrievalCandidate[] { return fuseRrf(lists, k).slice(0, limit); }
export function diversifyHits<T extends RetrievalCandidate & { ordinal?: number }>(hits: T[], limit: number, adjacent = 4): T[] {
  const out: T[] = [];
  const selected = new Set<string>();
  const selectedOrdinals = new Map<string, Set<number>>();
  const canAdd = (hit: T): boolean => {
    if (selected.has(hit.chunkId)) return false;
    if (!hit.sourceId || hit.ordinal === undefined) return true;
    const ordinals = selectedOrdinals.get(hit.sourceId);
    if (!ordinals) return true;
    for (let delta = -adjacent; delta <= adjacent; delta += 1) if (ordinals.has(hit.ordinal + delta)) return false;
    return true;
  };
  const add = (hit: T): void => {
    if (out.length >= limit || selected.has(hit.chunkId)) return;
    out.push(hit);
    selected.add(hit.chunkId);
    if (hit.sourceId && hit.ordinal !== undefined) {
      const ordinals = selectedOrdinals.get(hit.sourceId) ?? new Set<number>();
      ordinals.add(hit.ordinal);
      selectedOrdinals.set(hit.sourceId, ordinals);
    }
  };
  for (const hit of hits) {
    if (out.length >= limit) break;
    if (canAdd(hit)) add(hit);
  }
  for (const hit of hits) {
    if (out.length >= limit) break;
    add(hit);
  }
  return out;
}
