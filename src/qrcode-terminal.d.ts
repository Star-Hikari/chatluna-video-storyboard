declare module 'qrcode-terminal' {
  export interface QrOptions {
    small?: boolean
  }
  export function generate(text: string, options: QrOptions, callback: (qrcode: string) => void): void
  export function generate(text: string, callback: (qrcode: string) => void): void
  const _default: {
    generate: typeof generate
  }
  export default _default
}