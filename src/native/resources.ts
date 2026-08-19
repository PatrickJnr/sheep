/**
 * Windows resources: an application's icon and the version its Properties
 * dialog shows.
 *
 * Both live in a PE `.rsrc` section, which the appending build deliberately
 * does not have: `baa app build` copies a prebuilt runtime and appends an
 * image to it, with no compiler and no linker anywhere. So the section is
 * written here, by hand, and added to the copy.
 *
 * How that works, since it is not obvious: a PE section is a header in a table
 * plus a run of bytes further down the file. Adding one means writing a
 * 40-byte header after the last existing one, appending the bytes at the end
 * of the file, and correcting three numbers in the headers — the section
 * count, the image size, and the resource entry in the data directory. The
 * loader then maps it like any other section.
 *
 * Two things make this safe to do rather than reckless:
 *
 *   - The runtime is *ours*. It is a plain `cargo build` with no resources of
 *     its own, so nothing is being replaced and nothing else points into the
 *     region being written. If a runtime ever turns up with resources already
 *     in it, `addResources` refuses rather than corrupting it.
 *   - Everything is checked before it is written: the DOS stub, the PE
 *     signature, the optional-header magic, and that the section table has
 *     room for one more entry without running into the first section's data.
 *
 * The resource tree itself is three levels deep, which is what Windows
 * expects: type, then name or id, then language. Offsets inside it are
 * relative to the start of the section, except the data entries' `OffsetToData`
 * which is a virtual address in the image, so the section's own RVA has to be
 * known before the bytes can be finished.
 */

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

/** Neutral language, sublanguage default: the language id resources use when they are not translated. */
const LANG_NEUTRAL = 0x0000;

export type VersionInfo = {
  /** `1.2.3.0`, as four 16-bit numbers. */
  readonly version: readonly [number, number, number, number];
  readonly productName: string;
  readonly fileDescription: string;
  readonly companyName: string;
  readonly copyright: string;
  /** The name the file is expected to have, which Explorer shows. */
  readonly originalFilename: string;
};

/**
 * Parse `1.2.3` or `1.2.3.4` into the four numbers a PE version is made of.
 *
 * A version Baa cannot read becomes `0.0.0.0` rather than a build failure: a
 * manifest is written by a person, `0.1.0-beta` is a reasonable thing for one
 * to contain, and refusing to build an application over the shape of a string
 * in its Properties dialog would be a poor trade.
 */
export function parseVersion(text: string): [number, number, number, number] {
  const parts = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (parts === null) return [0, 0, 0, 0];
  const at = (index: number): number => {
    const value = Number(parts[index] ?? 0);
    return Number.isFinite(value) ? Math.min(0xffff, Math.max(0, Math.trunc(value))) : 0;
  };
  return [at(1), at(2), at(3), at(4)];
}

// --------------------------------------------------------------------------
// Little-endian writing
// --------------------------------------------------------------------------

class Writer {
  #bytes: number[] = [];

  get length(): number {
    return this.#bytes.length;
  }

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  bytes(values: Uint8Array | readonly number[]): this {
    for (const value of values) this.#bytes.push(value & 0xff);
    return this;
  }

  /** A NUL-terminated UTF-16LE string, which is what resources hold. */
  wide(text: string): this {
    for (let i = 0; i < text.length; i++) this.u16(text.charCodeAt(i));
    return this.u16(0);
  }

