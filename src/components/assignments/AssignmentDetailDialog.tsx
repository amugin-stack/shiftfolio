'use client'

import { Mic, Megaphone, User, Calendar as CalendarIcon, StickyNote } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { formatPT } from '@/lib/utils'
import type { AssignmentRow } from '@/app/(dashboard)/assignments/page'

interface AssignmentDetailDialogProps {
  row: AssignmentRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Read-only detail view for an assignment row — who's on the shift, when,
 * and any notes the scheduler left.
 */
export function AssignmentDetailDialog({ row, open, onOpenChange }: AssignmentDetailDialogProps) {
  if (!row) return null

  const dateLabel = formatPT(row.startISO, 'EEEE, MMMM d')
  const timeLabel = `${formatPT(row.startISO, 'h:mm a')} – ${formatPT(row.endISO, 'h:mm a')}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <BrandLogo name={row.brand.name} logoPath={row.brand.logo_path} size="md" />
            <span>{row.brand.name}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* When */}
          <div className="rounded-md border border-border bg-secondary/30 px-3 py-2.5 space-y-1">
            <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground inline-flex items-center gap-1">
              <CalendarIcon className="w-3 h-3" />
              When
            </p>
            <p className="text-sm font-medium text-foreground">{dateLabel}</p>
            <p className="text-xs text-muted-foreground">{timeLabel}</p>
          </div>

          {/* People */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <PersonRow
              icon={User}
              label="Host"
              name={row.hostName}
              missing="Host TBD"
            />
            <PersonRow
              icon={Megaphone}
              label="Moderator"
              name={row.moderatorName}
              missing="No moderator assigned"
            />
          </div>

          {/* Your role badge */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Your role:</span>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/15 text-primary">
              {row.role === 'producer' ? <Mic className="w-3 h-3" /> : <Megaphone className="w-3 h-3" />}
              {row.role}
            </span>
          </div>

          {/* Shift notes if present */}
          {row.notes && (
            <div className="rounded-md border border-border bg-card px-3 py-2.5 space-y-1">
              <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground inline-flex items-center gap-1">
                <StickyNote className="w-3 h-3" />
                Shift notes
              </p>
              <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{row.notes}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PersonRow({
  icon: Icon,
  label,
  name,
  missing,
}: {
  icon: typeof Mic
  label: string
  name: string | null
  missing: string
}) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground inline-flex items-center gap-1">
        <Icon className="w-3 h-3" />
        {label}
      </p>
      <p className={`text-sm mt-0.5 ${name ? 'text-foreground font-medium' : 'text-muted-foreground italic'}`}>
        {name ?? missing}
      </p>
    </div>
  )
}
