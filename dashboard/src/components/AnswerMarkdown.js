/**
 * AnswerMarkdown — renders the copilot's markdown ANSWER as formatted React,
 * reusing the shared `HighlightedText` for entity/term/query highlighting so the
 * answer prose gets the same color-coding as the rest of the app.
 *
 * Supports the constrained markdown the copilot is prompted to emit:
 *   - headings (#, ##, ###)
 *   - unordered (-, *, •) and ordered (1.) lists
 *   - **bold** inline — kept + styled (HighlightedText would strip it); a bold
 *     token that resolves to a discussed method renders as a clickable chip
 *   - Markdown tables (for comparison answers)
 *   - [P#]/[B#] inline citations -> a superscript chip (title = paper, on hover)
 *   - [m_id] method markers -> consumed (parsing aid; the bold name is shown)
 *   - paragraphs
 * No new dependencies — a small, deterministic parser. Never throws on odd input.
 */
import React, { useMemo } from 'react';
import { HighlightedText } from '../highlighter';

const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const INLINE_RE = /(\*\*[^*]+\*\*|\[[^\]\n]{1,48}\])/g;

function renderInline(str, ctx) {
  if (!str) return null;
  const { termDictionary, query, citeMap, methodByNorm, onMethodClick, onCiteClick, keyPrefix } = ctx;
  return str.split(INLINE_RE).map((p, i) => {
    const key = `${keyPrefix}-${i}`;
    if (!p) return null;
    // **bold** — clickable chip when it resolves to a discussed method. Any stray
    // [m_id] marker was already stripped globally; guard against an empty bold.
    if (/^\*\*[^*]+\*\*$/.test(p)) {
      const inner = p.slice(2, -2).replace(/\[m_[a-z0-9-]+\]/gi, '').trim();
      if (!inner) return null;
      const method = methodByNorm.get(norm(inner));
      if (method && onMethodClick) {
        return (
          <button
            key={key}
            type="button"
            className="answer-method-link"
            onClick={() => onMethodClick(method)}
            title={`Highlight ${method} everywhere`}
          >
            {inner}
          </button>
        );
      }
      return (
        <strong key={key} className="answer-strong">
          <HighlightedText text={inner} termDictionary={termDictionary} query={query} />
        </strong>
      );
    }
    // [marker] — citation chip(s). A bracket may hold several tags ("[P2, P4]");
    // render one clickable chip per RESOLVED tag and DROP unresolved ones, so there
    // is never a chip that looks clickable but goes nowhere.
    if (/^\[[^\]\n]{1,48}\]$/.test(p)) {
      const inner = p.slice(1, -1).trim();
      if (/^m_/i.test(inner)) return null; // internal id marker — never shown
      const chips = inner.split(/[;,]/).map(s => s.trim()).filter(Boolean).map((mk, si) => {
        const cite = citeMap.get(mk.toLowerCase());
        if (!cite || !cite.paper_id) return null; // unresolved -> no dead chip
        const title = cite.paper_title || cite.paper_id || mk;
        if (onCiteClick) {
          return (
            <button
              key={`${key}-${si}`}
              type="button"
              className="answer-cite answer-cite-link"
              title={`Open source: ${title}`}
              onClick={() => onCiteClick(cite, str)}
            >[{cite.index}]</button>
          );
        }
        return <sup key={`${key}-${si}`} className="answer-cite" title={title}>[{cite.index}]</sup>;
      }).filter(Boolean);
      return chips.length ? <React.Fragment key={key}>{chips}</React.Fragment> : null;
    }
    return <HighlightedText key={key} text={p} termDictionary={termDictionary} query={query} />;
  });
}

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(l) && l.includes('-');
const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

export default function AnswerMarkdown({ text, termDictionary, query, citations, methods, onMethodClick, onCiteClick }) {
  const citeMap = useMemo(() => {
    const m = new Map();
    (citations || []).forEach((c, i) => {
      const key = String(c.marker || c.paper_id || '').toLowerCase().trim();
      if (key) m.set(key, { ...c, index: c.index || i + 1 });
    });
    return m;
  }, [citations]);

  const methodByNorm = useMemo(() => {
    const m = new Map();
    (methods || []).forEach((x) => {
      const name = typeof x === 'string' ? x : (x && x.name);
      if (name) m.set(norm(name), name);
    });
    return m;
  }, [methods]);

  if (!text || !String(text).trim()) return null;

  // Defensive: strip any internal id markers ([m_slug]) the model leaked anywhere,
  // so a raw id can never surface as text or collapse a bold to empty.
  const lines = String(text).replace(/\r/g, '').replace(/\[m_[a-z0-9-]+\]/gi, '').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ').trim() }); para = []; } };
  const flushList = () => { if (list && list.items.length) blocks.push({ type: 'list', ...list }); list = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flushPara(); flushList(); continue; }
    // table: a header row + separator row + body rows
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      flushPara(); flushList();
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i].trim())) { rows.push(cells(lines[i].trim())); i++; }
      i--;
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { flushPara(); flushList(); blocks.push({ type: 'h', level: heading[1].length, text: heading[2].trim() }); continue; }
    if (BULLET_RE.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]/.test(line);
      if (!list) list = { ordered, items: [] };
      list.items.push(line.replace(BULLET_RE, '').trim());
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();

  const base = { termDictionary, query, citeMap, methodByNorm, onMethodClick, onCiteClick };

  return (
    <div className="answer-markdown">
      {blocks.map((b, i) => {
        const ctx = { ...base, keyPrefix: `b${i}` };
        if (b.type === 'h') {
          const Tag = `h${Math.min(b.level + 2, 6)}`;
          return <Tag key={i} className="answer-h">{renderInline(b.text, ctx)}</Tag>;
        }
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className="answer-list">
              {b.items.map((it, j) => <li key={j}>{renderInline(it, { ...ctx, keyPrefix: `b${i}-${j}` })}</li>)}
            </Tag>
          );
        }
        if (b.type === 'table') {
          return (
            <div key={i} className="answer-table-wrap">
              <table className="answer-table">
                <thead><tr>{b.header.map((h, j) => <th key={j}>{renderInline(h, { ...ctx, keyPrefix: `b${i}-h${j}` })}</th>)}</tr></thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, { ...ctx, keyPrefix: `b${i}-${ri}-${ci}` })}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={i} className="answer-p">{renderInline(b.text, ctx)}</p>;
      })}
    </div>
  );
}
