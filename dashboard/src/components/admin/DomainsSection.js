import React from 'react';
import DomainCard from './DomainCard';

export default function DomainsSection({
  domains, loading, runsByDomain, latestDeploy, activeDomainSlugs, buildingMap,
  updateOpenSlug, onToggleUpdate, updating, updateError,
  onSubmitCsv, onSubmitPdfUrl, onSubmitZip,
  onBuild, onBuildBenchmarks, onDelete, onOpenWizard,
  driveStatus, driveCheckingMap, driveErrorMap, onDriveCheckNow, onDriveTestLink, onDriveSaveFolder,
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
          latestDeploy={latestDeploy}
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
          driveEntry={driveStatus?.[d.slug]}
          driveChecking={!!driveCheckingMap?.[d.slug]}
          driveCheckError={driveErrorMap?.[d.slug]}
          onDriveCheckNow={onDriveCheckNow}
          onDriveTestLink={onDriveTestLink}
          onDriveSaveFolder={(url) => onDriveSaveFolder(d.slug, url)}
        />
      ))}
      <button type="button" className="admin-new-domain-tile" onClick={onOpenWizard}>
        <span className="admin-new-domain-plus">+</span>
        <span>New domain</span>
      </button>
    </div>
  );
}
