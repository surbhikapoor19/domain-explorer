import React from 'react';
import { useDomainConfig } from '../DomainContext';

const HIDDEN_KEYS = ['Name', 'Description', 'Combined_Description', 'Link(s)', 'Citation'];

export default function DetailPanel({ point, onClose }) {
  const { shortNames } = useDomainConfig();
  if (!point) return null;

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h3>{point.name}</h3>
        <button onClick={onClose}>&times;</button>
      </div>
      <div className="detail-panel-body">
        <p className="detail-description">{point.description}</p>
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
