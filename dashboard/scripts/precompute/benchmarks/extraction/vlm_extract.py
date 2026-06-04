import json, re, base64
from benchmarks.types import ResultRecord
from benchmarks.normalize.registries import MetricRegistry, ConditionRegistry
from benchmarks.normalize.units import parse_value

SCHEMA_INSTRUCTION = (
    "Extract the evaluation table as JSON: {\"rows\": [{\"method\": str, \"dataset\": str|null, "
    "\"metric\": str, \"condition\": str|null, \"value\": number, \"value_str\": str (EXACT printed text), "
    "\"is_own\": bool}]}. Copy value_str verbatim from the image. Omit non-numeric/header rows. "
    "Return ONLY JSON.")

DEFAULT_MODEL = "claude-sonnet-4-6"

def call_vlm(png_bytes, client, model=DEFAULT_MODEL):
    """Send a table crop to Claude vision; return the model's text. client = anthropic.Anthropic().
    The anthropic SDK is only needed by the caller that constructs `client`; this module does not
    import it at module load time."""
    b64 = base64.standard_b64encode(png_bytes).decode()
    msg = client.messages.create(
        model=model, max_tokens=2000,
        system=[{"type": "text", "text": SCHEMA_INSTRUCTION,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": "Extract this table."}]}])
    return msg.content[0].text

def parse_vlm_rows(vlm_text, loc, cfg, resolver):
    mreg, creg = MetricRegistry(cfg), ConditionRegistry(cfg)
    m = re.search(r'\{.*\}', vlm_text, re.DOTALL)
    if not m:
        return []
    data = json.loads(m.group(0))
    recs = []
    for row in data.get("rows", []):
        cond = creg.resolve(row.get("condition") or "") or creg.resolve(loc.caption)
        mh = mreg.resolve('success rate' if (cond and not row.get("metric")) else row.get("metric", ""))
        v = row.get("value")
        if v is None:
            v, _, _ = parse_value(row.get("value_str", ""))
        hit = resolver.resolve(row.get("method", ""))
        recs.append(ResultRecord(
            paper_id=loc.paper_id, method_raw=row.get("method", ""), method_id=hit.method_id,
            metric_raw=row.get("metric", ""), metric_id=mh.id, unit=mh.unit,
            higher_is_better=mh.higher_is_better, dataset_raw=row.get("dataset") or "",
            condition=cond, value=v, value_str=str(row.get("value_str", "")),
            is_own_method=bool(row.get("is_own")), extractor="vlm",
            table_caption=loc.caption, section_label=loc.section_label,
            extraction_conf="medium", verified=False))
    return recs

def _norm_num(s):
    m = re.findall(r'-?\d+\.?\d*', s or '')
    return m[0] if m else None

def verify_records(records, crop_text):
    """Found-in-crop guardrail: the extracted value must appear in the crop's text."""
    norm = re.sub(r'\s+', ' ', crop_text or '')
    for r in records:
        num = _norm_num(r.value_str)
        if num and num in norm:
            r.verified = True
            r.extraction_conf = "high"
        else:
            r.verified = False
            r.extraction_conf = "low"
    return records
