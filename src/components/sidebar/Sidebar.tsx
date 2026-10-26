import { SidebarNav, type SidebarNavProps } from './SidebarNav'

export type SidebarProps = Omit<SidebarNavProps, 'onNavigate'>

/** Desktop sidebar. Hidden under the `md` breakpoint — on mobile the same
 *  nav contents render inside a Sheet via `MobileSidebar`. */
export function Sidebar(props: SidebarProps) {
  return (
    <aside className="hidden md:flex w-56 flex-shrink-0 flex-col h-screen bg-card border-r border-border">
      <SidebarNav {...props} />
    </aside>
  )
}
