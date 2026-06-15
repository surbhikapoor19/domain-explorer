import React, { useState, useEffect } from 'react';
import { getProviders, loadSettings, saveSettings } from '../lib/llm-client';

export default function SettingsPanel({ onClose }) {
  const providers = getProviders();
  const [settings, setSettings] = useState(loadSettings);
  const prov = providers[settings.provider];

  useEffect(() => { saveSettings(settings); }, [settings]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>AI Settings</h3>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="settings-body">
          <label>Provider</label>
          <select
            value={settings.provider}
            onChange={e => setSettings(s => ({ ...s, provider: e.target.value, apiKey: '', model: '', baseUrl: '' }))}
          >
            {Object.entries(providers).map(([key, p]) => (
              <option key={key} value={key}>{p.name}{p.requiresKey ? '' : '  (no key needed)'}</option>
            ))}
          </select>

          {prov?.requiresBaseUrl && (
            <>
              <label>Base URL</label>
              <input
                type="text"
                value={settings.baseUrl || ''}
                onChange={e => setSettings(s => ({ ...s, baseUrl: e.target.value }))}
                placeholder={prov.baseUrlPlaceholder}
              />
            </>
          )}

          {prov?.requiresKey && (
            <>
              <label>
                {prov.keyLabel || 'API Key'}
                {prov.keyUrl && (
                  <a className="settings-keylink" href={prov.keyUrl} target="_blank" rel="noopener noreferrer">
                    get a key →
                  </a>
                )}
              </label>
              <input
                type="password"
                value={settings.apiKey}
                onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))}
                placeholder={`Paste your ${prov.name} ${prov.keyLabel?.includes('token') ? 'token' : 'API key'}`}
              />
            </>
          )}

          <label>Model (optional)</label>
          <input
            type="text"
            value={settings.model}
            onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}
            placeholder={prov?.defaultModel || 'provider default'}
          />

          <p className="settings-note">
            {prov?.requiresKey
              ? 'Your key is stored only in this browser (localStorage) and sent directly to the provider — never to our server. Use this to run the copilot locally.'
              : 'Uses the server-side key. For local testing without a server key, pick Hugging Face, OpenRouter, or Groq above and paste your token.'}
          </p>
        </div>
      </div>
    </div>
  );
}
