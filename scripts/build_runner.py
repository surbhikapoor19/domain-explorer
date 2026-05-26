#!/usr/bin/env python3
"""Build runner — serves the dashboard and handles admin API.

This is the self-contained server for Docker deployment. It:
  1. Serves the pre-built React dashboard from dashboard/build/
  2. Handles /api/admin/* endpoints (list domains, trigger builds, upload, status)
  3. Runs the ingestion pipeline as background subprocesses

Usage:
    python scripts/build_runner.py                    # default port 3000
    PORT=8080 python scripts/build_runner.py          # custom port
    ADMIN_TOKEN=mytoken python scripts/build_runner.py
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

REPO_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_BUILD = REPO_ROOT / 'dashboard' / 'build'
DOMAINS_DIR = REPO_ROOT / 'domains'
DATASETS_DIR = REPO_ROOT / 'datasets'
DATA_DIR = REPO_ROOT / 'dashboard' / 'public'

app = Flask(__name__, static_folder=str(DASHBOARD_BUILD), static_url_path='')
CORS(app)

# In-memory build status store
builds = {}
builds_lock = threading.Lock()


def check_admin_token():
    token = request.headers.get('x-admin-token', '')
    expected = os.environ.get('ADMIN_TOKEN', '')
    if not expected:
        return False, 'ADMIN_TOKEN not configured on server'
    if token != expected:
        return False, 'Invalid token'
    return True, None


# ─── Static file serving ───

@app.route('/')
def serve_index():
    return send_from_directory(str(DASHBOARD_BUILD), 'index.html')


@app.route('/data/<path:filename>')
def serve_data(filename):
    return send_from_directory(str(DATA_DIR / 'data'), filename)


@app.route('/<path:path>')
def serve_static(path):
    file_path = DASHBOARD_BUILD / path
    if file_path.is_file():
        return send_from_directory(str(DASHBOARD_BUILD), path)
    return send_from_directory(str(DASHBOARD_BUILD), 'index.html')


# ─── Admin API ───

@app.route('/api/admin/domains', methods=['GET'])
def list_domains():
    ok, err = check_admin_token()
    if not ok:
        return jsonify({'error': err}), 401

    domains = []
    if DOMAINS_DIR.exists():
        for f in sorted(DOMAINS_DIR.glob('*.yaml')) + sorted(DOMAINS_DIR.glob('*.yml')):
            slug = f.stem
            text = f.read_text()
            display_name = _yaml_value(text, 'display_name') or slug
            method_noun = _yaml_value(text, 'method_noun') or 'method'
            csv_path = _yaml_value(text, 'csv_path') or ''

            slug_dashed = slug.replace('_', '-')
            data_dir = DATA_DIR / f'data-{slug_dashed}'
            has_data = data_dir.exists() and (data_dir / 'methods.json').exists()
            kg_json = data_dir / 'kg-full.json' if data_dir.exists() else None
            has_kg = False
            if kg_json and kg_json.exists():
                try:
                    kg = json.loads(kg_json.read_text())
                    has_kg = len(kg.get('nodes', [])) > 0
                except Exception:
                    pass

            method_count = 0
            methods_json = data_dir / 'methods.json' if data_dir.exists() else None
            if methods_json and methods_json.exists():
                try:
                    method_count = len(json.loads(methods_json.read_text()))
                except Exception:
                    pass

            domains.append({
                'slug': slug,
                'displayName': display_name,
                'methodNoun': method_noun,
                'csvPath': csv_path,
                'yamlFile': f.name,
                'hasData': has_data,
                'hasKG': has_kg,
                'methodCount': method_count,
            })

    return jsonify({'domains': domains})


@app.route('/api/admin/trigger-build', methods=['POST'])
def trigger_build():
    ok, err = check_admin_token()
    if not ok:
        return jsonify({'error': err}), 401

    body = request.get_json(silent=True) or {}
    domain = body.get('domain')
    if not domain:
        return jsonify({'error': 'domain is required'}), 400

    steps = body.get('steps', 'grobid,rag,kg,hgt,precompute')
    build_id = str(uuid.uuid4())[:8]

    with builds_lock:
        builds[build_id] = {
            'id': build_id,
            'domain': domain,
            'status': 'queued',
            'steps': steps,
            'created_at': datetime.utcnow().isoformat() + 'Z',
            'updated_at': datetime.utcnow().isoformat() + 'Z',
            'log': [],
        }

    thread = threading.Thread(target=_run_build, args=(build_id, domain, steps), daemon=True)
    thread.start()

    return jsonify({'success': True, 'buildId': build_id, 'message': f'Build queued for {domain}'})


@app.route('/api/admin/build-status', methods=['GET'])
def build_status():
    ok, err = check_admin_token()
    if not ok:
        return jsonify({'error': err}), 401

    with builds_lock:
        runs = sorted(builds.values(), key=lambda b: b['created_at'], reverse=True)[:10]
        # Map to the same format the frontend expects
        result = []
        for b in runs:
            conclusion = None
            if b['status'] == 'completed':
                conclusion = 'success'
            elif b['status'] == 'failed':
                conclusion = 'failure'
            result.append({
                'id': b['id'],
                'status': 'completed' if b['status'] in ('completed', 'failed') else b['status'],
                'conclusion': conclusion,
                'created_at': b['created_at'],
                'updated_at': b['updated_at'],
                'html_url': None,
                'name': f"Build: {b['domain']} ({b['steps']})",
                'log': b.get('log', [])[-20:],
            })

    return jsonify({'runs': result})


@app.route('/api/admin/switch-domain', methods=['POST'])
def switch_domain():
    ok, err = check_admin_token()
    if not ok:
        return jsonify({'error': err}), 401

    body = request.get_json(silent=True) or {}
    domain = body.get('domain')
    if not domain:
        return jsonify({'error': 'domain is required'}), 400

    script = REPO_ROOT / 'dashboard' / 'scripts' / 'switch-domain.sh'
    if not script.exists():
        return jsonify({'error': 'switch-domain.sh not found'}), 500

    result = subprocess.run(
        ['bash', str(script), domain],
        cwd=str(REPO_ROOT / 'dashboard'),
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return jsonify({'error': result.stderr or 'Switch failed'}), 500

    return jsonify({'success': True, 'message': f'Switched to {domain}. Refresh the page.'})


@app.route('/api/admin/upload', methods=['POST'])
def upload_domain():
    ok, err = check_admin_token()
    if not ok:
        return jsonify({'error': err}), 401

    body = request.get_json(silent=True) or {}
    domain = body.get('domain')
    csv_content = body.get('csvContent')
    if not domain or not csv_content:
        return jsonify({'error': 'domain and csvContent are required'}), 400

    import base64

    slug_dashed = domain.replace('_', '-')
    domain_dir = DATASETS_DIR / slug_dashed
    domain_dir.mkdir(parents=True, exist_ok=True)

    csv_filename = body.get('csvFilename', f'{domain}.csv')
    csv_path = domain_dir / csv_filename
    csv_path.write_text(csv_content)

    # Unzip PDFs if provided
    pdf_zip_b64 = body.get('pdfZipBase64')
    if pdf_zip_b64:
        import zipfile
        import io
        papers_dir = domain_dir / 'papers'
        papers_dir.mkdir(exist_ok=True)
        zip_bytes = base64.b64decode(pdf_zip_b64)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            zf.extractall(str(papers_dir))

    # Create domain YAML
    display_name = body.get('displayName', domain.replace('_', ' ').title())
    method_noun = body.get('methodNoun', 'method')
    yaml_content = f"""domain: {domain}
