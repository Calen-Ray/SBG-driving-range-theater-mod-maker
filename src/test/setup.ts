import '@testing-library/jest-dom/vitest'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    strokeRect: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    fillText: () => undefined,
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set font(_value: string) {},
    set textAlign(_value: string) {},
  }),
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  value(callback: (blob: Blob | null) => void) {
    callback(new Blob(['icon'], { type: 'image/png' }))
  },
})
