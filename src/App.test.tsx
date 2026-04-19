import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type FfmpegEventPayload = {
  progress?: number
  time?: number
  message?: string
}

const ffmpegTestState = vi.hoisted(() => ({
  instances: [] as {
    loaded: boolean
    load: ReturnType<typeof vi.fn>
    exec: ReturnType<typeof vi.fn>
  }[],
}))

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    loaded = false
    files = new Map<string, Uint8Array | string>()
    loadConfig: Record<string, unknown> | null = null
    listeners: Record<
      'log' | 'progress',
      Array<(payload: FfmpegEventPayload) => void>
    > = {
      log: [],
      progress: [],
    }

    constructor() {
      ffmpegTestState.instances.push(this as never)
    }

    on(
      event: 'log' | 'progress',
      callback: (payload: FfmpegEventPayload) => void,
    ) {
      this.listeners[event].push(callback)
    }

    load = vi.fn(async (config?: Record<string, unknown>) => {
      this.loaded = true
      this.loadConfig = config ?? null
      return true
    })

    writeFile = vi.fn(async (path: string, data: Uint8Array) => {
      this.files.set(path, data)
      return true
    })

    ffprobe = vi.fn(async (args: string[]) => {
      const output = args[args.length - 1]
      if (args.includes('format=duration')) {
        this.files.set(output, '12.5')
      } else {
        this.files.set(output, 'audio')
      }
      return 0
    })

    exec = vi.fn(async (args: string[]) => {
      for (const callback of this.listeners.progress) {
        callback({ progress: 1, time: 0 })
      }
      const output = args[args.length - 1]
      this.files.set(output, new Uint8Array([1, 2, 3, 4]))
      return 0
    })

    readFile = vi.fn(async (path: string, encoding?: string) => {
      const value = this.files.get(path)
      if (typeof value === 'string') {
        return value
      }
      if (value instanceof Uint8Array) {
        return value
      }
      return encoding === 'utf8' ? '' : new Uint8Array()
    })

    deleteFile = vi.fn(async (path: string) => {
      this.files.delete(path)
      return true
    })
  },
}))

vi.mock('@ffmpeg/util', () => ({
  fetchFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  toBlobURL: vi.fn(async (url: string) => `blob:${url}`),
}))

vi.mock('@ffmpeg/core?url', () => ({
  default: '/assets/ffmpeg-core.js',
}))

vi.mock('@ffmpeg/core/wasm?url', () => ({
  default: '/assets/ffmpeg-core.wasm',
}))

describe('App', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    ffmpegTestState.instances.length = 0
    vi.restoreAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:download'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('adds files through the chooser and by dragging onto the queue panel', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(
      input,
      new File(['first'], 'alpha.mp4', { type: 'video/mp4' }),
    )

    expect(await screen.findByText('alpha.mp4')).toBeInTheDocument()

    const queuePanel = screen
      .getByText('Source videos')
      .closest('.queue-panel') as HTMLElement

    fireEvent.dragEnter(queuePanel, {
      dataTransfer: { files: [], types: ['Files'] },
    })
    expect(queuePanel).toHaveClass('drag-active')

    fireEvent.drop(queuePanel, {
      dataTransfer: {
        files: [new File(['second'], 'beta.mov', { type: 'video/quicktime' })],
        types: ['Files'],
      },
    })

    expect(await screen.findByText('beta.mov')).toBeInTheDocument()
  })

  it('builds a pack with the selected encoding preset', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(
      input,
      new File(['clip'], 'trailer.mp4', { type: 'video/mp4' }),
    )

    await user.click(
      screen.getByRole('button', { name: /goodbest final output/i }),
    )
    await user.click(screen.getByRole('button', { name: /build content pack/i }))

    await screen.findByText(/ffmpeg core loaded in browser memory/i)
    const downloadLink = await screen.findByRole('link', {
      name: /download cray-drivingrangetheatervideos-1.0.0.zip/i,
    })

    expect(downloadLink).toBeInTheDocument()
    expect(ffmpegTestState.instances).toHaveLength(1)
    expect(ffmpegTestState.instances[0].load).toHaveBeenCalledWith({
      coreURL: 'blob:/assets/ffmpeg-core.js',
      wasmURL: 'blob:/assets/ffmpeg-core.wasm',
    })

    await waitFor(() => {
      expect(ffmpegTestState.instances[0].exec).toHaveBeenCalled()
    })

    const encodeCall = ffmpegTestState.instances[0].exec.mock.calls.find(
      ([args]) => (args as string[]).includes('-c:v'),
    )?.[0] as string[]
    const audioCall = ffmpegTestState.instances[0].exec.mock.calls.find(
      ([args]) => (args as string[]).includes('-c:a'),
    )?.[0] as string[]
    const videoFilter = encodeCall[encodeCall.indexOf('-vf') + 1]

    expect(encodeCall).toContain('medium')
    expect(encodeCall).toContain('19')
    expect(videoFilter).toContain('fps=30')
    expect(audioCall).toContain('5')
  })

  it('can disable the default 30 fps lock', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(
      input,
      new File(['clip'], 'free-run.mp4', { type: 'video/mp4' }),
    )

    await user.click(screen.getByRole('button', { name: /disable 30 fps lock/i }))
    await user.click(
      screen.getByText('Fastest').closest('button') as HTMLButtonElement,
    )
    await user.click(screen.getByRole('button', { name: /build content pack/i }))

    await waitFor(() => {
      expect(ffmpegTestState.instances[0].exec).toHaveBeenCalled()
    })

    const encodeCall = ffmpegTestState.instances[0].exec.mock.calls.find(
      ([args]) => (args as string[]).includes('-c:v'),
    )?.[0] as string[]
    const videoFilter = encodeCall[encodeCall.indexOf('-vf') + 1]

    expect(encodeCall).toContain('veryfast')
    expect(videoFilter).not.toContain('fps=30')
  })

  it('can switch output resolution to 720p', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(
      input,
      new File(['clip'], 'midfield.mp4', { type: 'video/mp4' }),
    )

    await user.click(
      screen.getByRole('button', { name: /set output resolution to 720p/i }),
    )
    await user.click(screen.getByRole('button', { name: /build content pack/i }))

    await waitFor(() => {
      expect(ffmpegTestState.instances[0].exec).toHaveBeenCalled()
    })

    const encodeCall = ffmpegTestState.instances[0].exec.mock.calls.find(
      ([args]) => (args as string[]).includes('-c:v'),
    )?.[0] as string[]
    const videoFilter = encodeCall[encodeCall.indexOf('-vf') + 1]

    expect(videoFilter).toContain('scale=1280:720')
    expect(videoFilter).toContain('pad=1280:720')
  })

  it('shows the active step while compiling', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    await user.upload(
      input,
      new File(['clip'], 'countdown.mp4', { type: 'video/mp4' }),
    )

    await user.click(screen.getByRole('button', { name: /build content pack/i }))

    expect(await screen.findByText('Current step')).toBeInTheDocument()
    expect(await screen.findByText('Pack ready')).toBeInTheDocument()
  })
})
