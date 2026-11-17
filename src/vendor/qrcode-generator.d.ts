// Types for the vendored qrcode-generator 2.0.4 (adapted from its dist/qrcode.d.ts; MIT, Copyright (c) 2016 Kazuhiko
// Arase; see the header of qrcode-generator.js and THIRD_PARTY_NOTICES.md).
export type TypeNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20
  | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40;
export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';
export type Mode = 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji';
export interface QRCode {
  addData(data: string, mode?: Mode): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
  createSvgTag(opts?: { cellSize?: number; margin?: number; scalable?: boolean }): string;
  createDataURL(cellSize?: number, margin?: number): string;
}
export interface QRCodeFactory {
  (typeNumber: TypeNumber, errorCorrectionLevel: ErrorCorrectionLevel): QRCode;
  stringToBytes(s: string): number[];
}
export declare const qrcode: QRCodeFactory;
export default qrcode;
