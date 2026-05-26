import React, { useState, useEffect } from 'react';
import { getProviders, loadSettings, saveSettings } from '../lib/llm-client';

export default function SettingsPanel({ onClose }) {
  const providers = getProviders();
  const [settings, setSettings] = useState(loadSettings);

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
            onChange={e => setSettings(s => ({ ...s, provider: e.target.value, apiKey: '', model: '' }))}
          >
            {Object.entries(providers).map(([key, p]) => (
              <option key={key} value={key}>{p.name}{p.requiresKey ? '' : ' (no key needed)'}</option>
            ))}
          </select>

          {providers[settings.provider]?.requiresKey && (
            <>
              <label>API Key</label>
              <input
                type="password"
                value={settings.apiKey}
                onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))}
                placeholder={`Enter ${providers[settings.provider].name} API key`}
              />
            </>
          )}

          <label>Model (optional)</label>
          <input
            type="text"
            value={settings.model}
            onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}
            placeholder={providers[settings.provider]?.defaultModel}
          />

          <p className="settings-note">
            {settings.provider === 'huggingface'
              ? 'HuggingFace free inference — no key required for most models.'
              : 'Your key is stored locally in your browser. Never sent to any server.'}
          </p>
        </div>
      </div>
    </div>
  );
}
