import * as React from 'react'
import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'

export const brand = {
  bg: '#FAFAFA',
  card: '#FFFFFF',
  text: '#171717',
  muted: '#737373',
  border: '#E5E5E5',
  primary: '#FF4433',
  primaryHover: '#E63E2E',
  primaryText: '#FFFFFF',
  radius: 6,
} as const

// Hosted via Vercel from `public/Studio-Gradient-Icon.png` on the app's
// production domain. Cheaper + simpler than wiring up a Supabase Storage
// bucket, and the file is already deployed wherever the app is.
const LOGO_URL = 'https://scheduler.example.invalid/Studio-Gradient-Icon.png'

const fontStack =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const main: React.CSSProperties = {
  backgroundColor: brand.bg,
  color: brand.text,
  fontFamily: fontStack,
  margin: 0,
  padding: '24px 0',
}

const container: React.CSSProperties = {
  backgroundColor: brand.card,
  border: `1px solid ${brand.border}`,
  borderRadius: brand.radius,
  margin: '0 auto',
  maxWidth: 560,
  padding: 0,
}

const headerSection: React.CSSProperties = {
  padding: '24px 32px 8px 32px',
}

const logoImg: React.CSSProperties = {
  display: 'block',
  height: 32,
  width: 32,
}

const bodySection: React.CSSProperties = {
  padding: '8px 32px 24px 32px',
}

const footerHr: React.CSSProperties = {
  borderColor: brand.border,
  margin: '0 32px',
}

const footerSection: React.CSSProperties = {
  padding: '16px 32px 24px 32px',
}

const footerText: React.CSSProperties = {
  color: brand.muted,
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
}

const footerLink: React.CSSProperties = {
  color: brand.muted,
  textDecoration: 'underline',
}

interface EmailLayoutProps {
  preview: string
  appUrl: string
  children: React.ReactNode
}

export function EmailLayout({ preview, appUrl, children }: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerSection}>
            <Img src={LOGO_URL} alt="Studio" width={32} height={32} style={logoImg} />
          </Section>
          <Section style={bodySection}>{children}</Section>
          <Hr style={footerHr} />
          <Section style={footerSection}>
            <Text style={footerText}>
              You're receiving this because you have a Studio scheduler account.{' '}
              <Link href={appUrl} style={footerLink}>
                Open Studio
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const ctaButton: React.CSSProperties = {
  backgroundColor: brand.primary,
  borderRadius: brand.radius,
  color: brand.primaryText,
  display: 'inline-block',
  fontSize: 14,
  fontWeight: 600,
  lineHeight: '20px',
  padding: '10px 18px',
  textAlign: 'center',
  textDecoration: 'none',
}

interface CTAProps {
  href: string
  children: React.ReactNode
}

export function CTA({ href, children }: CTAProps) {
  return (
    <Button href={href} style={ctaButton}>
      {children}
    </Button>
  )
}

export const styles = {
  h1: {
    color: brand.text,
    fontSize: 22,
    fontWeight: 700,
    lineHeight: '28px',
    margin: '0 0 12px 0',
  } satisfies React.CSSProperties,
  p: {
    color: brand.text,
    fontSize: 15,
    lineHeight: '22px',
    margin: '0 0 12px 0',
  } satisfies React.CSSProperties,
  muted: {
    color: brand.muted,
    fontSize: 13,
    lineHeight: '20px',
    margin: '0 0 12px 0',
  } satisfies React.CSSProperties,
  detailCard: {
    backgroundColor: brand.bg,
    border: `1px solid ${brand.border}`,
    borderRadius: brand.radius,
    margin: '12px 0 16px 0',
    padding: '12px 16px',
  } satisfies React.CSSProperties,
  detailLabel: {
    color: brand.muted,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.4,
    margin: 0,
    textTransform: 'uppercase' as const,
  } satisfies React.CSSProperties,
  detailValue: {
    color: brand.text,
    fontSize: 15,
    fontWeight: 600,
    lineHeight: '22px',
    margin: '2px 0 0 0',
  } satisfies React.CSSProperties,
  ctaWrap: {
    margin: '4px 0 16px 0',
  } satisfies React.CSSProperties,
  tableHeader: {
    backgroundColor: brand.bg,
    border: `1px solid ${brand.border}`,
    borderRadius: brand.radius,
    margin: '12px 0 16px 0',
    padding: '12px 16px',
  } satisfies React.CSSProperties,
  tableRow: {
    borderBottom: `1px solid ${brand.border}`,
    padding: '10px 0',
  } satisfies React.CSSProperties,
}

export { Text, Section, Link }
