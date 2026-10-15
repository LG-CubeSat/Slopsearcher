import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractText, exportMime, validateZip } from "./extract.ts";
const wordMime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const sheetMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const zip = (entries: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([k, v]) => [k, strToU8(v)]),
      ),
    ),
  );
describe("Drive text extraction", () => {
  it("extracts DOCX paragraphs, tables and XML entities", async () => {
    const b = zip({
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Radio &amp; power</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>RFM95</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    });
    const text = await extractText(b, wordMime, 20000, 200000);
    expect(text).toContain("Radio & power");
    expect(text).toContain("RFM95");
  });
  it("rejects XML entity declarations", async () => {
    const b = zip({
      "word/document.xml":
        '<!DOCTYPE foo [<!ENTITY bar "secret">]><w:document/>',
    });
    await expect(extractText(b, wordMime, 20000, 200000)).rejects.toThrow(
      "declarations",
    );
  });
  it("bounds the uncompressed size before parsing Office files", () => {
    const b = zip({ "word/document.xml": "x".repeat(10000) });
    expect(() => validateZip(b, 100)).toThrow("uncompressed");
  });
  it("exports every spreadsheet sheet rather than only a CSV's first sheet", async () => {
    const b = zip({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      "xl/workbook.xml":
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Radio" sheetId="1" r:id="rId1"/><sheet name="Power" sheetId="2" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>RFM95</t></is></c></row></sheetData></worksheet>',
      "xl/worksheets/sheet2.xml":
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Battery</t></is></c></row></sheetData></worksheet>',
    });
    const text = await extractText(b, sheetMime, 20000, 200000);
    expect(text).toContain("Radio");
    expect(text).toContain("RFM95");
    expect(text).toContain("Power");
    expect(text).toContain("Battery");
  });
  it("labels truncated documents", async () => {
    expect(
      await extractText(Buffer.from("abcdefghij"), "text/plain", 5, 100),
    ).toContain("abcde\n[Truncated");
  });
  it("uses supported native export formats", () => {
    expect(exportMime("application/vnd.google-apps.spreadsheet")).toBe(
      sheetMime,
    );
    expect(exportMime("application/vnd.google-apps.presentation")).toBe(
      "text/plain",
    );
  });
});
it("extracts actual PDF text without OCR or a browser", async () => {
  const stream = "BT /F1 12 Tf 20 100 Td (Radio design) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  expect(
    await extractText(Buffer.from(pdf), "application/pdf", 20000, 100000),
  ).toContain("Radio design");
});
