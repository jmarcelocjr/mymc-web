// Public API of the core library.
export { CardError, type CardErrorCode } from './errors';
export {
  MAX_DEPTH,
  MemoryCard,
  openCard,
  type EccReport,
  type ReadProblem,
  type SaveKind,
  type SaveSummary,
} from './card';
export {
  DIRENT_SIZE,
  EntryField,
  MAX_NAME_LENGTH,
  Mode,
  exists,
  isDir,
  isFile,
  makeEntry,
  packTod,
  parseDirEntry,
  protectionOf,
  setEntryU32,
  todFromDate,
  type DirEntry,
  type Protection,
  type Tod,
} from './dirent';
export { eccCheckPage, eccChunk, eccSpare, type EccStatus } from './ecc';
export { ICON_SYS_SIZE, parseIconSys, parsePs1Title, type IconSys, type SaveTitle, type Vec4 } from './iconsys';
export { CARD_MAGIC, detectLayout, parseSuperblock, type Layout, type Superblock } from './superblock';
export {
  TEXTURE_SIZE,
  decodeTexture,
  decompressTexture,
  parseIcon,
  type IconAnimation,
  type IconFrame,
  type IconKey,
  type IconModel,
} from './icon';
export { ICON_FPS, ShapeBlender, animationFrame } from './iconAnim';
export { exportPsu, type PsuExport } from './psu';
export { CARD_SIZES, DIR_MODE, ROOT_DOTDOT_MODE, formatCard, type CardSizeMb } from './format';
export { entryName, nodeClusters, nodeTitle, readContents, readNode, type ArchiveNode, type CardContents, type ReadContentsResult } from './archive';
export { buildCard, cardCapacity, contentsClusters, rebuildCard, verifyCard, type VerifyResult } from './build';
export { lzariDecode } from './lzari';
export { FILE_MODE, crc32, parseMax, parsePsu, parseSaveFile, type ImportedSave } from './saveFile';
