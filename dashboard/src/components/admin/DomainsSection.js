import React from 'react';
import DomainCard from './DomainCard';

export default function DomainsSection({
  domains, loading, runsByDomain, activeDomainSlugs, buildingMap,
  updateOpenSlug, onToggleUpdate, updating, updateError,
  onSubmitCsv, onSubmitPdfUrl, onSubmitZip,
  onBuild, onBuildBenchmarks, onDelete, onOpenWizard,
}) {
  return (
    <div className="admin-domain-grid">
      {loading && <div className="admin-loading">Loading domains…</div>}
      {!loading && domains.length === 0 && (
        <div className="admin-empty">No domains configured yet — create one below.</div>
      )}
      {domains.map(d => (
        <DomainCard
          key={d.slug}
          domain={d}
          latestRun={runsByDomain[d.slug]}
          hasActiveRun={activeDomainSlugs.has(d.slug)}
          buildingAction={buildingMap[d.slug]}
          updateOpen={updateOpenSlug === d.slug}
          onToggleUpdate={() => onToggleUpdate(d.slug)}
          updating={updating === d.slug}
          updateError={updateOpenSlug === d.slug ? updateError : null}
          onSubmitCsv={(file) => onSubmitCsv(d.slug, file)}
          onSubmitPdfUrl={(url) => onSubmitPdfUrl(d.slug, url)}
          onSubmitZip={(file) => onSubmitZip(d.slug, file)}
          onBuild={onBuild}
          onBuildBenchmarks={onBuildBenchmarks}
          onDelete={onDelete}
        />
      ))}
      <button type="button" className="admin-new-domain-tile" onClick={onOpenWizard}>
        <span className="admin-new-domain-plus">+</span>
        <span>New domain</span>
      </button>
    </div>
  );
}