  /** Version resource structures are aligned to four bytes throughout. */
  align4(): this {
    while (this.#bytes.length % 4 !== 0) this.u8(0);
    return this;
  }

  patch32(at: number, value: number): void {
    this.#bytes[at] = value & 0xff;
    this.#bytes[at + 1] = (value >>> 8) & 0xff;
    this.#bytes[at + 2] = (value >>> 16) & 0xff;
    this.#bytes[at + 3] = (value >>> 24) & 0xff;
  }

  patch16(at: number, value: number): void {
    this.#bytes[at] = value & 0xff;
    this.#bytes[at + 1] = (value >>> 8) & 0xff;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

// --------------------------------------------------------------------------
// VS_VERSIONINFO
// --------------------------------------------------------------------------

/**
 * The blob behind the Details tab of a file's Properties.
 *
 * It is a tree of identically-shaped nodes: a length, a value length, a type
 * flag, a UTF-16 key, padding to four bytes, an optional value, then children.
 * Every length counts the node's own header, which is why each one is written
 * with a placeholder and patched once its children are known.
 */
export function buildVersionResource(info: VersionInfo): Uint8Array {
  const [major, minor, patch, build] = info.version;
  const strings: Array<[string, string]> = [
    ["CompanyName", info.companyName],
    ["FileDescription", info.fileDescription],
    ["FileVersion", `${major}.${minor}.${patch}.${build}`],
    ["InternalName", info.originalFilename],
    ["LegalCopyright", info.copyright],
    ["OriginalFilename", info.originalFilename],
    ["ProductName", info.productName],
    ["ProductVersion", `${major}.${minor}.${patch}.${build}`],
  ];

  const w = new Writer();
  const rootLength = w.length;
  w.u16(0); // wLength, patched below
  w.u16(52); // wValueLength: sizeof(VS_FIXEDFILEINFO)
  w.u16(0); // wType: binary
  w.wide("VS_VERSION_INFO");
  w.align4();

  // VS_FIXEDFILEINFO
  w.u32(0xfeef04bd); // dwSignature
  w.u32(0x00010000); // dwStrucVersion 1.0
  w.u32((major << 16) | minor); // dwFileVersionMS
  w.u32((patch << 16) | build); // dwFileVersionLS
  w.u32((major << 16) | minor); // dwProductVersionMS
  w.u32((patch << 16) | build); // dwProductVersionLS
  w.u32(0x3f); // dwFileFlagsMask
  w.u32(0); // dwFileFlags: no debug, no prerelease
  w.u32(0x00040004); // dwFileOS: VOS_NT_WINDOWS32
  w.u32(0x00000001); // dwFileType: VFT_APP
  w.u32(0); // dwFileSubtype
  w.u32(0); // dwFileDateMS
  w.u32(0); // dwFileDateLS
  w.align4();

  // StringFileInfo
  const stringInfoAt = w.length;
  w.u16(0); // wLength, patched
  w.u16(0);
  w.u16(1); // wType: text
  w.wide("StringFileInfo");
  w.align4();

  // One StringTable, for the neutral language in Unicode (codepage 1200).
  const tableAt = w.length;
  w.u16(0); // wLength, patched
  w.u16(0);
  w.u16(1);
  w.wide("000004b0");
  w.align4();

  for (const [key, value] of strings) {
    const stringAt = w.length;
    w.u16(0); // wLength, patched
    // wValueLength counts *characters*, including the terminator, not bytes.
    w.u16(value.length + 1);
    w.u16(1); // wType: text
    w.wide(key);
    w.align4();
    w.wide(value);
    w.align4();
    w.patch16(stringAt, w.length - stringAt);
  }
  w.patch16(tableAt, w.length - tableAt);
  w.patch16(stringInfoAt, w.length - stringInfoAt);

  // VarFileInfo: which language and codepage the strings above are in.
  const varInfoAt = w.length;
  w.u16(0); // wLength, patched
  w.u16(0);
  w.u16(1);
  w.wide("VarFileInfo");
  w.align4();
  const translationAt = w.length;
  w.u16(0); // wLength, patched
  w.u16(4); // wValueLength: one DWORD
  w.u16(0); // wType: binary
  w.wide("Translation");
  w.align4();
  w.u16(LANG_NEUTRAL);
  w.u16(1200); // Unicode codepage
  w.patch16(translationAt, w.length - translationAt);
  w.patch16(varInfoAt, w.length - varInfoAt);

  w.patch16(rootLength, w.length - rootLength);
  return w.toBytes();
}

// --------------------------------------------------------------------------
// Icons
// --------------------------------------------------------------------------

type IconImage = { readonly header: Uint8Array; readonly bytes: Uint8Array };

/**
 * Take an `.ico` file apart into the images it holds.
 *
 * The file and the resource disagree in one place, which is the only reason
 * this is not a copy: on disk a directory entry ends with the image's offset
 * in the file, and in a resource it ends with the id of the `RT_ICON` that
 * holds it instead. Everything before that is identical.
 */
export function readIcon(ico: Uint8Array): IconImage[] {
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (ico.length < 6 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error("not an .ico file: the header does not say so");
  }
  const count = view.getUint16(4, true);
  if (count === 0) throw new Error("the .ico file holds no images");
  const images: IconImage[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    if (at + 16 > ico.length) throw new Error("the .ico directory runs past the end of the file");
    const size = view.getUint32(at + 8, true);
    const offset = view.getUint32(at + 12, true);
    if (offset + size > ico.length) throw new Error("an .ico image runs past the end of the file");
    images.push({
      // Eight bytes: width, height, colour count, reserved, planes, bit count.
      // The file's entry continues with the image's size and its offset; the
      // resource's continues with the size and the `RT_ICON` id instead, which
      // is written by `buildIconGroup`.
      header: ico.subarray(at, at + 8),
      bytes: ico.subarray(offset, offset + size),
    });
  }
  return images;
}

/** The `RT_GROUP_ICON` that ties the images together, in resource form. */
function buildIconGroup(images: readonly IconImage[]): Uint8Array {
  const w = new Writer();
  w.u16(0); // reserved
  w.u16(1); // type: icon
  w.u16(images.length);
  images.forEach((image, index) => {
    w.bytes(image.header); // width, height, colours, reserved, planes, bits
    w.u32(image.bytes.length);
    w.u16(index + 1); // the RT_ICON id, rather than a file offset
  });
  return w.toBytes();
}

// --------------------------------------------------------------------------
// The resource directory
// --------------------------------------------------------------------------

type Leaf = { readonly type: number; readonly id: number; readonly data: Uint8Array };

/**
 * Lay out a `.rsrc` section holding the given resources.
 *
 * The tree is type → id → language, each level a directory of entries sorted
 * by id, as the format requires. Data entries carry an RVA rather than an
 * offset, so the section's address in the loaded image has to be known here.
 */
function buildResourceSection(leaves: readonly Leaf[], sectionRva: number): Uint8Array {
  const types = [...new Set(leaves.map((leaf) => leaf.type))].sort((a, b) => a - b);
  const byType = new Map(
    types.map((type) => [type, leaves.filter((leaf) => leaf.type === type).sort((a, b) => a.id - b.id)]),
  );

  const DIRECTORY = 16;
  const ENTRY = 8;
  const DATA_ENTRY = 16;

  // Sizes first, so every offset can be written on the way past.
  const typeDirectory = DIRECTORY + types.length * ENTRY;
  let nameDirectories = 0;
  let languageDirectories = 0;
  let dataEntries = 0;
  for (const type of types) {
    const items = byType.get(type)!;
    nameDirectories += DIRECTORY + items.length * ENTRY;
    languageDirectories += items.length * (DIRECTORY + ENTRY);
    dataEntries += items.length * DATA_ENTRY;
  }
  const headerSize = typeDirectory + nameDirectories + languageDirectories + dataEntries;

  const w = new Writer();
  // Level 1: types.
  w.u32(0).u32(0).u16(0).u16(0).u16(0).u16(types.length);
  let nameDirectoryAt = typeDirectory;
  const nameDirectoryOffsets: number[] = [];
  for (const type of types) {
    nameDirectoryOffsets.push(nameDirectoryAt);
    w.u32(type);
    w.u32(0x80000000 | nameDirectoryAt); // high bit: this entry is a directory
    nameDirectoryAt += DIRECTORY + byType.get(type)!.length * ENTRY;
  }

  // Level 2: ids, each pointing at a one-entry language directory.
  let languageDirectoryAt = typeDirectory + nameDirectories;
  const languageDirectoryOffsets: number[][] = [];
  for (const type of types) {
    const items = byType.get(type)!;
    w.u32(0).u32(0).u16(0).u16(0).u16(0).u16(items.length);
    const offsets: number[] = [];
    for (const item of items) {
      offsets.push(languageDirectoryAt);
      w.u32(item.id);
      w.u32(0x80000000 | languageDirectoryAt);
      languageDirectoryAt += DIRECTORY + ENTRY;
    }
    languageDirectoryOffsets.push(offsets);
  }
  void nameDirectoryOffsets;

  // Level 3: languages, each pointing at a data entry.
  let dataEntryAt = typeDirectory + nameDirectories + languageDirectories;
  for (const type of types) {
    for (const _ of byType.get(type)!) {
      void _;
      w.u32(0).u32(0).u16(0).u16(0).u16(0).u16(1);
      w.u32(LANG_NEUTRAL);
      w.u32(dataEntryAt); // no high bit: a leaf
      dataEntryAt += DATA_ENTRY;
    }
  }
  void languageDirectoryOffsets;

  // The data entries, then the bytes they point at.
  let payloadAt = headerSize;
  for (const type of types) {
    for (const item of byType.get(type)!) {
      w.u32(sectionRva + payloadAt); // OffsetToData is an RVA, not an offset
      w.u32(item.data.length);
      w.u32(0); // codepage
      w.u32(0); // reserved
      payloadAt += align(item.data.length, 8);
    }
  }
  for (const type of types) {
    for (const item of byType.get(type)!) {
      w.bytes(item.data);
      while (w.length % 8 !== 0) w.u8(0);
    }
  }
  return w.toBytes();
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

// --------------------------------------------------------------------------
// Adding a section to a PE file
// --------------------------------------------------------------------------

export type ResourceRequest = {
  readonly version?: VersionInfo;
  /** The bytes of an `.ico` file. */
  readonly icon?: Uint8Array;
};

/**
 * Return `exe` with a `.rsrc` section holding the requested resources.
 *
 * Throws rather than producing a doubtful executable: a corrupt PE fails at
 * launch with a message from Windows that says nothing about Baa, and a build
 * that refuses is far easier to act on.
 */
export function addResources(exe: Uint8Array, request: ResourceRequest): Uint8Array {
  const leaves: Leaf[] = [];
  if (request.version !== undefined) {
    leaves.push({ type: RT_VERSION, id: 1, data: buildVersionResource(request.version) });
  }
  if (request.icon !== undefined) {
    const images = readIcon(request.icon);
    images.forEach((image, index) => {
      leaves.push({ type: RT_ICON, id: index + 1, data: image.bytes });
    });
    leaves.push({ type: RT_GROUP_ICON, id: 1, data: buildIconGroup(images) });
  }
  if (leaves.length === 0) return exe;

  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  if (exe.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) {
    throw new Error("the runtime is not a PE executable: no MZ header");
  }
  const peAt = view.getUint32(0x3c, true);
  if (peAt + 24 > exe.length || view.getUint32(peAt, true) !== 0x00004550) {
    throw new Error("the runtime is not a PE executable: no PE signature");
  }

  const sectionCount = view.getUint16(peAt + 6, true);
  const optionalSize = view.getUint16(peAt + 20, true);
  const optionalAt = peAt + 24;
  const magic = view.getUint16(optionalAt, true);
  const plus = magic === 0x20b;
  if (!plus && magic !== 0x10b) {
    throw new Error(`the runtime has an optional header Baa does not know: 0x${magic.toString(16)}`);
  }

  const sectionAlignment = view.getUint32(optionalAt + 32, true);
  const fileAlignment = view.getUint32(optionalAt + 36, true);
  const sizeOfImageAt = optionalAt + 56;
  const directoriesAt = optionalAt + (plus ? 112 : 96);
  const resourceDirectoryAt = directoriesAt + 8 * 2;

  if (view.getUint32(resourceDirectoryAt, true) !== 0) {
    // Replacing an existing tree means moving whatever else points into it.
    // The runtime Baa ships has none, so this is a guard against a future
    // build gaining resources without anyone noticing here.
    throw new Error("the runtime already has resources, which Baa will not replace");
  }

  const sectionTableAt = optionalAt + optionalSize;
  const newHeaderAt = sectionTableAt + sectionCount * 40;
  let firstRawData = exe.length;
  let endOfImage = 0;
  let endOfFile = 0;
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTableAt + i * 40;
    const virtualSize = view.getUint32(at + 8, true);
    const virtualAddress = view.getUint32(at + 12, true);
    const rawSize = view.getUint32(at + 16, true);
    const rawPointer = view.getUint32(at + 20, true);
    if (rawPointer > 0) firstRawData = Math.min(firstRawData, rawPointer);
    endOfImage = Math.max(endOfImage, virtualAddress + virtualSize);
    endOfFile = Math.max(endOfFile, rawPointer + rawSize);
  }
  if (newHeaderAt + 40 > firstRawData) {
    throw new Error("the runtime has no room in its section table for resources");
  }
  if (exe.length > endOfFile) {
    // Anything after the last section is an overlay, and Baa's own image is
    // exactly that. Resources go on before it: adding a section afterwards
    // would either bury the image where the footer no longer ends the file, or
    // drop it.
    throw new Error("resources must be added before an image is appended");
  }

  const sectionRva = align(endOfImage, sectionAlignment);
  const body = buildResourceSection(leaves, sectionRva);
  const rawSize = align(body.length, fileAlignment);
  const rawPointer = align(endOfFile, fileAlignment);

  const out = new Uint8Array(rawPointer + rawSize);
  out.set(exe.subarray(0, Math.min(exe.length, rawPointer)));
  out.set(body, rawPointer);

  const outView = new DataView(out.buffer);
  outView.setUint16(peAt + 6, sectionCount + 1, true);
  outView.setUint32(sizeOfImageAt, align(sectionRva + body.length, sectionAlignment), true);
  outView.setUint32(resourceDirectoryAt, sectionRva, true);
  outView.setUint32(resourceDirectoryAt + 4, body.length, true);

  const nameBytes = new TextEncoder().encode(".rsrc");
  out.set(nameBytes, newHeaderAt);
  for (let i = nameBytes.length; i < 8; i++) out[newHeaderAt + i] = 0;
  outView.setUint32(newHeaderAt + 8, body.length, true); // VirtualSize
  outView.setUint32(newHeaderAt + 12, sectionRva, true); // VirtualAddress
  outView.setUint32(newHeaderAt + 16, rawSize, true); // SizeOfRawData
  outView.setUint32(newHeaderAt + 20, rawPointer, true); // PointerToRawData
  outView.setUint32(newHeaderAt + 24, 0, true); // PointerToRelocations
  outView.setUint32(newHeaderAt + 28, 0, true); // PointerToLinenumbers
  outView.setUint16(newHeaderAt + 32, 0, true); // NumberOfRelocations
  outView.setUint16(newHeaderAt + 34, 0, true); // NumberOfLinenumbers
  // Initialised data, readable, not writable and not executable.
  outView.setUint32(newHeaderAt + 36, 0x40000040, true);

  return out;
}
