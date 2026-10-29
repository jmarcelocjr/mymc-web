export type CardErrorCode =
  | 'not-a-card'       // magic missing: not a PS2 memory card image
  | 'bad-size'         // file size doesn't match the superblock
  | 'bad-superblock'   // superblock values out of range or unsupported
  | 'out-of-bounds'    // a cluster or offset points outside the card
  | 'fat-cycle'        // a cluster chain loops back on itself
  | 'bad-chain'        // a chain hits a free cluster or ends too early
  | 'bad-directory'    // directory structure is damaged
  | 'too-deep'         // directories nested deeper than any real save
  | 'not-found'        // path doesn't exist
  | 'not-a-directory'
  | 'not-a-file'
  | 'bad-icon-sys'
  | 'bad-icon';

/** Every problem the core detects is reported with this error type, never a crash. */
export class CardError extends Error {
  readonly code: CardErrorCode;

  constructor(code: CardErrorCode, message: string) {
    super(message);
    this.name = 'CardError';
    this.code = code;
  }
}
