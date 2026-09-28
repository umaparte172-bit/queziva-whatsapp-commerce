import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useToast } from '../components';
import type { Milestone, Settings } from '../types';

const MILESTONES: { key: Milestone; label: string; hint: string }[] = [
  { key: 'SHIPPED', label: 'Dispatched', hint: 'Courier picked up the parcel – with courier, AWB and a Track Shipment button' },
  { key: 'IN_TRANSIT', label: 'In transit', hint: 'Can fire several times a day – off by default to avoid too many messages' },
  { key: 'OUT_FOR_DELIVERY', label: 'Out for delivery', hint: 'The day of delivery, with a Track Shipment button' },
  { key: 'DELIVERY_ATTEMPT_FAILED', label: 'Delivery attempt failed', hint: 'The courier could not deliver and will try again' },
  { key: 'DELIVERED', label: 'Delivered', hint: 'Includes the unboxing-video request' },
];

export function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((r) => setSettings(r.settings))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!settings) return error ? <div className="alert alert-danger">{error}</div> : <div className="empty">Loading settings…</div>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const hours = settings.feedback.delayHours;
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      setError('Hours after delivery must be between 1 and 720');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setSettings((await api.saveSettings(settings)).settings);
      toast('Settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="stack" style={{ maxWidth: 760 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>Settings</h1>
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Shipping updates on WhatsApp</h2>
        </div>
        <div className="card-body stack" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>
            Choose which Shiprocket tracking updates are sent to customers. Every update is always recorded in the order history.
          </p>
          {MILESTONES.map((m) => (
            <label key={m.key} className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ marginTop: 3 }}
                checked={settings.notify[m.key]}
                onChange={(e) => setSettings({ ...settings, notify: { ...settings.notify, [m.key]: e.target.checked } })}
              />
              <span>
                <span className="cell-title">{m.label}</span>
                <div className="cell-sub">{m.hint}</div>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Feedback &amp; Instagram follow-up</h2>
        </div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <label className="row" style={{ gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.feedback.enabled}
              onChange={(e) => setSettings({ ...settings, feedback: { ...settings.feedback, enabled: e.target.checked } })}
            />
            <span className="cell-title">Ask for feedback after delivery</span>
          </label>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 140 }}>
              <label htmlFor="delay">Hours after delivery</label>
              <input
                id="delay"
                className="input"
                type="number"
                min={1}
                max={720}
                disabled={!settings.feedback.enabled}
                value={settings.feedback.delayHours}
                onChange={(e) => setSettings({ ...settings, feedback: { ...settings.feedback, delayHours: Number(e.target.value) } })}
              />
            </div>
            <span className="faint" style={{ paddingBottom: 8 }}>
              The order is marked completed when this message goes out.
            </span>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="field" style={{ width: 220 }}>
              <label htmlFor="ig">Instagram handle</label>
              <input id="ig" className="input" placeholder="queziva" value={settings.instagramHandle} onChange={(e) => setSettings({ ...settings, instagramHandle: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 240 }}>
              <label htmlFor="review">Review link (optional)</label>
              <input
                id="review"
                className="input"
                placeholder="https://g.page/r/…/review"
                value={settings.reviewUrl}
                onChange={(e) => setSettings({ ...settings, reviewUrl: e.target.value })}
              />
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
