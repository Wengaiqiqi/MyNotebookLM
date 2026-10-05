import JSZip from "jszip";

/** Office files are capped at 100 MiB compressed; this bounds what they may expand to. */
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** Load an Office archive, rejecting zip bombs from the central directory before inflating anything. */
export async function loadBoundedZip(input: Uint8Array | ArrayBuffer, limit = MAX_UNCOMPRESSED_BYTES): Promise<JSZip> {
  const zip = await JSZip.loadAsync(input);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
    if (total > limit) throw Object.assign(new Error("archive expands beyond the size limit"), { code: "UNSAFE_INPUT" });
  }
  return zip;
}
