import React, { useState, useEffect } from 'react';
import { useDomainConfig } from '../DomainContext';
import { loadBenchmarkComparisons } from '../lib/data-loader';

const HIDDEN_KEYS = ['Name', 'Description', 'Combined_Description', 'Link(s)', 'Citation'];

let _benchmarkCache = null;

function statusLabel(status) {
  if (status === 'consistent') return 'validated';
  if (status === 'different_setup') return 'different setup';
  return 'high variance';
}

function gradeBadgeClass(grade) {
  if (!grade) return 'detail-badge-b';
  const g = grade.toUpperCase();
  if (g === 'A') return 'detail-badge-a';
  if (g === 'C') return 'detail-badge-c';
  return 'detail-badge-b';
}

export default function DetailPanel({ point, onClose, minConfidence = 0.70 }) {
  const { shortNames } = useDomainConfig();
  const [benchmarkInfo, setBenchmarkInfo] = useState(null);

  useEffect(() => {
    if (!point) return;
    const loadInfo = async () => {
      try {
        if (!_benchmarkCache) {
          _benchmarkCache = await loadBenchmarkComparisons();
        }
        const info = _benchmarkCache?.method_index?.[point.name] || null;
        const validations = (_benchmarkCache?.cross_validations || [])
          .filter(v => v.method === point.name)
          .filter(v => (typeof v.confidence === 'number' ? v.confidence : 1) >= minConfidence);
        setBenchmarkInfo(info ? { ...info, cross_validations: validations } : null);
      } catch {
        setBenchmarkInfo(null);
      }
    };
    loadInfo();
  }, [point, minConfidence]);

  if (!point) return null;

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h3>{point.name}</h3>
        <button onClick={onClose}>&times;</button>
      </div>
      <div className="detail-panel-body">
        <p className="detail-description">{point.description}</p>

        {benchmarkInfo && (benchmarkInfo.n_wins > 0 || benchmarkInfo.n_losses > 0) && (
          <div className="detail-benchmark-badges">
            {benchmarkInfo.n_wins > 0 && (
              <span className="detail-badge detail-badge-win">
                {benchmarkInfo.n_wins} win{benchmarkInfo.n_wins !== 1 ? 's' : ''}
              </span>
            )}
            {benchmarkInfo.n_losses > 0 && (
              <span className="detail-badge detail-badge-loss">
                {benchmarkInfo.n_losses} loss{benchmarkInfo.n_losses !== 1 ? 'es' : ''}
              </span>
            )}
            {benchmarkInfo.cross_validations?.length > 0 && (
              benchmarkInfo.cross_validations.map((v, i) => (
                <span key={i} className={`detail-badge ${gradeBadgeClass(v.grade)}`}>
                  {v.metric_label}: {statusLabel(v.status)} ({v.n_papers} papers)
                </span>
              ))
            )}
          </div>
        )}

        <div className="detail-metadata">
          {Object.entries(point.metadata || {}).map(([key, val]) => {
            if (!val || HIDDEN_KEYS.includes(key)) return null;
            return (
              <div key={key} className="metadata-row">
                <span className="metadata-key">{shortNames[key] || key}:</span>
                <span className="metadata-val">{val}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