csv_path: datasets/{slug_dashed}/{csv_filename}
papers_dir: datasets/{slug_dashed}/papers/
display_name: "{display_name}"
method_noun: "{method_noun}"

# Column-to-role mappings will be auto-generated during build.
# Edit this file to refine mappings after the initial build.
columns: {{}}
"""
    yaml_path = DOMAINS_DIR / f'{domain}.yaml'
    DOMAINS_DIR.mkdir(exist_ok=True)
    yaml_path.write_text(yaml_content)

    return jsonify({
        'success': True,
        'files': [str(csv_path), str(yaml_path)],
    })


# ─── Build runner ───

def _run_build(build_id, domain, steps):
    def log(msg):
        with builds_lock:
            builds[build_id]['log'].append(msg)
            builds[build_id]['updated_at'] = datetime.utcnow().isoformat() + 'Z'
        print(f"[build:{build_id}] {msg}")

    with builds_lock:
        builds[build_id]['status'] = 'in_progress'

    log(f"Starting build for {domain}, steps: {steps}")
    cmd = [
        sys.executable,
        str(REPO_ROOT / 'scripts' / 'ingest_domain.py'),
        '--domain', domain,
        '--steps', steps,
    ]
    env = {**os.environ, 'GROBID_URL': os.environ.get('GROBID_URL', 'http://grobid:8070')}

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=env,
        )
        for line in proc.stdout:
            log(line.rstrip())
        proc.wait()

        if proc.returncode == 0:
            log("Build completed successfully.")
            with builds_lock:
                builds[build_id]['status'] = 'completed'
        else:
            log(f"Build exited with code {proc.returncode}")
            with builds_lock:
                builds[build_id]['status'] = 'failed'
    except Exception as e:
        log(f"Build error: {e}")
        with builds_lock:
            builds[build_id]['status'] = 'failed'


def _yaml_value(text, key):
    import re
    m = re.search(rf'^{key}:\s*["\']?([^"\'#\n]+)', text, re.MULTILINE)
    return m.group(1).strip() if m else None


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    if not DASHBOARD_BUILD.exists():
        print(f"Warning: {DASHBOARD_BUILD} not found. Run 'npm run build' in dashboard/ first.")
    print(f"Build runner starting on port {port}")
    print(f"  Dashboard: {DASHBOARD_BUILD}")
    print(f"  Domains:   {DOMAINS_DIR}")
    print(f"  Admin token: {'set' if os.environ.get('ADMIN_TOKEN') else 'NOT SET'}")
    app.run(host='0.0.0.0', port=port, debug=False)
