import React from 'react';

// Small inline SVG glyphs for status. Per the plain-language rule, every icon here
// is decorative (aria-hidden) — callers must always pair it with visible text, never
// rely on color/shape alone. StatusTag below bakes that pairing in.

export function IconCheck(props) {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" {...props}>
      <path d="M13.5 3.5 6 11 2.5 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCross(props) {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" {...props}>
      <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconDot(props) {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" {...props}>
      <circle cx="5" cy="5" r="5" fill="currentColor" />
    </svg>
  );
}

export function IconRing(props) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" {...props}>
      <circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function IconWarning(props) {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" {...props}>
      <path d="M8 2 15 14H1L8 2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.3v3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function IconLock(props) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function IconChevron({ open, ...props }) {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' }} {...props}>
      <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconEye(props) {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" {...props}>
      <path d="M1 8s2.7-5 7-5 7 5 7 5-2.7 5-7 5-7-5-7-5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function IconEyeOff(props) {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" {...props}>
      <path d="M1 8s2.7-5 7-5 7 5 7 5-2.7 5-7 5-7-5-7-5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 14 14 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconRefresh(props) {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" {...props}>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.8 4M13.5 8V3.5M13.5 8H9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// tone -> class suffix; keep to the one-hue-per-status palette (see App.css
// .admin-status-*). "icon" lets a caller override the default glyph per tone.
const TONE_ICON = {
  success: IconCheck,
  running: IconDot,
  failed: IconCross,
  warning: IconWarning,
  skipped: IconRing,
  muted: IconRing,
};

export function StatusTag({ tone = 'muted', icon, children, className = '' }) {
  const Icon = icon || TONE_ICON[tone] || IconRing;
  return (
    <span className={`admin-status admin-status-${tone} ${className}`}>
      <Icon className="admin-status-icon" />
      <span>{children}</span>
    </span>
  );
}
