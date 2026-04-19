import { describe, expect, it } from 'vitest'
import {
  createJob,
  createUniqueToken,
  formatBytes,
  formatEta,
  hasVideoDrag,
  normalizeJobs,
  normalizeStageProgress,
  sanitizeManifestName,
  sanitizeVersion,
  stageLabel,
} from './compiler-utils'

describe('compiler-utils', () => {
  it('normalizes queue order and deduplicates output stems', () => {
    const first = createJob(new File(['a'], 'My Clip!.mp4', { type: 'video/mp4' }))
    const second = createJob(
      new File(['b'], 'My Clip!.mov', { type: 'video/quicktime' }),
    )

    const jobs = normalizeJobs([first, second])

    expect(jobs[0].outputVideoName).toBe('01-my-clip.mp4')
    expect(jobs[0].outputAudioName).toBe('01-my-clip.ogg')
    expect(jobs[1].outputVideoName).toBe('02-my-clip-2.mp4')
    expect(jobs[1].outputAudioName).toBe('02-my-clip-2.ogg')
  })

  it('formats manifest names and versions conservatively', () => {
    expect(sanitizeManifestName('Driving Range Videos!!!')).toBe(
      'Driving_Range_Videos',
    )
    expect(sanitizeVersion('1.2.3')).toBe('1.2.3')
    expect(sanitizeVersion('v1.2.3')).toBe('')
  })

  it('formats bytes and eta strings for display', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatEta(59)).toBe('59s')
    expect(formatEta(90)).toBe('1m 30s')
  })

  it('falls back when crypto.randomUUID is unavailable', () => {
    const originalCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    })

    const token = createUniqueToken()
    expect(token).toMatch(/^[a-z0-9]+-[a-z0-9]+$/i)

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    })
  })

  it('detects file drags from data transfer types', () => {
    expect(hasVideoDrag({ types: ['Files'] } as unknown as DataTransfer)).toBe(
      true,
    )
    expect(
      hasVideoDrag({ types: ['text/plain'] } as unknown as DataTransfer),
    ).toBe(false)
    expect(hasVideoDrag(null)).toBe(false)
  })

  it('normalizes stage progress from ffmpeg time when duration is known', () => {
    expect(normalizeStageProgress(0.05, 5_000_000, 10)).toBe(0.5)
    expect(normalizeStageProgress(0.05, 5_000, 10)).toBe(0.5)
    expect(normalizeStageProgress(0.25, 0, null)).toBe(0.25)
  })

  it('derives a readable step label from the current stage', () => {
    expect(stageLabel('queued')).toBe('Queued')
    expect(stageLabel('probing')).toBe('Inspecting source file')
    expect(stageLabel('encoding', 0.01)).toBe('Starting encode')
    expect(stageLabel('encoding', 0.5)).toBe('Encoding video')
    expect(stageLabel('extracting', 1)).toBe('Finalizing audio')
  })
})
