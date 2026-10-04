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
  it("accepts one complete JSON map surrounded by commentary without treating braces inside strings as structure", () => {
    const map = normalizeMindMapOutput('生成结果如下：\n```json\n' + JSON.stringify({ root: { title: 'Topic {x} "quoted"', refs: ["[CHUNK:chunk-a]"] } }) + '\n```\n已生成。', new Set(["chunk-a"]));
    expect(map.root.title).toBe('Topic {x} "quoted"');
    expect(map.root.refs).toEqual(["chunk-a"]);
    expect(() => normalizeMindMapOutput('{"root":{"title":"A"}}\n{"root":{"title":"B"}}', new Set())).toThrow(/exactly one/);
  });
  it("repairs the JSON mistakes models make when copying Word text", () => {
    const raw = '<think>先看{资料}</think>\n{"root":{"title":"项目"概览"","summary":"第一行\n第二行\t表格单元",' +
      '"keyPoints":["要点一",],"refs":["chunk-a"],"children":[{\u201ctitle\u201d:\u201c风险\u201d,"refs":[],}],}}';
    const map = normalizeMindMapOutput(raw, new Set(["chunk-a"]));
    expect(map.root).toMatchObject({ title: '项目"概览"', summary: "第一行\n第二行\t表格单元", keyPoints: ["要点一"], refs: ["chunk-a"] });
    expect(map.root.children[0]!.title).toBe("风险");
  });
  it("never completes a truncated map", () => {
    expect(() => normalizeMindMapOutput('{"root":{"title":"A","children":[{"title":"B"', new Set())).toThrow(/exactly one/);
  });
  it("normalizes nullable optional fields, an unwrapped tree and verified UUID casing", () => {
    const id = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const map = normalizeMindMapOutput(JSON.stringify({ title: "Topic", summary: null, keyPoints: null, children: null,
      refs: [`CHUNK:${id.toUpperCase()}`, id] }), new Set([id]));
    expect(map.root).toMatchObject({ summary: "", children: [], keyPoints: [], refs: [id] });
    expect(() => normalizeMindMapOutput('{"title":"Topic","refs":["[CHUNK:foreign]"]}', new Set([id]))).toThrow(/unknown source/);
  });
});
