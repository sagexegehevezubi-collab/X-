const SPECIFIED_SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024;

async function parseSpecifiedSpreadsheet(file) {
  if (!file || file.size > SPECIFIED_SPREADSHEET_MAX_BYTES) throw new Error("文件为空或超过 10 MB");
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".csv")) return parseSpecifiedCsv(await file.text());
  if (!name.endsWith(".xlsx")) throw new Error("仅支持 .xlsx 或 .csv 文件（旧版 .xls 请另存为 .xlsx）");
  const entries = await readSpecifiedZip(await file.arrayBuffer());
  const decoder = new TextDecoder("utf-8");
  const workbookText = await readSpecifiedZipText(entries, "xl/workbook.xml", decoder);
  const relsText = await readSpecifiedZipText(entries, "xl/_rels/workbook.xml.rels", decoder);
  const workbook = new DOMParser().parseFromString(workbookText, "application/xml");
  const relationships = new DOMParser().parseFromString(relsText, "application/xml");
  const firstSheet = workbook.getElementsByTagName("sheet")[0];
  if (!firstSheet) throw new Error("Excel 工作簿中没有工作表");
  const relationId = firstSheet.getAttribute("r:id") || firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const relation = [...relationships.getElementsByTagName("Relationship")].find((item) => item.getAttribute("Id") === relationId);
  if (!relation) throw new Error("无法读取第一个工作表");
  const target = relation.getAttribute("Target") || "worksheets/sheet1.xml";
  const sheetPath = normalizeSpecifiedZipPath(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  const sheetText = await readSpecifiedZipText(entries, sheetPath, decoder);
  const sharedStrings = entries.has("xl/sharedStrings.xml")
    ? parseSpecifiedSharedStrings(await readSpecifiedZipText(entries, "xl/sharedStrings.xml", decoder))
    : [];
  const sheet = new DOMParser().parseFromString(sheetText, "application/xml");
  const rows = [...sheet.getElementsByTagName("sheetData")].flatMap((data) => [...data.getElementsByTagName("row")]);
  if (!rows.length) return [];
  const matrix = rows.map((row) => [...row.children].filter((cell) => cell.localName === "c").map((cell) => {
    const ref = cell.getAttribute("r") || "A1";
    const col = ref.match(/^[A-Z]+/i)?.[0] || "A";
    let index = 0;
    for (const char of col.toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64;
    index -= 1;
    const type = cell.getAttribute("t");
    const value = cell.getElementsByTagName("v")[0]?.textContent || "";
    const text = type === "s" ? sharedStrings[Number(value)] || ""
      : type === "inlineStr" ? [...cell.getElementsByTagName("t")].map((node) => node.textContent || "").join("")
        : value;
    return { index, text: String(text).trim() };
  }));
  const headerWords = new Set(["账号", "博主账号", "用户名", "username", "user", "account", "博主", "主页链接", "账号链接"]);
  const firstRow = matrix[0] || [];
  const headerCell = firstRow.find((cell) => headerWords.has(cell.text.toLowerCase().replace(/[\s*_：:]/g, "")));
  const accountColumn = headerCell ? headerCell.index : (firstRow.find((cell) => cell.text)?.index ?? 0);
  const dataRows = headerCell ? matrix.slice(1) : matrix;
  return dataRows.map((row) => row.find((cell) => cell.index === accountColumn)?.text || "").filter(Boolean);
}

function createSpecifiedXlsxTemplate() {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="博主名单" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>博主账号</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>@example_user</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>https://x.com/example_user</t></is></c></row></sheetData></worksheet>`
  };
  return buildSpecifiedStoredZip(files);
}

function buildSpecifiedStoredZip(files) {
  const encoder = new TextEncoder();
  const entries = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = specifiedCrc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    entries.push(local);
    const record = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, data.length, true);
    view.setUint32(24, data.length, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    central.push(record);
    offset += local.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...entries, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function specifiedCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseSpecifiedCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' && quoted && source[i + 1] === '"') { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "," || char === "\t")) { row.push(value.trim()); value = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; value = "";
    } else value += char;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];
  const headerWords = new Set(["账号", "博主账号", "用户名", "username", "user", "account", "博主", "主页链接", "账号链接"]);
  const first = rows[0].map((cell) => cell.toLowerCase().replace(/[\s*_：:]/g, ""));
  const column = first.findIndex((cell) => headerWords.has(cell));
  return (column >= 0 ? rows.slice(1) : rows).map((cells) => cells[column >= 0 ? column : 0] || "").filter(Boolean);
}

function parseSpecifiedSharedStrings(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  return [...xml.getElementsByTagName("si")].map((item) => [...item.getElementsByTagName("t")].map((node) => node.textContent || "").join(""));
}

function normalizeSpecifiedZipPath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

async function readSpecifiedZip(buffer) {
  const view = new DataView(buffer);
  let eocd = -1;
  for (let offset = Math.max(0, view.byteLength - 22 - 65535); offset <= view.byteLength - 22; offset += 1) {
    if (view.getUint32(offset, true) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error("文件不是有效的 .xlsx 工作簿");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Excel 文件目录损坏");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, cursor + 46, nameLength));
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Excel 文件内容损坏");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(start, start + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8 && typeof DecompressionStream === "function") {
      content = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    } else throw new Error("此 .xlsx 压缩格式暂不支持，请在 Excel 中另存为标准 .xlsx");
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readSpecifiedZipText(entries, path, decoder) {
  const bytes = entries.get(path);
  if (!bytes) throw new Error(`Excel 文件缺少 ${path}`);
  return decoder.decode(bytes);
}
