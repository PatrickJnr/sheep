/**
 * Windows resources: the version block and the icon directory.
 *
 * These are byte formats Windows parses, so the tests are about bytes. The
 * one that matters most is the icon group entry being fourteen bytes: the
 * first implementation copied twelve bytes from the `.ico` and added six,
 * which produced a resource Windows accepted, stored, and then could not turn
 * into an icon. Nothing but a size check catches that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addResources, buildVersionResource, parseVersion, readIcon } from "../src/native/resources.ts";

/** A minimal but real `.ico`: one 2x2 32-bit image, in the BMP form. */
function makeIcon(images = 1): Uint8Array {
  const pixels = new Uint8Array(2 * 2 * 4 + 8); // BGRA rows, then the AND mask
  const dib = new Uint8Array(40 + pixels.length);
  const view = new DataView(dib.buffer);
  view.setUint32(0, 40, true); // biSize
  view.setInt32(4, 2, true); // biWidth
  view.setInt32(8, 4, true); // biHeight: image plus mask
  view.setUint16(12, 1, true); // biPlanes
  view.setUint16(14, 32, true); // biBitCount
  dib.set(pixels, 40);

  const header = new Uint8Array(6 + images * 16);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, 0, true); // reserved
  headerView.setUint16(2, 1, true); // type: icon
  headerView.setUint16(4, images, true);
  const out = new Uint8Array(header.length + images * dib.length);
  for (let i = 0; i < images; i++) {
    const at = 6 + i * 16;
    header[at] = 2; // width
    header[at + 1] = 2; // height
    header[at + 2] = 0; // colours
    header[at + 3] = 0; // reserved
    headerView.setUint16(at + 4, 1, true); // planes
    headerView.setUint16(at + 6, 32, true); // bit count
    headerView.setUint32(at + 8, dib.length, true);
    headerView.setUint32(at + 12, header.length + i * dib.length, true);
    out.set(dib, header.length + i * dib.length);
  }
  out.set(header, 0);
  return out;
}

function readUtf16(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    text += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  }
  return text;
}

describe("resources: versions", () => {
  it("reads the versions a manifest is likely to hold", () => {
    assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3, 0]);
    assert.deepEqual(parseVersion("1.2.3.4"), [1, 2, 3, 4]);
    assert.deepEqual(parseVersion("2"), [2, 0, 0, 0]);
    assert.deepEqual(parseVersion(" 0.7.1 "), [0, 7, 1, 0]);
  });

  it("takes the numbers out of a version it does not fully understand", () => {
    // A manifest is written by a person. Refusing to build an application over
    // the shape of a string in its Properties dialog would be a poor trade.
    assert.deepEqual(parseVersion("0.1.0-beta"), [0, 1, 0, 0]);
    assert.deepEqual(parseVersion("not a version"), [0, 0, 0, 0]);
    assert.deepEqual(parseVersion("999999.1"), [65535, 1, 0, 0]);
  });

  it("writes a block whose own length is the length it is", () => {
    const bytes = buildVersionResource({
      version: [1, 2, 3, 4],
      productName: "Pen Counter",
      fileDescription: "Counts pens",
      companyName: "A Farm",
      copyright: "Copyright 2026",
      originalFilename: "PenCounter.exe",
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint16(0, true), bytes.length, "wLength must cover the whole block");
    assert.equal(view.getUint16(2, true), 52, "wValueLength is sizeof(VS_FIXEDFILEINFO)");
    assert.equal(bytes.length % 4, 0, "every structure is four-byte aligned");
  });

  it("carries the fixed block Windows looks for, with the version in it", () => {
    const bytes = buildVersionResource({
      version: [1, 2, 3, 4],
      productName: "P",
      fileDescription: "D",
      companyName: "C",
      copyright: "R",
      originalFilename: "F.exe",
    });
    const text = readUtf16(bytes);
    assert.match(text, /VS_VERSION_INFO/);
    const at = text.indexOf("VS_VERSION_INFO");
    assert.ok(at > 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The signature sits after the key and its padding; find it rather than
    // assuming an offset, which is what a reader has to do too.
    let signatureAt = -1;
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
      if (view.getUint32(i, true) === 0xfeef04bd) {
        signatureAt = i;
        break;
      }
    }
    assert.notEqual(signatureAt, -1, "the fixed block signature is missing");
    assert.equal(view.getUint32(signatureAt + 8, true), (1 << 16) | 2, "file version MS");
    assert.equal(view.getUint32(signatureAt + 12, true), (3 << 16) | 4, "file version LS");
  });

  it("includes every string a Properties dialog shows", () => {
    const text = readUtf16(
      buildVersionResource({
        version: [0, 0, 0, 0],
        productName: "Pen Counter",
        fileDescription: "Counts pens",
        companyName: "A Farm",
        copyright: "Copyright 2026",
        originalFilename: "PenCounter.exe",
      }),
    );
    for (const expected of [
      "CompanyName",
      "A Farm",
      "FileDescription",
      "Counts pens",
      "FileVersion",
      "ProductName",
      "Pen Counter",
      "OriginalFilename",
      "PenCounter.exe",
      "LegalCopyright",
      "Copyright 2026",
      "StringFileInfo",
      "VarFileInfo",
      "Translation",
    ]) {
      assert.ok(text.includes(expected), `the version block is missing ${expected}`);
    }
  });
});

