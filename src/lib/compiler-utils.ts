export type JobStatus =
  | 'queued'
  | 'probing'
  | 'encoding'
  | 'extracting'
  | 'done'
  | 'error'

export type CompileJob = {
  id: string
  file: File
  order: number
  status: JobStatus
  progress: number
  etaSeconds: number | null
  outputVideoName: string
  outputAudioName: string
  durationSeconds: number | null
  hasAudio: boolean | null
  error: string | null
  videoSize: number | null
  audioSize: number | null
}

export function createJob(file: File): CompileJob {
  return {
    id: buildJobId(file),
    file,
    order: 0,
    status: 'queued',
    progress: 0,
    etaSeconds: null,
    outputVideoName: '',
    outputAudioName: '',
    durationSeconds: null,
    hasAudio: null,
    error: null,
    videoSize: null,
    audioSize: null,
  }
}

export function normalizeJobs(jobs: CompileJob[]): CompileJob[] {
  const seen = new Map<string, number>()

  return jobs.map((job, index) => {
    const safeStem = sanitizeClipStem(removeExtension(job.file.name))
    const count = (seen.get(safeStem) ?? 0) + 1
    seen.set(safeStem, count)
    const uniqueStem = count > 1 ? `${safeStem}-${count}` : safeStem
    const prefix = String(index + 1).padStart(2, '0')

    return {
      ...job,
      order: index + 1,
      outputVideoName: `${prefix}-${uniqueStem}.mp4`,
      outputAudioName: `${prefix}-${uniqueStem}.ogg`,
      status: 'queued',
      progress: 0,
      etaSeconds: null,
      error: null,
      videoSize: null,
      audioSize: null,
      durationSeconds: null,
      hasAudio: null,
    }
  })
}

export function removeExtension(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

export function sanitizeClipStem(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/[_\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'clip'
  )
}

export function sanitizeManifestName(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[^\w]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64)
  )
}

export function sanitizeVersion(value: string) {
  const trimmed = value.trim()
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : ''
}

export function formatBytes(value: number) {
  if (!value) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  )
  const amount = value / 1024 ** exponent
  return `${amount.toFixed(amount >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatClock(seconds: number) {
  const total = Math.max(Math.round(seconds), 0)
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function formatEta(seconds: number) {
  const total = Math.max(Math.round(seconds), 0)
  if (total < 60) {
    return `${total}s`
  }

  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}

export function makeWorkspaceName(name: string, id: string, prefix: string) {
  const safeName = name.replace(/[^\w.-]+/g, '-')
  return `${prefix}-${id.slice(0, 8)}-${safeName}`
}

export function trimForIcon(value: string) {
  return value.trim().slice(0, 18).toUpperCase() || 'VIDEO PACK'
}

export function getTimestamp() {
  return performance.now()
}

export function buildJobId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${createUniqueToken()}`
}

export function createUniqueToken() {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function hasVideoDrag(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return false
  }

  return Array.from(dataTransfer.types).includes('Files')
}
