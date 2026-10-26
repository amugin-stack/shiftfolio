import { CalendarDays } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BrandLogoProps {
  /** Brand name — used for initials fallback + alt text */
  name: string
  /** Storage object key (e.g. "{brand_id}/logo.jpg") or null */
  logoPath?: string | null
  /** Visual size preset */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  /** Replace the default fallback (initials on muted bg) with a calendar icon */
  fallbackIcon?: boolean
  className?: string
}

const SIZE_CLASSES: Record<NonNullable<BrandLogoProps['size']>, string> = {
  xs: 'w-5 h-5 text-[8px]',
  sm: 'w-6 h-6 text-[9px]',
  md: 'w-9 h-9 text-xs',
  lg: 'w-12 h-12 text-sm',
  xl: 'w-16 h-16 text-base',
}

/** Public bucket → direct CDN URL, no signing needed. */
export function brandLogoUrl(logoPath: string | null | undefined): string | null {
  if (!logoPath) return null
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  // Cache-bust on path change is automatic since path includes the brand id;
  // for forced refresh on re-upload, callers can append `?v=${Date.now()}`.
  return `${base}/storage/v1/object/public/brand-logos/${logoPath}`
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function BrandLogo({
  name,
  logoPath,
  size = 'md',
  fallbackIcon = false,
  className,
}: BrandLogoProps) {
  const url = brandLogoUrl(logoPath)
  const cls = cn(
    SIZE_CLASSES[size],
    'rounded-md flex items-center justify-center overflow-hidden flex-shrink-0',
    className,
  )

  if (url) {
    return (
      <div className={cn(cls, 'bg-card border border-border')}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`${name} logo`}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>
    )
  }

  if (fallbackIcon) {
    return (
      <div className={cn(cls, 'bg-secondary text-muted-foreground')}>
        <CalendarDays className="w-[55%] h-[55%]" />
      </div>
    )
  }

  return (
    <div className={cn(cls, 'bg-primary/15 text-primary font-bold')}>
      {initials(name)}
    </div>
  )
}
