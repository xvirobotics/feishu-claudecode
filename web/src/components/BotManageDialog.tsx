import { useState, useCallback } from 'react';
import { useStore } from '../store';
import type { BotInfo } from '../types';
import styles from './BotManageDialog.module.css';

interface BotManageDialogProps {
  mode: 'create' | 'edit';
  bot?: BotInfo;
  onClose: () => void;
}

export function BotManageDialog({ mode, bot, onClose }: BotManageDialogProps) {
  const token = useStore((s) => s.token);

  const [name, setName] = useState(bot?.name || '');
  const [platform, setPlatform] = useState(bot?.platform || 'web');
  const [engine, setEngine] = useState(bot?.engine || 'claude');
  const [workDir, setWorkDir] = useState(bot?.workingDirectory || '');
  const [description, setDescription] = useState(bot?.description || '');
  const [model, setModel] = useState(bot?.model || '');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !workDir.trim()) {
      setError('Name and working directory are required');
      return;
    }
    setLoading(true);
    setError('');

    const body: Record<string, unknown> = {
      name: name.trim(),
      platform,
      defaultWorkingDirectory: workDir.trim(),
      engine,
    };
    if (description.trim()) body.description = description.trim();
    if (model.trim()) body.model = model.trim();
    if (engine === 'codex' && model.trim()) body.codex = { model: model.trim() };
    if (maxTurns.trim()) body.maxTurns = parseInt(maxTurns, 10);
    if (maxBudget.trim()) body.maxBudgetUsd = parseFloat(maxBudget);

    try {
      const url = mode === 'create'
        ? '/api/bots'
        : `/api/bots/${encodeURIComponent(bot!.name)}`;
      const method = mode === 'create' ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [name, platform, engine, workDir, description, model, maxTurns, maxBudget, mode, bot, token, onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>
          {mode === 'create' ? 'Add Bot' : `Edit ${bot?.name}`}
        </h2>

        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-bot"
              disabled={mode === 'edit'}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Platform</span>
            <select
              className={styles.input}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={mode === 'edit'}
            >
              <option value="web">Web</option>
              <option value="feishu">Feishu</option>
              <option value="telegram">Telegram</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Working Directory</span>
            <input
              className={styles.input}
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder="/home/user/project"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Engine</span>
            <select
              className={styles.input}
              value={engine}
              onChange={(e) => setEngine(e.target.value as 'claude' | 'kimi' | 'codex')}
            >
              <option value="claude">Claude Code</option>
              <option value="kimi">Kimi Code</option>
              <option value="codex">Codex CLI</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Description (optional)</span>
            <input
              className={styles.input}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this bot does"
            />
          </label>

          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Model (optional)</span>
              <input
                className={styles.input}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={engine === 'codex' ? 'gpt-5.4-codex' : engine === 'kimi' ? 'kimi-for-coding' : 'claude-opus-4-7'}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Max Turns</span>
              <input
                className={styles.input}
                type="number"
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                placeholder="30"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Budget ($)</span>
              <input
                className={styles.input}
                type="number"
                step="0.1"
                value={maxBudget}
                onChange={(e) => setMaxBudget(e.target.value)}
                placeholder="5.00"
              />
            </label>
          </div>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.submitBtn}
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
