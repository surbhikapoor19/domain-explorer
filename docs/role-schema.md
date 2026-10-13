# Role schema

A domain config (`domains/<domain>.yaml`) maps CSV columns onto *roles*, so the
pipeline reads data by meaning rather than by literal column name. The
authoritative list is `ROLE_VOCABULARY` in `backend/rag/role_schema.py`; this page
documents the same vocabulary in prose. A new role is added there, documented
here, and listed in the role vocabulary the admin wizard hands its column mapper
(`dashboard/api/admin/propose-yaml.js`).

Each column entry carries a `role` and, optionally, a `facet` that says how the
column is rendered and filtered:

```yaml
columns:
  "Year (Initial Release)": { role: identity.year, facet: numeric }
```

`facet` is one of `categorical`, `numeric`, `text`, `url`, `identifier`.
`identity.name` and `identity.year` are required (`REQUIRED_ROLES`); every other
role is optional, and one role may be played by more than one column.

## Roles

| Role | Meaning |
| --- | --- |
| `identity.name` | The method/algorithm name (required) |
| `identity.description` | Free-text description or abstract |
| `identity.year` | Year of publication or initial release (required) |
| `identity.code` | URL to the code repository or project page |
| `identity.citation` | BibTeX or citation string |
| `identity.paper_url` | URL of the paper itself: a PDF or a landing/archive page (see below) |
| `method.family` | Category of approach (e.g. "sampling-based", "optimization") |
| `method.backbone` | Neural architecture or core algorithm component |
| `input.modality` | Input data type (point cloud, RGB-D, joint states) |
| `input.sensor` | Sensor type or camera configuration |
| `output.shape` | Output representation (6-DoF pose, joint trajectory) |
| `train.regime` | Training paradigm (supervised, self-supervised, sim-to-real) |
| `train.simulator` | Simulator used for training |
| `eval.benchmark` | Dataset or benchmark used for evaluation |
| `eval.metric` | Metric used (success rate, path length, computation time) |
| `hardware.platform` | Robot or end-effector hardware |
| `env.context` | Scene or object configuration |
| `meta.license` | Software license |
| `meta.maintainer` | Author or maintainer name |
| `meta.language` | Programming language |

## `identity.paper_url`

The URL of the paper for that row: an arXiv `abs`/`pdf` link, a DOI, a publisher
or project landing page, a direct `.pdf`, or a Drive/Dropbox file link. It is
usually an `archive` column:

```yaml
columns:
  "archive": { role: identity.paper_url, facet: url }
```

`scripts/fetch_missing_pdfs.py` uses it as the **first** PDF source for any row
whose PDF is not already in the papers directory, ahead of the open-access
resolvers (arXiv, OpenAlex, Semantic Scholar, project-page scrape). Because the
maintainer asserted the link for that very row, it is trusted **without** the
title-similarity and first-author check those resolvers apply. A landing page is
scraped one level for the PDF it points at (its `citation_pdf_url` meta tag, then
`.pdf` anchors, then arXiv links). A link that does not yield a PDF falls through
to the open-access resolvers. Every PDF fetched this way is recorded in
`chroma_db/pdf-sources.json` with `source: "csv:<column>"` and
`resolved_via: "csv_column"`, and the script logs the chosen column on a
`link column :` line.

The role is optional. When no column is mapped to it, the script picks one from
the CSV header instead: case-insensitive, with `_` and `-` read as spaces, first
match wins in this order: `archive`, `pdf url`, `pdf`, `paper url`, `paper pdf`,
`paper link`, `preprint`, `arxiv`, `doi`. A candidate column that is empty in
every row is skipped, so a freshly added, still-empty `archive` column does not
hide a populated `arXiv` one. A mapped column that the CSV no longer has is
ignored in favour of the same header detection.
