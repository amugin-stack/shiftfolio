'use client'

import { useCallback, useRef, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Upload, RotateCcw, Check, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { BrandLogo } from '@/components/brand/BrandLogo'

interface BrandLogoUploaderProps {
  brandId: string
  brandName: string
  /** Current logo path stored on the brand row */
  currentPath: string | null
  /** Called with the new logo_path (or null if removed) once persisted in storage. */
  onChange: (newPath: string | null) => void
}

const OUTPUT_SIZE = 512

/**
 * Square logo cropper for admin brand editing.
 * Uploads to public `brand-logos/{brandId}/logo.jpg` and reports the path
 * back to the parent so it can save it on the brand row.
 */
export function BrandLogoUploader({ brandId, brandName, currentPath, onChange }: BrandLogoUploaderProps) {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Local cache-bust key so the preview updates immediately after re-upload
  const [version, setVersion] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  function pickFile() {
    fileRef.current?.click()
  }

  function handlePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be 5 MB or smaller.')
      return
    }
    setError(null)
    const reader = new FileReader()
    reader.onload = () => {
      setSourceUrl(typeof reader.result === 'string' ? reader.result : null)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      setCroppedArea(null)
    }
    reader.readAsDataURL(file)
    // Reset input so re-picking the same file fires onChange
    e.target.value = ''
  }

  const onCropComplete = useCallback((_pixels: Area, areaPixels: Area) => {
    setCroppedArea(areaPixels)
  }, [])

  function discard() {
    setSourceUrl(null)
    setCroppedArea(null)
  }

  async function applyAndUpload() {
    if (!sourceUrl || !croppedArea) return
    setBusy(true)
    setError(null)
    try {
      const file = await renderCroppedJpeg(sourceUrl, croppedArea)
      const supabase = createClient()
      const path = `${brandId}/logo.jpg`
      const { error: upErr } = await supabase.storage
        .from('brand-logos')
        .upload(path, file, { upsert: true, contentType: 'image/jpeg' })
      if (upErr) throw upErr
      onChange(path)
      setVersion(v => v + 1)
      setSourceUrl(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeLogo() {
    if (!currentPath) return
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { error: delErr } = await supabase.storage.from('brand-logos').remove([currentPath])
      // Ignore not-found; storage returning success regardless. Persist null on the row either way.
      if (delErr && !/Object not found/i.test(delErr.message)) throw delErr
      onChange(null)
      setVersion(v => v + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setBusy(false)
    }
  }

  // Cache-bust the preview URL after upload so the new image renders immediately
  const previewKey = `${currentPath ?? 'none'}:${version}`

  return (
    <div className="space-y-3">
      <Label>Logo <span className="text-muted-foreground font-normal">(optional)</span></Label>

      {sourceUrl ? (
        <div className="space-y-3">
          <div className="relative w-full h-56 bg-secondary rounded-lg overflow-hidden">
            <Cropper
              image={sourceUrl}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="rect"
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
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={discard} className="gap-1.5" disabled={busy}>
              <RotateCcw className="w-3.5 h-3.5" />
              Discard
            </Button>
            <Button type="button" size="sm" onClick={applyAndUpload} className="gap-1.5" disabled={busy || !croppedArea}>
              <Check className="w-3.5 h-3.5" />
              {busy ? 'Uploading…' : 'Apply & save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <BrandLogo key={previewKey} name={brandName} logoPath={currentPath} size="xl" />
          <div className="flex-1 space-y-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handlePicked}
              className="hidden"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={pickFile} className="gap-1.5" disabled={busy}>
                <Upload className="w-3.5 h-3.5" />
                {currentPath ? 'Replace logo' : 'Upload logo'}
              </Button>
              {currentPath && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={removeLogo}
                  disabled={busy}
                  className="gap-1.5 text-destructive hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              JPG, PNG, or WebP. Max 5 MB. Crop to a square after picking.
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

// Render the cropped region into a square JPEG File (mirrors ProfileForm)
async function renderCroppedJpeg(imageSrc: string, area: Area): Promise<File> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(b => resolve(b), 'image/jpeg', 0.9),
  )
  if (!blob) throw new Error('Could not encode JPEG')
  return new File([blob], 'logo.jpg', { type: 'image/jpeg' })
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
