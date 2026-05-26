/**
 * Per-domain branding config.
 *
 * Swap these strings (or replace this file at build time per domain) to
 * rebrand the dashboard without touching component code. When a new
 * landscape gets ingested (e.g. motion planning), this is the only file
 * that needs to change for the user-facing copy:
 *
 *   productName   -> shows in the header (e.g. "Grasp Explorer")
 *   productShort  -> short noun for prose ("grasp planning methods")
 *   productSubject -> single-noun subject ("grasp planning")
 *   ecosystem     -> the umbrella program ("COMPARE Ecosystem")
 *   tagline       -> badge shown next to the title
 *   queryHint     -> placeholder text in the Ask box
 *   methodNoun    -> what one row in the CSV is called ("method")
 *
 * Resolution order:
 *  1. window.__BRANDING__ (injected at build time by Vercel / CI)
 *  2. process.env.REACT_APP_BRANDING_JSON (parsed if set)
 *  3. the DEFAULTS below (current Grasp Explorer build)
 *
 * Keep this file dependency-free and synchronous so it can be imported
 * from anywhere in the app without async bootstrap.
 */

const DEFAULTS = {
  productName: 'Grasp Explorer',
  productShort: 'grasp planning methods',
  productSubject: 'grasp planning',
  ecosystem: 'COMPARE Ecosystem',
  tagline: 'AI-in-the-Loop',
  queryHint: 'Ask about grasp planning methods, e.g., "methods for cluttered scenes with multi-finger grippers"',
  methodNoun: 'method',
};

function resolveBranding() {
  // Build-time injection takes precedence so deploys can rebrand without
  // a code change. Vercel can wire this via a small <script> in
  // public/index.html that reads from environment.
  if (typeof window !== 'undefined' && window.__BRANDING__) {
    return { ...DEFAULTS, ...window.__BRANDING__ };
  }
  // Env-var fallback (CRA only inlines REACT_APP_*-prefixed vars at build).
  const envJson = process.env.REACT_APP_BRANDING_JSON;
  if (envJson) {
    try {
      return { ...DEFAULTS, ...JSON.parse(envJson) };
    } catch (_) {
      // ignore malformed JSON, fall through to defaults
    }
  }
  return DEFAULTS;
}

const BRANDING = resolveBranding();

export function mergeDomainBranding(domainBranding) {
  if (!domainBranding) return BRANDING;
  return { ...BRANDING, ...domainBranding };
}

export default BRANDING;
