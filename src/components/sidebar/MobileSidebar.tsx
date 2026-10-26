'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { SidebarNav, type SidebarNavProps } from './SidebarNav'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'

export type MobileSidebarProps = Omit<SidebarNavProps, 'onNavigate'>

/** Hamburger-triggered off-canvas drawer that carries the same nav as the
 *  desktop sidebar. Renders the trigger button (md:hidden) inline so the
 *  Topbar just drops it in at the left edge. */
export function MobileSidebar(props: MobileSidebarProps) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-72 p-0 bg-card border-r border-border [&>button.absolute]:hidden"
      >
        {/* sr-only title satisfies Radix's a11y requirement for dialog labelling
            without crowding the visual nav. */}
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarNav {...props} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  )
}
