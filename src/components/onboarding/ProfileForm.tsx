'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Cropper, { type Area } from 'react-easy-crop'
import { UserCircle2, Upload, RotateCcw, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/lib/supabase/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'

interface ProfileFormProps {
  userId: string
  initial: Profile | null
  headshotUrl: string | null
  /** "onboarding" → redirect to /calendar on save (forced first-time flow).
   *  "settings"   → stay on the page, just show a toast. */
  mode?: 'onboarding' | 'settings'
}

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const OUTPUT_SIZE = 512 // square edge for the cropped JPEG we upload

export function ProfileForm({ userId, initial, headshotUrl, mode = 'onboarding' }: ProfileFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [phone,        setPhone]        = useState(initial?.phone        ?? '')
  const [height,       setHeight]       = useState(initial?.height       ?? '')
  const [weight,       setWeight]       = useState(initial?.weight       ?? '')
  const [hairColor,    setHairColor]    = useState(initial?.hair_color   ?? '')
  const [eyeColor,     setEyeColor]     = useState(initial?.eye_color    ?? '')
  const [topSize,      setTopSize]      = useState(initial?.top_size     ?? '')
  const [bottomSize,   setBottomSize]   = useState(initial?.bottom_size  ?? '')
  const [shoeSize,     setShoeSize]     = useState(initial?.shoe_size    ?? '')

  // Photo workflow:
  //   sourceUrl = full picked image, used by the cropper
  //   croppedFile = output of canvas crop (what we upload)
  //   croppedPreview = blob URL of the cropped output (what shows in the avatar circle)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [croppedFile, setCroppedFile] = useState<File | null>(null)
  const [croppedPreview, setCroppedPreview] = useState<string | null>(headshotUrl)

  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const onCropComplete = useCallback((_a: Area, areaPx: Area) => setCroppedAreaPixels(areaPx), [])

  const hasExistingPhoto = !!initial?.headshot_path
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    const f = e.target.files?.[0]
    if (!f) return
    if (!ACCEPTED_TYPES.includes(f.type)) {
      setError('Headshot must be JPG, PNG, or WebP.')
      return
    }
    if (f.size > MAX_BYTES) {
      setError('Headshot must be smaller than 5 MB.')
      return
    }
    // iOS sometimes mislabels HEIC as image/jpeg. Sniff the magic bytes.
    const head = new Uint8Array(await f.slice(0, 12).arrayBuffer())
    const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    const isPng  = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
                && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
    const isHeic = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
    if (isHeic) {
      setError('iPhone HEIC photos aren’t supported by browsers. Convert to JPEG first (Preview → Export, or change iPhone camera to "Most Compatible") and try again.')
      return
    }
    if (!isJpeg && !isPng && !isWebp) {
      setError('Unsupported image format. Please use a real JPG, PNG, or WebP file.')
      return
    }

    setSourceUrl(URL.createObjectURL(f))
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
    setCroppedFile(null)
  }

  // Render the current crop region into a square JPEG and use it as the
  // file we upload + the avatar preview.
  async function applyCrop() {
    if (!sourceUrl || !croppedAreaPixels) return
    setError(null)
    try {
      const cropped = await renderCroppedJpeg(sourceUrl, croppedAreaPixels)
      setCroppedFile(cropped)
      setCroppedPreview(URL.createObjectURL(cropped))
      setSourceUrl(null) // exits crop mode
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not crop the photo.')
    }
  }

  function discardCrop() {
    setSourceUrl(null)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const required = [
      ['Phone', phone],
      ['Height', height],
      ['Weight', weight],
      ['Hair color', hairColor],
      ['Eye color', eyeColor],
      ['Top size', topSize],
      ['Bottom size', bottomSize],
      ['Shoe size', shoeSize],
    ] as const
    for (const [label, value] of required) {
      if (!value.trim()) { setError(`${label} is required.`); return }
    }
    if (!croppedFile && !hasExistingPhoto) {
      setError('A headshot is required.')
      return
    }
    if (sourceUrl) {
      setError('Apply your crop before saving.')
      return
    }

    setSaving(true)
    const supabase = createClient()

    let headshotPath = initial?.headshot_path ?? null

    if (croppedFile) {
      const path = `${userId}/avatar.jpg`
      const { error: uploadErr } = await supabase.storage
        .from('headshots')
        .upload(path, croppedFile, { upsert: true, contentType: 'image/jpeg' })
      if (uploadErr) {
        setSaving(false)
        setError(`Photo upload failed: ${uploadErr.message}`)
        return
      }
      headshotPath = path
    }

    const { error: updateErr } = await supabase
      .from('profiles')
      .update({
        phone:         phone.trim(),
        height:        height.trim(),
        weight:        weight.trim(),
        hair_color:    hairColor.trim(),
        eye_color:     eyeColor.trim(),
        top_size:      topSize.trim(),
        bottom_size:   bottomSize.trim(),
        shoe_size:     shoeSize.trim(),
        headshot_path: headshotPath,
      })
      .eq('id', userId)

    setSaving(false)
    if (updateErr) { setError(updateErr.message); return }

    if (mode === 'onboarding') {
      // After profile completion, take new hosts to the brand request step.
      // They can skip from there straight to /calendar.
      router.push('/onboarding/brands')
      router.refresh()
    } else {
      toast({ title: 'Profile updated' })
      // If they swapped photos, the croppedFile gets consumed; reset state so
      // the avatar circle now shows the just-uploaded version via the API URL.
      setCroppedFile(null)
      setCroppedPreview(`/api/headshot/${userId}?t=${Date.now()}`)
      router.refresh()
    }
  }

  return (
    <div className="space-y-6">
      <div className={mode === 'settings' ? '' : 'text-center'}>
        <h1 className="text-xl font-bold text-foreground">
          {mode === 'settings' ? 'Profile settings' : 'Complete your profile'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {mode === 'settings'
            ? 'Update your profile details and headshot. All fields are required.'
            : 'A few details so the team knows who you are. All fields are required.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-6 space-y-5">
        {/* Pre-filled */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-4 border-b border-border">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Name</p>
            <p className="text-sm text-foreground mt-0.5">{initial?.full_name || '—'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Email</p>
            <p className="text-sm text-foreground mt-0.5 truncate">{initial?.email || '—'}</p>
          </div>
        </div>

        {/* Headshot */}
        <div className="space-y-3">
          <Label>Headshot <span className="text-destructive">*</span></Label>

          {sourceUrl ? (
            // ── Crop mode ────────────────────────────────────────────
            <div className="space-y-3">
              <div className="relative w-full h-72 bg-secondary rounded-lg overflow-hidden">
                <Cropper
                  image={sourceUrl}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  cropShape="round"
                  showGrid={false}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={onCropComplete}
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Zoom</span>
                  <span>{zoom.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.01}
                  value={zoom}
                  onChange={e => setZoom(parseFloat(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
              <p className="text-[11px] text-muted-foreground text-center">
                Drag the photo to position. Pinch / wheel to zoom too.
              </p>
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="outline" size="sm" onClick={discardCrop} className="gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" />
                  Discard
                </Button>
                <Button type="button" size="sm" onClick={applyCrop} className="gap-1.5">
                  <Check className="w-3.5 h-3.5" />
                  Apply crop
                </Button>
              </div>
            </div>
          ) : (
            // ── Preview / picker mode ───────────────────────────────
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-full bg-secondary border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                {croppedPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={croppedPreview} alt="Headshot preview" className="w-full h-full object-cover" />
                ) : (
                  <UserCircle2 className="w-10 h-10 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handlePickFile}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {croppedPreview ? 'Replace photo' : 'Upload photo'}
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  JPG, PNG, or WebP. Max 5 MB. You can crop & zoom after picking.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Contact */}
        <Field id="phone" label="Phone" value={phone} setValue={setPhone} placeholder="(555) 123-4567" />

        {/* Physical attributes */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="height" label="Height" value={height} setValue={setHeight} placeholder={`5'10"`} />
          <Field id="weight" label="Weight" value={weight} setValue={setWeight} placeholder="170 lbs" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="hair" label="Hair color" value={hairColor} setValue={setHairColor} placeholder="Brown" />
          <Field id="eye"  label="Eye color"  value={eyeColor}  setValue={setEyeColor}  placeholder="Hazel" />
        </div>

        {/* Sizing */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field id="top"    label="Top size"    value={topSize}    setValue={setTopSize}    placeholder="M" />
          <Field id="bottom" label="Bottom size" value={bottomSize} setValue={setBottomSize} placeholder="32x32" />
          <Field id="shoe"   label="Shoe size"   value={shoeSize}   setValue={setShoeSize}   placeholder="10.5" />
        </div>

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={saving || !!sourceUrl}>
          {saving ? 'Saving…' : mode === 'settings' ? 'Save changes' : 'Complete profile'}
        </Button>
      </form>
    </div>
  )
}

function Field({
  id, label, value, setValue, placeholder,
}: {
  id: string
  label: string
  value: string
  setValue: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label} <span className="text-destructive">*</span></Label>
      <Input
        id={id}
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder}
        required
      />
    </div>
  )
}

// Render the cropper's selected pixel region into a square JPEG File
async function renderCroppedJpeg(imageSrc: string, area: Area): Promise<File> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.drawImage(
    image,
    area.x, area.y, area.width, area.height,
    0, 0, OUTPUT_SIZE, OUTPUT_SIZE,
  )
  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(b => resolve(b), 'image/jpeg', 0.9)
  )
  if (!blob) throw new Error('Could not encode JPEG')
  return new File([blob], 'avatar.jpg', { type: 'image/jpeg' })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
