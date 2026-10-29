// The few platform APIs the core may use. Both browsers and Node provide them.
// Declared by hand because the core is type-checked without DOM or Node types.

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