describe("resources: icons", () => {
  it("reads the images out of an .ico", () => {
    const images = readIcon(makeIcon(3));
    assert.equal(images.length, 3);
    assert.equal(images[0]!.header.length, 8, "a group entry keeps eight bytes of the directory");
    assert.ok(images[0]!.bytes.length > 40);
  });

  it("refuses a file that is not an icon, rather than writing nonsense", () => {
    assert.throws(() => readIcon(new Uint8Array([1, 2, 3, 4, 5, 6])), /not an .ico/);
    const truncated = makeIcon(1).subarray(0, 10);
    assert.throws(() => readIcon(truncated), /runs past the end/);
  });

  it("builds a group entry of exactly fourteen bytes per image", () => {
    // 6 bytes of header, then 14 per image: 8 describing it, 4 for the size,
    // 2 for the RT_ICON id. Eighteen was accepted by FindResource and then
    // silently produced no icon at all.
    const exe = fakePE();
    const withIcons = addResources(exe, { icon: makeIcon(3) });
    const group = findResourceBytes(withIcons, 14);
    assert.notEqual(group, null, "no RT_GROUP_ICON was written");
    assert.equal(group!.length, 6 + 3 * 14);
  });
});

describe("resources: adding a section", () => {
  it("does nothing when nothing was asked for", () => {
    const exe = fakePE();
    assert.equal(addResources(exe, {}), exe);
  });

  it("adds one section and says so in the headers", () => {
    const exe = fakePE();
    const before = new DataView(exe.buffer).getUint16(peOffset(exe) + 6, true);
    const after = addResources(exe, {
      version: {
        version: [1, 0, 0, 0],
        productName: "P",
        fileDescription: "D",
        companyName: "C",
        copyright: "R",
        originalFilename: "F.exe",
      },
    });
    const view = new DataView(after.buffer);
    const pe = peOffset(after);
    assert.equal(view.getUint16(pe + 6, true), before + 1);

    const optional = pe + 24;
    const directories = optional + 112; // PE32+
    assert.notEqual(view.getUint32(directories + 16, true), 0, "the resource directory is empty");
    assert.ok(after.length > exe.length);
  });

  it("refuses a file that is not a PE", () => {
    assert.throws(() => addResources(new Uint8Array(64), { icon: makeIcon() }), /not a PE/);
  });

  it("refuses to write over an image that has already been appended", () => {
    // Resources are a section; an image is an overlay after the last one. In
    // the wrong order the file ends with a section rather than the footer, and
    // the runtime then finds no application in itself.
    const exe = fakePE();
    const withOverlay = new Uint8Array(exe.length + 16);
    withOverlay.set(exe);
    assert.throws(() => addResources(withOverlay, { icon: makeIcon() }), /before an image is appended/);
  });
});

// --------------------------------------------------------------------------
// A PE64 file with one section, small enough to write out by hand.
// --------------------------------------------------------------------------

function peOffset(exe: Uint8Array): number {
  return new DataView(exe.buffer, exe.byteOffset, exe.byteLength).getUint32(0x3c, true);
}

function fakePE(): Uint8Array {
  const fileAlignment = 512;
  const sectionAlignment = 4096;
  const peAt = 0x80;
  const headers = 0x200;
  const bytes = new Uint8Array(headers + fileAlignment);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, 0x5a4d, true); // MZ
  view.setUint32(0x3c, peAt, true);
  view.setUint32(peAt, 0x00004550, true); // PE\0\0
  view.setUint16(peAt + 4, 0x8664, true); // machine: x64
  view.setUint16(peAt + 6, 1, true); // one section
  view.setUint16(peAt + 20, 240, true); // SizeOfOptionalHeader

  const optional = peAt + 24;
  view.setUint16(optional, 0x20b, true); // PE32+
  view.setUint32(optional + 32, sectionAlignment, true);
  view.setUint32(optional + 36, fileAlignment, true);
  view.setUint32(optional + 56, sectionAlignment * 2, true); // SizeOfImage
  view.setUint32(optional + 60, headers, true); // SizeOfHeaders

  const table = optional + 240;
  const name = new TextEncoder().encode(".text");
  bytes.set(name, table);
  view.setUint32(table + 8, 16, true); // VirtualSize
  view.setUint32(table + 12, sectionAlignment, true); // VirtualAddress
  view.setUint32(table + 16, fileAlignment, true); // SizeOfRawData
  view.setUint32(table + 20, headers, true); // PointerToRawData
  return bytes;
}

/** Find a resource type's bytes in a file this module just wrote. */
function findResourceBytes(exe: Uint8Array, type: number): Uint8Array | null {
  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const pe = peOffset(exe);
  const optional = pe + 24;
  const directories = optional + 112;
  const rva = view.getUint32(directories + 16, true);
  if (rva === 0) return null;

  // Map the resource RVA back to a file offset through the section table.
  const sections = view.getUint16(pe + 6, true);
  const table = optional + view.getUint16(pe + 20, true);
  let base = 0;
  let pointer = 0;
  for (let i = 0; i < sections; i++) {
    const at = table + i * 40;
    const virtualAddress = view.getUint32(at + 12, true);
    if (virtualAddress === rva) {
      base = virtualAddress;
      pointer = view.getUint32(at + 20, true);
    }
  }
  if (pointer === 0) return null;

  const typeCount = view.getUint16(pointer + 14, true);
  for (let i = 0; i < typeCount; i++) {
    const entry = pointer + 16 + i * 8;
    if (view.getUint32(entry, true) !== type) continue;
    const nameDirectory = pointer + (view.getUint32(entry + 4, true) & 0x7fffffff);
    const languageDirectory = pointer + (view.getUint32(nameDirectory + 20, true) & 0x7fffffff);
    const dataEntry = pointer + (view.getUint32(languageDirectory + 20, true) & 0x7fffffff);
    const dataRva = view.getUint32(dataEntry, true);
    const size = view.getUint32(dataEntry + 4, true);
    const at = pointer + (dataRva - base);
    return exe.subarray(at, at + size);
  }
  return null;
}
