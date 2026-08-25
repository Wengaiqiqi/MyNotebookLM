import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { DocumentBlock } from "../types";

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });
const arr = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const texts = (node: unknown): string[] => {
  if (!node || typeof node !== "object") return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (k === "hlinkClick") continue;
      if (k === "t") walk(x); else walk(x);
    }
  };
  walk(node); return out.map((x) => x.trim()).filter(Boolean);
};

export async function parsePptx(input: Uint8Array | ArrayBuffer): Promise<DocumentBlock[]> {
  const zip = await JSZip.loadAsync(input);
  const raw = async (name: string): Promise<string> => zip.file(name)!.async("string");
  const read = async (name: string): Promise<unknown> => xml.parse(await raw(name));
  const relationshipTarget = async (name: string, type: string): Promise<string | undefined> => {
    const relsName = name.replace(/([^/]+)$/, "_rels/$1.rels");
    if (!zip.file(relsName)) return undefined;
    const relationships = await read(relsName) as any;
    const rel = arr(relationships?.Relationships?.Relationship).find((item: any) => String(item?.["@_Type"] ?? "").endsWith(type.replace(/^\//, "")));
    if (!rel?.["@_Target"]) return undefined;
    const target = String(rel["@_Target"]);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.includes("\\")) return undefined;
    const base = name.slice(0, name.lastIndexOf("/"));
    const parts = (base + "/" + target).split("/"); const safe: string[] = [];
    for (const part of parts) { if (!part || part === ".") continue; if (part === "..") { if (!safe.length) return undefined; safe.pop(); } else safe.push(part); }
    const resolved = safe.join("/");
    return resolved.startsWith("ppt/") ? resolved : undefined;
  };
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const blocks: DocumentBlock[] = [];
  for (const [index, target] of slideNames.entries()) {
    const slide = await read(target) as any; const values = texts(slide);
    const noteName = await relationshipTarget(target, "notesSlide");
    const note = noteName && zip.file(noteName) ? texts(await read(noteName)) : [];
    const title = values[0]; const body = [...values.slice(1), ...note].join("\n");
    const locator = { kind: "slide" as const, slide: index + 1 };
    if (title) blocks.push({ kind: "heading", text: title, locator });
    if (body) blocks.push({ kind: "paragraph", text: body, locator });
  }
  return blocks;
}
