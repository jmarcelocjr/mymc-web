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
export { DIRENT_SIZE, Mode, exists, isDir, isFile, protectionOf, type DirEntry, type Protection, type Tod } from './dirent';
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
