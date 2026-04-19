import {
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type DragEvent,
} from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import JSZip from 'jszip'
import ffmpegCoreUrl from '@ffmpeg/core?url'
import ffmpegCoreWasmUrl from '@ffmpeg/core/wasm?url'
import {
  createJob,
  formatBytes,
  formatClock,
  formatEta,
  getTimestamp,
  hasVideoDrag,
  makeWorkspaceName,
  normalizeJobs,
  sanitizeManifestName,
  sanitizeVersion,
  trimForIcon,
  type CompileJob,
} from './lib/compiler-utils'
import './App.css'

const MAX_FILES = 20
const TARGET_WIDTH = 1920
const TARGET_HEIGHT = 1080
const THEATER_DEPENDENCY = 'Cray-DrivingRangeTheater-0.1.0'

type JobStage = 'idle' | 'probing' | 'encoding' | 'extracting'

type PackSettings = {
  namespace: string
  packageName: string
  displayName: string
  version: string
  websiteUrl: string
  description: string
  readmeNotes: string
}

type EncodingPresetId = 'fastest' | 'balanced' | 'quality'

type EncodingPreset = {
  id: EncodingPresetId
  label: string
  description: string
  videoPreset: string
  crf: string
  audioQuality: string
  etaHint: string
}

type BuiltAsset = {
  videoName: string
  audioName: string | null
  videoData: Uint8Array
  audioData: Uint8Array | null
  durationSeconds: number | null
}

type DownloadBundle = {
  blobUrl: string
  fileName: string
  byteLength: number
  generatedAt: string
}

type RuntimeState = {
  jobId: string | null
  stage: JobStage
  startedAt: number
}

const defaultSettings: PackSettings = {
  namespace: 'Cray',
  packageName: 'DrivingRangeTheaterVideos',
  displayName: 'Driving Range Theater Videos',
  version: '1.0.0',
  websiteUrl: 'https://github.com/Calen-Ray/SBG-driving-range-theater',
  description:
    'Browser-built content pack for the DrivingRangeTheater mod.',
  readmeNotes:
    'Generated with the Theater Video Compiler. All clips are re-encoded to 1920x1080 H.264/yuv420p with matching OGG sidecar audio when available.',
}

const stageWeights: Record<JobStage, { start: number; span: number }> = {
  idle: { start: 0, span: 0 },
  probing: { start: 0.02, span: 0.08 },
  encoding: { start: 0.1, span: 0.72 },
  extracting: { start: 0.82, span: 0.16 },
}

const encodingPresets: EncodingPreset[] = [
  {
    id: 'fastest',
    label: 'Fastest',
    description: 'Prioritizes speed and smaller wait times over compression efficiency.',
    videoPreset: 'ultrafast',
    crf: '25',
    audioQuality: '3',
    etaHint: 'Best for quick drafts',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default compromise between encode time, output size, and visual quality.',
    videoPreset: 'veryfast',
    crf: '22',
    audioQuality: '4',
    etaHint: 'Good default for most packs',
  },
  {
    id: 'quality',
    label: 'Quality',
    description: 'Spends more CPU time to preserve detail and reduce visible artifacts.',
    videoPreset: 'medium',
    crf: '19',
    audioQuality: '5',
    etaHint: 'Slowest, highest quality',
  },
]

