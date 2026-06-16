import React from 'react';

/**
 * ManualButton — nav-link button that opens the statically-served HTML manual
 * (/dashboard-manual.html, copied from docs/dashboard-manual.html at build time)
 * in a new tab. The source of truth for the manual stays in docs/; public/ holds
 * a copy so it is served at the site root.
 */
export default function ManualButton() {
  const openManual = () => {
    window.open('/dashboard-manual.html', '_blank', 'noopener');
  };

  return (
    <button
      type="button"
      className="nav-link"
      title="User & Architecture Manual"
      onClick={openManual}
    >
      Manual
    </button>
  );
}
