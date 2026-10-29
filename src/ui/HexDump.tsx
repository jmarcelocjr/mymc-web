import { useState } from 'react';

const ROW = 16;
const PAGE = 4096;

function hexRow(bytes: Uint8Array, offset: number): string {
  const slice = bytes.subarray(offset, offset + ROW);
  const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0'));
  const left = hex.slice(0, 8).join(' ');
  const right = hex.slice(8).join(' ');
  const ascii = Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  return `${offset.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  ${ascii}`;
}

export function HexDump({ bytes }: { bytes: Uint8Array }) {
  const [shown, setShown] = useState(PAGE);
  const rows: string[] = [];
  for (let o = 0; o < Math.min(bytes.length, shown); o += ROW) rows.push(hexRow(bytes, o));
  return (
    <div className="hexdump">
      <pre>{rows.join('\n') || '(empty file)'}</pre>
      {bytes.length > shown && (
        <button type="button" className="link-button" onClick={() => setShown(shown + PAGE * 4)}>
          Show more ({(bytes.length - shown).toLocaleString()} bytes left)
        </button>
      )}
    </div>
  );
}