function App() {
  const [jobs, setJobs] = useState<CompileJob[]>([])
  const [packSettings, setPackSettings] = useState<PackSettings>(defaultSettings)
  const [encodingPresetId, setEncodingPresetId] =
    useState<EncodingPresetId>('balanced')
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [ffmpegState, setFfmpegState] = useState<'idle' | 'loading' | 'ready'>(
    'idle',
  )
  const [engineMessage, setEngineMessage] = useState(
    'FFmpeg core not loaded yet.',
  )
  const [isCompiling, setIsCompiling] = useState(false)
  const [overallProgress, setOverallProgress] = useState(0)
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [downloadBundle, setDownloadBundle] = useState<DownloadBundle | null>(
    null,
  )
  const [logs, setLogs] = useState<string[]>([
    'Queue clips, set pack metadata, then build a zip for DrivingRangeTheater.',
  ])

  const ffmpegRef = useRef<FFmpeg | null>(null)
  const runtimeRef = useRef<RuntimeState>({
    jobId: null,
    stage: 'idle',
    startedAt: 0,
  })
  const jobsRef = useRef<CompileJob[]>([])
  const builtAssetsRef = useRef<Map<string, BuiltAsset>>(new Map())
  const dropzoneRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  useEffect(() => {
    return () => {
      if (downloadBundle) {
        URL.revokeObjectURL(downloadBundle.blobUrl)
      }
    }
  }, [downloadBundle])

  const totalInputBytes = useMemo(
    () => jobs.reduce((sum, job) => sum + job.file.size, 0),
    [jobs],
  )

  const totalOutputBytes = useMemo(
    () =>
      jobs.reduce(
        (sum, job) => sum + (job.videoSize ?? 0) + (job.audioSize ?? 0),
        0,
      ),
    [jobs],
  )

  const completedJobs = useMemo(
    () => jobs.filter((job) => job.status === 'done').length,
    [jobs],
  )

  const overallEta = useMemo(() => {
    if (!jobs.length) {
      return null
    }

    const active = jobs.find((job) => job.id === currentJobId)
    if (active?.etaSeconds != null) {
      const remainingJobs = jobs.length - active.order
      const completedDurations = jobs
        .filter((job) => job.status === 'done' && job.durationSeconds != null)
        .map((job) => job.durationSeconds ?? 0)
      const avgCompleted =
        completedDurations.length > 0
          ? completedDurations.reduce((sum, value) => sum + value, 0) /
            completedDurations.length
          : 75
      return active.etaSeconds + remainingJobs * Math.max(avgCompleted * 1.2, 20)
    }

    return null
  }, [currentJobId, jobs])

  const statusLabel = useMemo(() => {
    if (isCompiling) {
      return 'Building pack'
    }
    if (downloadBundle) {
      return 'Build complete'
    }
    return 'Ready'
  }, [downloadBundle, isCompiling])

  const activePreset = useMemo(
    () =>
      encodingPresets.find((preset) => preset.id === encodingPresetId) ??
      encodingPresets[1],
    [encodingPresetId],
  )

  const appendLog = (entry: string) => {
    startTransition(() => {
      setLogs((current) => [entry, ...current].slice(0, 160))
    })
  }

  const replaceJobs = (nextJobs: CompileJob[]) => {
    setJobs(normalizeJobs(nextJobs))
    resetDownload()
  }

  const resetDownload = () => {
    setDownloadBundle((current) => {
      if (current) {
        URL.revokeObjectURL(current.blobUrl)
      }
      return null
    })
  }

  const handleFilesAdded = (incoming: FileList | File[]) => {
    const files = Array.from(incoming).filter((file) => file.type.startsWith('video/') || /\.(mp4|mkv|mov|webm|ogv|m4v)$/i.test(file.name))
    if (!files.length) {
      appendLog('Ignored selection because no supported video files were found.')
      return
    }

    const merged = [...jobsRef.current.map((job) => job.file)]
    for (const file of files) {
      if (merged.length >= MAX_FILES) {
        appendLog(`Queue capped at ${MAX_FILES} files.`)
        break
      }

      const duplicate = merged.some(
        (existing) =>
          existing.name === file.name &&
          existing.size === file.size &&
          existing.lastModified === file.lastModified,
      )

      if (!duplicate) {
        merged.push(file)
      }
    }

    replaceJobs(merged.map(createJob))
  }

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (isCompiling || !hasVideoDrag(event.dataTransfer)) {
      return
    }

    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (isCompiling || !hasVideoDrag(event.dataTransfer)) {
      return
    }

    event.dataTransfer.dropEffect = 'copy'
    if (!isDraggingFiles) {
      setIsDraggingFiles(true)
    }
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (isCompiling || !hasVideoDrag(event.dataTransfer)) {
      return
    }

    dragDepthRef.current = Math.max(dragDepthRef.current - 1, 0)
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)

    if (isCompiling || !event.dataTransfer.files.length) {
      return
    }

    handleFilesAdded(event.dataTransfer.files)
  }

  const moveJob = (id: string, direction: -1 | 1) => {
    if (isCompiling) {
      return
    }

    const next = [...jobsRef.current]
    const index = next.findIndex((job) => job.id === id)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= next.length) {
      return
    }

    const [job] = next.splice(index, 1)
    next.splice(targetIndex, 0, job)
    replaceJobs(next)
  }

  const removeJob = (id: string) => {
    if (isCompiling) {
      return
    }

    replaceJobs(jobsRef.current.filter((job) => job.id !== id))
  }

  const updateSettings = <K extends keyof PackSettings>(
    key: K,
    value: PackSettings[K],
  ) => {
    resetDownload()
    setPackSettings((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const ensureFfmpeg = async () => {
    if (!ffmpegRef.current) {
      const ffmpeg = new FFmpeg()
      ffmpeg.on('progress', ({ progress }) => {
        const runtime = runtimeRef.current
        if (!runtime.jobId || runtime.stage === 'idle') {
          return
        }

        const stageWeight = stageWeights[runtime.stage]
        const clampedProgress = Math.min(Math.max(progress, 0), 1)
        const overallJobProgress =
          stageWeight.start + clampedProgress * stageWeight.span
        const elapsedSeconds = (performance.now() - runtime.startedAt) / 1000
        const etaSeconds =
          overallJobProgress > 0.025
            ? Math.max(elapsedSeconds / overallJobProgress - elapsedSeconds, 0)
            : null

        setJobs((current) =>
          current.map((job) =>
            job.id === runtime.jobId
              ? {
                  ...job,
                  progress: overallJobProgress,
                  etaSeconds,
                }
              : job,
          ),
        )

        const queue = jobsRef.current
        const totalProgress =
          queue.reduce((sum, job) => sum + job.progress, 0) /
          Math.max(queue.length, 1)
        setOverallProgress(totalProgress)
      })

      ffmpeg.on('log', ({ message }) => {
        if (/error|failed|invalid/i.test(message)) {
          appendLog(message)
        }
      })

      ffmpegRef.current = ffmpeg
    }

    if (ffmpegRef.current.loaded) {
      setFfmpegState('ready')
      setEngineMessage('FFmpeg core loaded in browser memory.')
      return ffmpegRef.current
    }

    setFfmpegState('loading')
    setEngineMessage('Loading FFmpeg core and WebAssembly runtime...')

    try {
      const coreURL = await toBlobURL(ffmpegCoreUrl, 'text/javascript')
      const wasmURL = await toBlobURL(ffmpegCoreWasmUrl, 'application/wasm')

      await ffmpegRef.current.load({
        coreURL,
        wasmURL,
      })
    } catch (error) {
      setFfmpegState('idle')
      setEngineMessage('FFmpeg failed to load. Check browser console or try a Chromium-based browser.')
      throw error
    }

    setFfmpegState('ready')
    setEngineMessage('FFmpeg core loaded in browser memory.')
    appendLog('FFmpeg core loaded.')
    return ffmpegRef.current
  }

  const buildPack = async () => {
    if (isCompiling || jobsRef.current.length === 0) {
      return
    }

    if (jobsRef.current.length > MAX_FILES) {
      appendLog(`Reduce the queue to ${MAX_FILES} files or fewer.`)
      return
    }

    const manifestName = sanitizeManifestName(packSettings.packageName)
    if (!manifestName) {
      appendLog('Package name must contain at least one letter or number.')
      return
    }

    const namespace = sanitizeManifestName(packSettings.namespace)
    if (!namespace) {
      appendLog('Namespace must contain at least one letter or number.')
      return
    }

    const version = sanitizeVersion(packSettings.version)
    if (!version) {
      appendLog('Version must be in Major.Minor.Patch form, for example 1.0.0.')
      return
    }

    resetDownload()
    builtAssetsRef.current.clear()
    setIsCompiling(true)
    setOverallProgress(0)
    setCurrentJobId(null)

    setJobs((current) =>
      current.map((job) => ({
        ...job,
        status: 'queued',
        progress: 0,
        etaSeconds: null,
        durationSeconds: null,
        hasAudio: null,
        error: null,
        videoSize: null,
        audioSize: null,
      })),
    )

    try {
      const ffmpeg = await ensureFfmpeg()

      for (const job of jobsRef.current) {
        setCurrentJobId(job.id)
        runtimeRef.current = {
          jobId: job.id,
          stage: 'probing',
          startedAt: getTimestamp(),
        }

        setJobs((current) =>
          current.map((entry) =>
            entry.id === job.id
              ? {
                  ...entry,
                  status: 'probing',
                  progress: stageWeights.probing.start,
                  etaSeconds: null,
                }
              : entry,
          ),
        )

        appendLog(`Preparing ${job.file.name}`)

        const inputName = makeWorkspaceName(job.file.name, job.id, 'source')
        const encodedName = makeWorkspaceName(job.outputVideoName, job.id, 'encoded')
        const audioName = makeWorkspaceName(job.outputAudioName, job.id, 'audio')
        const probeDurationName = makeWorkspaceName('duration.txt', job.id, 'probe')
        const probeAudioName = makeWorkspaceName('audio.txt', job.id, 'probe')

        await ffmpeg.writeFile(inputName, await fetchFile(job.file))

        try {
          const durationSeconds = await probeDuration(ffmpeg, inputName, probeDurationName)
          const hasAudio = await probeHasAudio(ffmpeg, inputName, probeAudioName)

          setJobs((current) =>
            current.map((entry) =>
              entry.id === job.id
                ? {
                    ...entry,
                    durationSeconds,
                    hasAudio,
                    progress: stageWeights.probing.start + stageWeights.probing.span,
                  }
                : entry,
            ),
          )

          runtimeRef.current = {
            jobId: job.id,
            stage: 'encoding',
            startedAt: getTimestamp(),
          }

          setJobs((current) =>
            current.map((entry) =>
              entry.id === job.id
                ? {
                    ...entry,
                    status: 'encoding',
                    progress: stageWeights.encoding.start,
                  }
                : entry,
            ),
          )

          appendLog(`Encoding ${job.outputVideoName}`)

          const encodeExitCode = await ffmpeg.exec([
            '-i',
            inputName,
            '-vf',
            `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
            '-c:v',
            'libx264',
            '-profile:v',
            'high',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            activePreset.videoPreset,
            '-crf',
            activePreset.crf,
            '-movflags',
            '+faststart',
            '-an',
            encodedName,
          ])

          if (encodeExitCode !== 0) {
            throw new Error(`Video encode failed with exit code ${encodeExitCode}.`)
          }

          const encodedData = await readUint8Array(ffmpeg, encodedName)
          let audioData: Uint8Array | null = null

          if (hasAudio) {
            runtimeRef.current = {
              jobId: job.id,
              stage: 'extracting',
              startedAt: getTimestamp(),
            }

            setJobs((current) =>
              current.map((entry) =>
                entry.id === job.id
                  ? {
                      ...entry,
                      status: 'extracting',
                      progress: stageWeights.extracting.start,
                    }
                  : entry,
              ),
            )

            appendLog(`Extracting ${job.outputAudioName}`)

            const audioExitCode = await ffmpeg.exec([
              '-i',
              inputName,
              '-vn',
              '-c:a',
              'libvorbis',
              '-q:a',
              activePreset.audioQuality,
              audioName,
            ])

            if (audioExitCode === 0) {
              audioData = await readUint8Array(ffmpeg, audioName)
            } else {
              appendLog(`Audio extraction failed for ${job.file.name}; video will remain silent.`)
            }
          }

          builtAssetsRef.current.set(job.id, {
            videoName: job.outputVideoName,
            audioName: audioData ? job.outputAudioName : null,
            videoData: encodedData,
            audioData,
            durationSeconds,
          })

          setJobs((current) =>
            current.map((entry) =>
              entry.id === job.id
                ? {
                    ...entry,
                    status: 'done',
                    progress: 1,
                    etaSeconds: 0,
                    videoSize: encodedData.byteLength,
                    audioSize: audioData?.byteLength ?? null,
                  }
                : entry,
            ),
          )

          appendLog(`Finished ${job.outputVideoName}`)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown compile failure.'

          setJobs((current) =>
            current.map((entry) =>
              entry.id === job.id
                ? {
                    ...entry,
                    status: 'error',
                    error: message,
                    etaSeconds: null,
                  }
                : entry,
            ),
          )

          appendLog(`Failed ${job.file.name}: ${message}`)
          throw error
        } finally {
          runtimeRef.current = {
            jobId: null,
            stage: 'idle',
            startedAt: 0,
          }

          await cleanupWorkspace(
            ffmpeg,
            [inputName, encodedName, audioName, probeDurationName, probeAudioName],
          )
        }

        const queueProgress =
          jobsRef.current.reduce((sum, entry) => sum + entry.progress, 0) /
          Math.max(jobsRef.current.length, 1)
        setOverallProgress(queueProgress)
      }

      appendLog('Packaging zip archive...')
      const zipBlob = await buildZipArchive(
        manifestName,
        version,
        packSettings,
        activePreset,
        jobsRef.current,
        builtAssetsRef.current,
      )
      const fileName = `${namespace}-${manifestName}-${version}.zip`
      const blobUrl = URL.createObjectURL(zipBlob)

      setDownloadBundle({
        blobUrl,
        fileName,
        byteLength: zipBlob.size,
        generatedAt: new Date().toLocaleString(),
      })
      setOverallProgress(1)
      appendLog(`Pack ready: ${fileName}`)
    } catch (error) {
      appendLog(
        error instanceof Error
          ? error.message
          : 'Build stopped because of an unknown error.',
      )
    } finally {
      setCurrentJobId(null)
      setIsCompiling(false)
    }
  }

  const canBuild = jobs.length > 0 && !isCompiling && ffmpegState !== 'loading'

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">DrivingRangeTheater compiler</p>
          <h1>Turn raw clips into a drop-in theater content pack.</h1>
          <p className="hero-summary">
            Re-encode up to {MAX_FILES} mixed-format videos into {TARGET_WIDTH}x
            {TARGET_HEIGHT} H.264 MP4, extract matching OGG sidecar audio, then
            export a Thunderstore-style zip with <code>Videos/</code> at the
            root.
          </p>
          <div className="hero-metrics">
            <div>
              <span>Queue</span>
              <strong>
                {jobs.length}/{MAX_FILES}
              </strong>
            </div>
            <div>
              <span>Input</span>
              <strong>{formatBytes(totalInputBytes)}</strong>
            </div>
            <div>
              <span>Output</span>
              <strong>{totalOutputBytes ? formatBytes(totalOutputBytes) : 'Pending'}</strong>
            </div>
            <div>
              <span>Engine</span>
              <strong>{ffmpegState === 'ready' ? 'Warm' : ffmpegState}</strong>
            </div>
          </div>
        </div>

        <div className="status-card">
          <div className="status-heading">
            <p>Status</p>
            <strong>{statusLabel}</strong>
          </div>
          <div className="progress-meter">
            <div
              className="progress-fill"
              style={{ width: `${Math.round(overallProgress * 100)}%` }}
            />
          </div>
          <div className="status-grid">
            <div>
              <span>Completed</span>
              <strong>
                {completedJobs}/{jobs.length || 0}
              </strong>
            </div>
            <div>
              <span>ETA</span>
              <strong>{overallEta != null ? formatEta(overallEta) : 'Tracking'}</strong>
            </div>
          </div>
          <p className="engine-message">{engineMessage}</p>
          <div className="rule-note">
            Output rule: matching basenames such as <code>01-intro.mp4</code>{' '}
            and <code>01-intro.ogg</code>, sorted alphabetically by filename in
            the mod.
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div
          className={`panel queue-panel ${isDraggingFiles ? 'drag-active' : ''}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="panel-header">
            <div>
              <p className="panel-kicker">1. Queue</p>
              <h2>Source videos</h2>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={() => dropzoneRef.current?.click()}
              disabled={isCompiling}
            >
              Add files
            </button>
          </div>

          <label
            className={`dropzone ${isCompiling ? 'disabled' : ''} ${isDraggingFiles ? 'drag-active' : ''}`}
          >
            <input
              ref={dropzoneRef}
              type="file"
              accept="video/*,.mp4,.mkv,.mov,.webm,.ogv,.m4v"
              multiple
              disabled={isCompiling}
              onChange={(event) => {
                if (event.target.files) {
                  handleFilesAdded(event.target.files)
                }
                event.currentTarget.value = ''
              }}
            />
            <span>Drop clips here or browse</span>
            <small>
              Mixed containers are fine. The compiler outputs standardized MP4 +
              OGG pairs.
            </small>
          </label>

          {jobs.length === 0 ? (
            <div className="empty-state">
              Queue is empty. Add between 1 and {MAX_FILES} video files to begin.
            </div>
          ) : (
            <ul className="job-list">
              {jobs.map((job, index) => (
                <li key={job.id} className={`job-card ${job.status}`}>
                  <div className="job-topline">
                    <div>
                      <span className="job-order">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <strong>{job.file.name}</strong>
                    </div>
                    <span className={`pill ${job.status}`}>{job.status}</span>
                  </div>

                  <div className="job-meta">
                    <span>{formatBytes(job.file.size)}</span>
                    <span>{job.durationSeconds ? formatClock(job.durationSeconds) : 'Duration pending'}</span>
                    <span>{job.hasAudio === false ? 'Silent source' : job.hasAudio ? 'Audio found' : 'Audio check pending'}</span>
                  </div>

                  <div className="job-output">
                    <code>{job.outputVideoName}</code>
                    <code>{job.outputAudioName}</code>
                  </div>

                  <div className="mini-progress">
                    <div
                      className="mini-progress-fill"
                      style={{ width: `${Math.round(job.progress * 100)}%` }}
                    />
                  </div>

                  <div className="job-footer">
                    <span>
                      {job.status === 'error'
                        ? job.error ?? 'Build failed'
                        : job.etaSeconds != null && job.status !== 'done'
                          ? `ETA ${formatEta(job.etaSeconds)}`
                          : job.status === 'done'
                            ? `Built ${formatBytes((job.videoSize ?? 0) + (job.audioSize ?? 0))}`
                            : 'Waiting'}
                    </span>
                    <div className="job-actions">
                      <button
                        type="button"
                        onClick={() => moveJob(job.id, -1)}
                        disabled={isCompiling || index === 0}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        onClick={() => moveJob(job.id, 1)}
                        disabled={isCompiling || index === jobs.length - 1}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        onClick={() => removeJob(job.id)}
                        disabled={isCompiling}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel settings-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">2. Pack</p>
              <h2>Metadata and export</h2>
            </div>
          </div>

          <div className="field-grid">
            <label>
              <span>Namespace</span>
              <input
                value={packSettings.namespace}
                disabled={isCompiling}
                onChange={(event) => updateSettings('namespace', event.target.value)}
              />
            </label>
            <label>
              <span>Package name</span>
              <input
                value={packSettings.packageName}
                disabled={isCompiling}
                onChange={(event) =>
                  updateSettings('packageName', event.target.value)
                }
              />
            </label>
            <label className="wide">
              <span>Display title</span>
              <input
                value={packSettings.displayName}
                disabled={isCompiling}
                onChange={(event) =>
                  updateSettings('displayName', event.target.value)
                }
              />
            </label>
            <label>
              <span>Version</span>
              <input
                value={packSettings.version}
                disabled={isCompiling}
                onChange={(event) => updateSettings('version', event.target.value)}
              />
            </label>
            <label className="wide">
              <span>Website URL</span>
              <input
                value={packSettings.websiteUrl}
                disabled={isCompiling}
                onChange={(event) =>
                  updateSettings('websiteUrl', event.target.value)
                }
              />
            </label>
            <label className="wide">
              <span>Description</span>
              <textarea
                rows={3}
                value={packSettings.description}
                disabled={isCompiling}
                onChange={(event) =>
                  updateSettings('description', event.target.value)
                }
              />
            </label>
            <label className="wide">
              <span>README notes</span>
              <textarea
                rows={4}
                value={packSettings.readmeNotes}
                disabled={isCompiling}
                onChange={(event) =>
                  updateSettings('readmeNotes', event.target.value)
                }
              />
            </label>
          </div>

          <div className="spec-grid">
            <div>
              <span>Encoding preset</span>
              <strong>{activePreset.label}</strong>
            </div>
            <div>
              <span>Video target</span>
              <strong>
                {TARGET_WIDTH}x{TARGET_HEIGHT}, H.264 High, yuv420p
              </strong>
            </div>
            <div>
              <span>Audio target</span>
              <strong>OGG Vorbis sidecar, same basename</strong>
            </div>
            <div>
              <span>Zip root</span>
              <strong>manifest.json, README.md, icon.png, Videos/</strong>
            </div>
            <div>
              <span>Dependency</span>
              <strong>{THEATER_DEPENDENCY}</strong>
            </div>
          </div>

          <div className="preset-grid">
            {encodingPresets.map((preset) => (
              <button
                key={preset.id}
                className={`preset-card ${
                  preset.id === activePreset.id ? 'active' : ''
                }`}
                type="button"
                disabled={isCompiling}
                onClick={() => setEncodingPresetId(preset.id)}
              >
                <span>{preset.label}</span>
                <strong>{preset.etaHint}</strong>
                <small>{preset.description}</small>
                <code>
                  x264 {preset.videoPreset} / CRF {preset.crf} / OGG q
                  {preset.audioQuality}
                </code>
              </button>
            ))}
          </div>

          <div className="build-actions">
            <button
              className="primary-button"
              type="button"
              disabled={!canBuild}
              onClick={() => void buildPack()}
            >
              {isCompiling ? 'Building...' : 'Build content pack'}
            </button>

            {downloadBundle ? (
              <a
                className="download-button"
                href={downloadBundle.blobUrl}
                download={downloadBundle.fileName}
              >
                Download {downloadBundle.fileName}
              </a>
            ) : (
              <div className="download-placeholder">
                Zip download appears here after a successful build.
              </div>
            )}
          </div>

          {downloadBundle ? (
            <div className="download-meta">
              <span>{formatBytes(downloadBundle.byteLength)}</span>
              <span>{downloadBundle.generatedAt}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel log-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">3. Activity</p>
            <h2>Compiler log</h2>
          </div>
        </div>
        <div className="log-list">
          {logs.map((entry, index) => (
            <p key={`${entry}-${index}`}>{entry}</p>
          ))}
        </div>
      </section>
    </main>
  )
}

async function buildZipArchive(
  manifestName: string,
  version: string,
  settings: PackSettings,
  preset: EncodingPreset,
  jobs: CompileJob[],
  builtAssets: Map<string, BuiltAsset>,
) {
  const zip = new JSZip()
  const manifest = {
    name: manifestName,
    version_number: version,
    website_url: settings.websiteUrl.trim() || 'https://github.com/',
    description:
      settings.description.trim() ||
      'Compiled video pack for DrivingRangeTheater.',
    dependencies: [THEATER_DEPENDENCY],
  }

  const clipLines = jobs
    .map((job) => {
      const built = builtAssets.get(job.id)
      return `- \`${built?.videoName ?? job.outputVideoName}\`${
        built?.audioName ? ` + \`${built.audioName}\`` : ' (silent)'
      }`
    })
    .join('\n')

  const readme = `# ${settings.displayName.trim() || manifestName}

${settings.readmeNotes.trim()}

## Included clips

${clipLines}

## Install

1. Install \`${THEATER_DEPENDENCY}\`.
2. Drop this zip into your mod manager, or extract its contents into a BepInEx plugin folder.
3. The mod will scan the package's \`Videos/\` directory on startup.

## Output format

- MP4 video encoded as H.264 High / yuv420p at ${TARGET_WIDTH}x${TARGET_HEIGHT}
- Matching OGG sidecar audio when an audio stream was present in the source
- Encode preset: ${preset.label} (x264 ${preset.videoPreset}, CRF ${preset.crf}, OGG q${preset.audioQuality})
- Filenames prefixed numerically so DrivingRangeTheater plays them in queue order
`

  const iconBlob = await createPackIcon(settings.displayName || manifestName)
  const iconBytes = new Uint8Array(await iconBlob.arrayBuffer())

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  zip.file('README.md', readme)
  zip.file('icon.png', iconBytes)

  const videosFolder = zip.folder('Videos')
  for (const job of jobs) {
    const built = builtAssets.get(job.id)
    if (!built) {
      continue
    }

    videosFolder?.file(built.videoName, built.videoData)
    if (built.audioName && built.audioData) {
      videosFolder?.file(built.audioName, built.audioData)
    }
  }

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

async function createPackIcon(title: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not create icon canvas.')
  }

  const gradient = context.createLinearGradient(0, 0, 256, 256)
  gradient.addColorStop(0, '#101728')
  gradient.addColorStop(0.45, '#1e2742')
  gradient.addColorStop(1, '#06080e')
  context.fillStyle = gradient
  context.fillRect(0, 0, 256, 256)

  context.fillStyle = 'rgba(99, 179, 237, 0.18)'
  context.fillRect(24, 48, 208, 140)
  context.strokeStyle = '#a3f7ff'
  context.lineWidth = 8
  context.strokeRect(24, 48, 208, 140)

  context.fillStyle = '#f97316'
  context.beginPath()
  context.arc(190, 78, 16, 0, Math.PI * 2)
  context.fill()

  context.fillStyle = '#e5eefb'
  context.font = '700 96px "Segoe UI", sans-serif'
  context.textAlign = 'center'
  context.fillText('TV', 128, 148)

  context.fillStyle = '#b8c4dd'
  context.font = '700 18px "Segoe UI", sans-serif'
  context.fillText(trimForIcon(title), 128, 215)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('Failed to render icon PNG.'))
      }
    }, 'image/png')
  })
}

async function probeDuration(ffmpeg: FFmpeg, inputName: string, outputName: string) {
  const exitCode = await ffmpeg.ffprobe([
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    inputName,
    '-o',
    outputName,
  ])

  if (exitCode !== 0) {
    return null
  }

  const text = await ffmpeg.readFile(outputName, 'utf8')
  const parsed = Number.parseFloat(String(text).trim())
  return Number.isFinite(parsed) ? parsed : null
}

async function probeHasAudio(ffmpeg: FFmpeg, inputName: string, outputName: string) {
  const exitCode = await ffmpeg.ffprobe([
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'csv=p=0',
    inputName,
    '-o',
    outputName,
  ])

  if (exitCode !== 0) {
    return false
  }

  const text = await ffmpeg.readFile(outputName, 'utf8')
  return String(text).trim().length > 0
}

async function readUint8Array(ffmpeg: FFmpeg, path: string) {
  const data = await ffmpeg.readFile(path)
  if (data instanceof Uint8Array) {
    return data
  }

  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }

  return new Uint8Array(data)
}

async function cleanupWorkspace(ffmpeg: FFmpeg, paths: string[]) {
  for (const path of paths) {
    try {
      await ffmpeg.deleteFile(path)
    } catch {
      // Best-effort cleanup so subsequent jobs start with a clean workspace.
    }
  }
}

export default App
