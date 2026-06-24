import React from 'react';
import { reproducibilityCard } from '../lib/benchmark-cells';

/* ──────────────────────────────────────────────────────────────────────────
 * ReproducibilityCard (presentational)
 *
 * Renders the record-schema card for one (cell, method) pair as produced by
 * `reproducibilityCard(cell, method)`. The honesty invariants live in that pure
 * helper: fields we never extracted read "not reported" (never invented), and
 * `tier` is a REPLICATION signal — NOT a quality rank. This component only
 * renders that record faithfully.
 * ────────────────────────────────────────────────────────────────────────── */

const FACTOR_ORDER = ['object_set', 'gripper', 'arm', 'sensor', 'scene', 'success_criterion', 'trials', 'protocol'];
const LABELS = {
  object_set: 'Object set',
  gripper: 'Gripper',
  arm: 'Arm',
  sensor: 'Sensor',
  scene: 'Scene',
  success_criterion: 'Success criterion',
  trials: 'Trials',
  protocol: 'Protocol',
};

// Maps a card factor to the attribute key used to backfill a "not reported" slot
// from the method-attribute join (KG/CSV). Factors with no mapping are untouched.
const FACTOR_TO_ATTR = { gripper: 'gripper', sensor: 'sensor', arm: 'end_effector' };

export default function ReproducibilityCard({ cell, method, attributes }) {
  const card = reproducibilityCard(cell, method);

  return (
    <div className={`benchmarks-card benchmarks-card-${card.tier}`}>
      <div className="benchmarks-card-head">
        <span className="benchmarks-card-method">{card.method}</span>
        <span className="benchmarks-card-tier" title="Replication signal — NOT a quality rank">{card.tierLabel}</span>
      </div>
      <div className="benchmarks-card-factors">
        {FACTOR_ORDER.map((key) => {
          const val = card.factors[key];

          // Backfill a "not reported" slot from the attribute join when available.
          const attrKey = FACTOR_TO_ATTR[key];
          const attr = attributes && attrKey ? attributes[attrKey] : null;
          const canFill =
            val === 'not reported' &&
            attr &&
            attr.value != null &&
            attr.value !== 'not reported';

          if (canFill) {
            return (
              <div className="benchmarks-card-factor" key={key}>
                <span className="benchmarks-card-factor-key">{LABELS[key]}</span>
                <span className="benchmarks-card-factor-val">{String(attr.value)}</span>
                <span className="benchmarks-card-factor-src">{attr.source}</span>
              </div>
            );
          }

          const muted = val === 'not reported';
          return (
            <div className="benchmarks-card-factor" key={key}>
              <span className="benchmarks-card-factor-key">{LABELS[key]}</span>
              <span className={`benchmarks-card-factor-val${muted ? ' muted' : ''}`}>{String(val)}</span>
            </div>
          );
        })}
      </div>
      {card.doNotCompare.length > 0 && (
        <ul className="benchmarks-card-dnc">
          {card.doNotCompare.map((d, i) => <li className="benchmarks-card-dnc-item" key={i}>{d}</li>)}
        </ul>
      )}
    </div>
  );
}
