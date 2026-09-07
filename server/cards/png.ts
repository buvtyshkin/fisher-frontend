/**
 * SillyTavern stores a character card inside the PNG itself, as a text chunk
 * whose payload is base64-encoded JSON. `ccv3` holds a V3 card, `chara` a V2
 * (or V1) one; when both are present V3 wins, which is what ST does too.
 */

import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngTextChunk {
  keyword: string;
  text: string;
}

/** Reads the tEXt and uncompressed iTXt chunks of a PNG, in file order. */
export function readTextChunks(png: Buffer): PngTextChunk[] {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Это не PNG-файл");
  }

  const chunks: PngTextChunk[] = [];
  let offset = 8;

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("latin1");
    const start = offset + 8;
    const end = start + length;
    if (end > png.length) break;

    if (type === "tEXt") {
      const body = png.subarray(start, end);
      const separator = body.indexOf(0);
      if (separator > 0) {
        chunks.push({
          keyword: body.subarray(0, separator).toString("latin1"),
          text: body.subarray(separator + 1).toString("latin1"),
        });
      }
    } else if (type === "iTXt") {
      const body = png.subarray(start, end);
      const separator = body.indexOf(0);
      // keyword \0 compressionFlag compressionMethod language \0 translated \0 text
      if (separator > 0 && body[separator + 1] === 0) {
        const languageEnd = body.indexOf(0, separator + 3);
        const translatedEnd = body.indexOf(0, languageEnd + 1);
        if (languageEnd > 0 && translatedEnd > 0) {
          chunks.push({
            keyword: body.subarray(0, separator).toString("latin1"),
            text: body.subarray(translatedEnd + 1).toString("utf8"),
          });
        }
      }
    }

    if (type === "IEND") break;
    offset = end + 4; // skip the CRC
  }

  return chunks;
}

/** Returns the raw card JSON embedded in a PNG, preferring V3 over V2. */
export function extractCardJson(png: Buffer): string {
  const chunks = readTextChunks(png);
  const byKeyword = (keyword: string) =>
    chunks.find((c) => c.keyword.toLowerCase() === keyword)?.text;

  const payload = byKeyword("ccv3") ?? byKeyword("chara");
  if (!payload) {
    throw new Error(
      "В PNG нет карточки персонажа (не найден блок chara или ccv3)",
    );
  }

  const decoded = Buffer.from(payload, "base64").toString("utf8");
  if (!decoded.trim().startsWith("{")) {
    throw new Error("Карточка внутри PNG повреждена: это не JSON");
  }
  return decoded;
}


function buildChunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), body])), 0);
  return Buffer.concat([header, body, crc]);
}

function buildTextChunk(keyword: string, text: string): Buffer {
  return buildChunk(
    "tEXt",
    Buffer.concat([
      Buffer.from(keyword, "latin1"),
      Buffer.alloc(1),
      Buffer.from(text, "latin1"),
    ]),
  );
}

/**
 * Rewrites the card embedded in a PNG, keeping the image itself byte for byte.
 * Existing card chunks are dropped and the new one is written just before
 * IEND — the layout SillyTavern produces and expects.
 */
export function writeCardIntoPng(
  png: Buffer,
  keyword: "chara" | "ccv3",
  cardJson: string,
): Buffer {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Это не PNG-файл");
  }

  const kept: Buffer[] = [];
  let iend: Buffer | null = null;
  let offset = 8;

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("latin1");
    const end = offset + 12 + length;
    if (end > png.length) break;

    const whole = png.subarray(offset, end);
    if (type === "IEND") {
      iend = whole;
      break;
    }

    // Drop any card already in the file, whatever spec it was written as.
    const isCardChunk =
      type === "tEXt" &&
      /^(chara|ccv3)\0/i.test(png.subarray(offset + 8, end - 4).toString("latin1"));
    if (!isCardChunk) kept.push(whole);

    offset = end;
  }

  const payload = Buffer.from(cardJson, "utf8").toString("base64");
  return Buffer.concat([
    PNG_SIGNATURE,
    ...kept,
    buildTextChunk(keyword, payload),
    iend ?? buildChunk("IEND", Buffer.alloc(0)),
  ]);
}
