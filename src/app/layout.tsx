import type { Metadata } from 'next'
import './globals.css'
import './demo.css'

export const metadata: Metadata = {
  title: 'Shiftfolio — Scheduling demo',
  description: 'An interactive, synthetic scheduling and payroll portfolio demo.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
