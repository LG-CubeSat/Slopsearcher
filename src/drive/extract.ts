import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import readXlsxFile from "read-excel-file/node";

export function validateZip(data: Buffer, maxBytes: number): void {
  let size = 0;
  unzipSync(data, { filter: entry => {
    size += entry.originalSize;
    if (size > maxBytes) throw new Error("Office document exceeds the uncompressed size limit");
    return false;
  } });
}
export async function extractText(data: Buffer, mime: string, maxCharacters: number, maxBytes: number): Promise<string> {
  let text: string;
  if (mime === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  } else if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    validateZip(data, maxBytes * 5);
    const sheets = await readXlsxFile(data);
    text = sheets.map(sheet => `## ${sheet.sheet}\n${sheet.data.map(row => row.map(cell => cell instanceof Date ? cell.toISOString() : String(cell ?? "")).join("\t")).join("\n")}`).join("\n\n");
  } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    validateZip(data, maxBytes * 5);
    const files = unzipSync(data, { filter: e => /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(e.name) });
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, trimValues: false, parseTagValue: false });
    const collect = (nodes: any[]): string => nodes.map(node => Object.entries(node).map(([tag, value]) => {
      if (tag === "#text") return String(value);
      if (tag === "w:tab") return "\t";
      if (tag === "w:br") return "\n";
      return Array.isArray(value) ? collect(value) + (tag === "w:p" || tag === "w:tr" ? "\n" : "") : "";
    }).join("")).join("");
    text = Object.values(files).map(bytes => {
      const xml = strFromU8(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("XML document declarations are not supported");
      return collect(parser.parse(xml));
    }).join("\n");
  } else if (mime.startsWith("text/") || ["application/json", "application/xml"].includes(mime)) text = data.toString("utf8");
  else throw new Error(`Unsupported text format: ${mime}`);
  if (!text.trim()) return "[No extractable text. Scanned PDFs and images require OCR, which is not enabled.]";
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters)}\n[Truncated to ${maxCharacters} characters; open the original for the full document.]` : text;
}
export function exportMime(mime: string): string {
  if (mime === "application/vnd.google-apps.document" || mime === "application/vnd.google-apps.presentation") return "text/plain";
  if (mime === "application/vnd.google-apps.spreadsheet") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return mime;
}
export function supportedMime(mime: string): boolean {
  return mime.startsWith("text/") || ["application/pdf", "application/json", "application/xml", "application/vnd.google-apps.document", "application/vnd.google-apps.presentation", "application/vnd.google-apps.spreadsheet", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mime);
}
