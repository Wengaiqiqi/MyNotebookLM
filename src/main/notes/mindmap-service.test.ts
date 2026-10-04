import { describe, expect, it } from "vitest";
import { normalizeMindMapOutput } from "./mindmap-service";
import { flattenMindMap, mindMapPath } from "../../shared/mindmaps";

describe("mind map model output", () => {
  it("assigns deterministic IDs, drops executable fields and deduplicates verified references", () => {
    const map = normalizeMindMapOutput('```json\n' + JSON.stringify({ root: {
      title: '<img src=x onerror="alert(1)">', id: "model-id", dangerouslySetInnerHTML: "<script>x</script>", style: { color: "red" },
      refs: ["chunk-a", "chunk-a"], children: [{ title: "Child", href: "javascript:x" }]
    } }) + '\n```', new Set(["chunk-a"]));
    expect(map.root.id).toBe("node-0");
    expect(map.root.refs).toEqual(["chunk-a"]);
    expect(map.root).not.toHaveProperty("dangerouslySetInnerHTML");
    expect(map.root).not.toHaveProperty("style");
    expect(map.root.children[0]).not.toHaveProperty("href");
    expect(flattenMindMap(map.root).map((node) => node.id)).toEqual(["node-0", "node-0-0"]);
    expect(mindMapPath(map.root, "node-0-0").map((node) => node.id)).toEqual(["node-0", "node-0-0"]);
  });
  it("rejects unknown provenance, empty titles and excessive nesting", () => {
    expect(() => normalizeMindMapOutput('{"root":{"title":"A","refs":["foreign"]}}', new Set())).toThrow(/unknown source/);
    expect(() => normalizeMindMapOutput('{"root":{"title":" "}}', new Set())).toThrow();
    const nested = (depth: number): unknown => ({ title: "A", children: depth ? [nested(depth - 1)] : [] });
    expect(() => normalizeMindMapOutput(JSON.stringify({ root: nested(17) }), new Set())).toThrow(/too large/);
  });
});
