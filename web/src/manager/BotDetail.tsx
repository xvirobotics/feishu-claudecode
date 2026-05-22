/* ============================================================
   manager/BotDetail.tsx — single bot management page.

   Sections (tabs): Overview / Workdir / Env / Sessions / Logs
============================================================ */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Eye, EyeOff, MessageSquare, Play, RotateCw, Square, Trash2 } from 'lucide-react';
import {
  ApiError,
  deleteBot,
  getBot,
  startBot,
  stopBot,
  restartBot,
  patchWorkdir,
  patchEnv,
  patchHubVisible,
  type BotConfig,
  type BotDetailResponse,
  type BotSummary,
  type SessionMapping,
} from './api';
import { ConfirmModal, Modal, StatusPill, Switch } from './ui';
import { useToast } from './toast';
import { LogPanel } from './LogPanel';
import styles from './manager.module.css';

const POLL_MS = 3000;

type Tab = 'overview' | 'workdir' | 'env' | 'sessions' | 'logs';

interface BotDetailProps {
  onAuthLost: () => void;
}

interface EnvRow {
  id:      number;       // local row id
  key:     string;
  value:   string;
  removed: boolean;      // marked-for-deletion
  added:   boolean;      // brand-new row
  edited:  boolean;      // existing key whose value changed
}

let envRowSeq = 0;

function envRowsFromConfig(env: Record<string, string> | undefined): EnvRow[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({
    id:      ++envRowSeq,
    key,
    value,
    removed: false,
    added:   false,
    edited:  false,
  }));
}

export function BotDetail({ onAuthLost }: BotDetailProps) {
  const { name = '' }       = useParams<{ name: string }>();
  const navigate            = useNavigate();
  const toast               = useToast();
  const [data, setData]     = useState<BotDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]       = useState<Tab>('overview');
  const [actBusy, setActBusy] = useState<null | 'start' | 'stop' | 'restart'>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteClearSessions, setDeleteClearSessions] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function handleDelete() {
    setDeleteBusy(true);
    try {
      const res = await deleteBot(name, { clearSessions: deleteClearSessions });
      toast.show(
        `已删除 bot ${res.removed}` + (res.sessionsCleared ? ' (sessions 已清空)' : ''),
        'success',
      );
      navigate('/manager/dashboard');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      toast.show(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setDeleteBusy(false);
      setShowDelete(false);
    }
  }

  const mountedRef = useRef(true);

  const refresh = useCallback(async (silent = false) => {
    try {
      const res = await getBot(name);
      if (!mountedRef.current) return;
      setData(res);
      setLoading(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      if (!silent) {
        toast.show(err instanceof Error ? err.message : '加载失败', 'error');
      }
      if (mountedRef.current) setLoading(false);
    }
  }, [name, onAuthLost, toast]);

  // Initial + polling refresh of status
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setData(null);
    refresh(false);

    const timer = setInterval(() => {
      refresh(true);
    }, POLL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  async function handleAction(kind: 'start' | 'stop' | 'restart') {
    setActBusy(kind);
    try {
      let res: { status: BotSummary };
      if (kind === 'start')   res = await startBot(name);
      else if (kind === 'stop')    res = await stopBot(name);
      else                          res = await restartBot(name);
      toast.show(`${kind} 已发起`, 'success');
      setData((prev) => (prev ? { ...prev, status: res.status } : prev));
      refresh(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      toast.show(err instanceof Error ? err.message : `${kind} 失败`, 'error');
    } finally {
      setActBusy(null);
    }
  }

  if (loading || !data) {
    return (
      <div className={styles.content}>
        <div className={styles.statusBlock}>
          {loading ? '正在加载…' : '加载失败'}
        </div>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => navigate('/manager/dashboard')}
          >
            返回列表
          </button>
        </div>
      </div>
    );
  }

  const { config, status, sessions } = data;

  return (
    <div className={styles.content}>
      <div className={styles.detailHeader}>
        <button
          type="button"
          className={styles.topBarBack}
          onClick={() => navigate('/manager/dashboard')}
        >
          <ChevronLeft size={14} strokeWidth={2.25} />
          <span>返回</span>
        </button>
        <h1>{name}</h1>
        <StatusPill status={status.status} />
        <div style={{ flex: 1 }} />
        <div className={styles.actionBar}>
          <button
            type="button"
            className={styles.actionBtn + ' ' + styles.actionBtnPrimary}
            onClick={() => handleAction('start')}
            disabled={actBusy !== null || status.status === 'online'}
          >
            <Play size={14} strokeWidth={2.25} />
            <span>{actBusy === 'start' ? '启动中…' : '启动'}</span>
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => handleAction('restart')}
            disabled={actBusy !== null}
          >
            <RotateCw
              size={14}
              strokeWidth={2.25}
              className={actBusy === 'restart' ? styles.iconSpinning : ''}
            />
            <span>{actBusy === 'restart' ? '重启中…' : '重启'}</span>
          </button>
          <button
            type="button"
            className={styles.actionBtn + ' ' + styles.actionBtnDanger}
            onClick={() => handleAction('stop')}
            disabled={actBusy !== null || status.status === 'stopped'}
          >
            <Square size={13} strokeWidth={2.25} fill="currentColor" />
            <span>{actBusy === 'stop' ? '停止中…' : '停止'}</span>
          </button>
          <button
            type="button"
            className={styles.actionBtn + ' ' + styles.actionBtnDanger}
            onClick={() => setShowDelete(true)}
            disabled={actBusy !== null}
            title="从 bots.json 与 pm2 中彻底移除该 bot"
          >
            <Trash2 size={14} strokeWidth={2.25} />
            <span>删除…</span>
          </button>
        </div>
      </div>

      {showDelete && (
        <Modal
          title={`删除 bot: ${name}`}
          onClose={() => setShowDelete(false)}
          maxWidth={520}
          footer={
            <>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => setShowDelete(false)}
                disabled={deleteBusy}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.actionBtn + ' ' + styles.actionBtnDanger}
                onClick={handleDelete}
                disabled={deleteBusy}
              >
                {deleteBusy ? '删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <div className={styles.confirmText}>
            将从 <code>bots.json</code> 中移除该 bot,并执行 <code>pm2 delete {name}</code>。
            <br />
            <strong>该操作不可逆</strong>。
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <input
              type="checkbox"
              checked={deleteClearSessions}
              onChange={(e) => setDeleteClearSessions(e.target.checked)}
              disabled={deleteBusy}
            />
            <span>同时清空 sessions(<code>sessions-{name}.json</code> + <code>sessions.db</code>)</span>
          </label>
          <div className={styles.confirmWarn}>
            说明: 数据目录 <code>~/.metabot/{name}/</code> 不会被自动删除,如有需要请手动清理。
          </div>
        </Modal>
      )}

      <div className={styles.tabs}>
        {(['overview', 'workdir', 'env', 'sessions', 'logs'] as Tab[]).map((k) => (
          <button
            key={k}
            type="button"
            className={styles.tab + ' ' + (tab === k ? styles.tabActive : '')}
            onClick={() => setTab(k)}
          >
            {k === 'overview' && '概览'}
            {k === 'workdir' && '工作目录'}
            {k === 'env' && '环境变量'}
            {k === 'sessions' && '会话'}
            {k === 'logs' && '日志'}
          </button>
        ))}
      </div>

      {tab === 'overview'   && (
        <OverviewSection
          name={name}
          status={status}
          config={config}
          onUpdated={() => refresh(true)}
          onAuthLost={onAuthLost}
        />
      )}
      {tab === 'workdir'    && (
        <WorkdirSection
          name={name}
          config={config}
          onUpdated={() => refresh(true)}
          onAuthLost={onAuthLost}
        />
      )}
      {tab === 'env'        && (
        <EnvSection
          name={name}
          config={config}
          onUpdated={() => refresh(true)}
          onAuthLost={onAuthLost}
        />
      )}
      {tab === 'sessions'   && <SessionsSection sessions={sessions} />}
      {tab === 'logs'       && <LogPanel botName={name} />}
    </div>
  );
}

/* ── Overview ────────────────────────────────────────────── */
function OverviewSection({
  name,
  status,
  config,
  onUpdated,
  onAuthLost,
}: {
  name:       string;
  status:     BotSummary;
  config:     BotConfig;
  onUpdated:  () => void;
  onAuthLost: () => void;
}) {
  const toast                   = useToast();
  const [hubBusy, setHubBusy]   = useState(false);

  async function toggleHubVisible(next: boolean) {
    setHubBusy(true);
    try {
      await patchHubVisible(name, next);
      toast.show(next ? '已对 Hub 公开' : '已对 Hub 隐藏', 'success');
      onUpdated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      toast.show(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setHubBusy(false);
    }
  }

  const hubVisible = !!config.hubVisible;

  return (
    <div className={styles.detailGrid + ' ' + styles.twoCol}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>运行状态</div>
        <div className={styles.kvList}>
          <div className={styles.kvKey}>状态</div>
          <div className={styles.kvVal}><StatusPill status={status.status} /></div>

          <div className={styles.kvKey}>PID</div>
          <div className={styles.kvVal}>{status.pid ?? '-'}</div>

          <div className={styles.kvKey}>运行时长 (ms)</div>
          <div className={styles.kvVal}>{status.uptimeMs ?? '-'}</div>

          <div className={styles.kvKey}>CPU</div>
          <div className={styles.kvVal}>{status.cpu != null ? `${status.cpu.toFixed(1)}%` : '-'}</div>

          <div className={styles.kvKey}>内存 (MB)</div>
          <div className={styles.kvVal}>{status.memMb != null ? status.memMb.toFixed(1) : '-'}</div>

          <div className={styles.kvKey}>重启次数</div>
          <div className={styles.kvVal}>{status.restarts ?? '-'}</div>

          <div className={styles.kvKey}>API 端口</div>
          <div className={styles.kvVal}>{status.apiPort ?? '-'}</div>

          <div className={styles.kvKey}>Memory 端口</div>
          <div className={styles.kvVal}>{status.memoryPort ?? '-'}</div>

          <div className={styles.kvKey}>会话数</div>
          <div className={styles.kvVal}>{status.sessionCount ?? '-'}</div>

          {status.lastError && (
            <>
              <div className={styles.kvKey}>最后错误</div>
              <div className={styles.kvVal} style={{ color: 'var(--red)' }}>{status.lastError}</div>
            </>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>配置</div>
        <div className={styles.kvList}>
          <div className={styles.kvKey}>name</div>
          <div className={styles.kvVal}>{config.name}</div>

          <div className={styles.kvKey}>feishuAppId</div>
          <div className={styles.kvVal}>{config.feishuAppId}</div>

          <div className={styles.kvKey}>feishuAppSecret</div>
          <div className={styles.kvVal}>{config.feishuAppSecret}</div>

          <div className={styles.kvKey}>defaultWorkingDirectory</div>
          <div className={styles.kvVal}>{config.defaultWorkingDirectory ?? '-'}</div>

          <div className={styles.kvKey}>publicBaseUrl</div>
          <div className={styles.kvVal}>{config.publicBaseUrl ?? '-'}</div>

          <div className={styles.kvKey}>persistentExecutor</div>
          <div className={styles.kvVal}>{String(config.persistentExecutor ?? false)}</div>

          <div className={styles.kvKey}>transcriptDisableAuth</div>
          <div className={styles.kvVal}>{String(config.transcriptDisableAuth ?? false)}</div>

          <div className={styles.kvKey}>transcriptAllowOpenIds</div>
          <div className={styles.kvVal}>
            {config.transcriptAllowOpenIds && config.transcriptAllowOpenIds.length > 0
              ? config.transcriptAllowOpenIds.join(', ')
              : '-'}
          </div>
        </div>

        <div
          style={{
            display:      'flex',
            alignItems:   'flex-start',
            gap:          10,
            marginTop:    16,
            paddingTop:   14,
            borderTop:    '1px solid var(--border, #e5e7eb)',
          }}
        >
          {hubVisible
            ? <Eye size={16} style={{ marginTop: 2, flexShrink: 0 }} />
            : <EyeOff size={16} style={{ marginTop: 2, flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>对 Hub 可见</div>
            <div className={styles.dim} style={{ fontSize: 12, lineHeight: 1.45 }}>
              启用后此 bot 出现在中心化 Hub UI 中(仅展示进程状态与会话数;不发送 feishuAppSecret/env 等敏感字段)。
            </div>
          </div>
          <Switch
            checked={hubVisible}
            disabled={hubBusy}
            onChange={toggleHubVisible}
            ariaLabel="对 Hub 可见"
          />
        </div>
      </div>
    </div>
  );
}

/* ── Workdir ─────────────────────────────────────────────── */
function WorkdirSection({
  name,
  config,
  onUpdated,
  onAuthLost,
}: {
  name:       string;
  config:     BotConfig;
  onUpdated:  () => void;
  onAuthLost: () => void;
}) {
  const toast               = useToast();
  const [val, setVal]       = useState(config.defaultWorkingDirectory ?? '');
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    setVal(config.defaultWorkingDirectory ?? '');
  }, [config.defaultWorkingDirectory]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!val.trim()) {
      toast.show('工作目录不能为空', 'error');
      return;
    }
    if (val === (config.defaultWorkingDirectory ?? '')) {
      toast.show('未发生变更', 'info');
      return;
    }
    setShowConfirm(true);
  }

  async function doSave() {
    setSaving(true);
    try {
      await patchWorkdir(name, val.trim());
      toast.show('工作目录已更新；所有会话已重置', 'success');
      setShowConfirm(false);
      onUpdated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      toast.show(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <form className={styles.section} onSubmit={handleSubmit}>
        <div className={styles.sectionTitle}>工作目录 (defaultWorkingDirectory)</div>
        <div className={styles.formField}>
          <label className={styles.label} htmlFor="wd-input">路径</label>
          <input
            id="wd-input"
            className={styles.input}
            type="text"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="/path/to/project"
            spellCheck={false}
          />
        </div>
        <div className={styles.formRowInline}>
          <button
            type="submit"
            className={styles.actionBtn + ' ' + styles.actionBtnPrimary}
            disabled={saving}
          >
            保存
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setVal(config.defaultWorkingDirectory ?? '')}
            disabled={saving}
          >
            重置
          </button>
        </div>
      </form>

      {showConfirm && (
        <ConfirmModal
          title="确认修改工作目录?"
          message={
            <>
              <div>把工作目录改为:</div>
              <div className={styles.mono} style={{ marginTop: 6 }}>{val.trim()}</div>
            </>
          }
          warn="此操作会清除该 bot 下所有 chatId 的会话绑定（sessions.db + sessions-<bot>.json）。"
          confirmText="确认并清除会话"
          danger
          busy={saving}
          onConfirm={doSave}
          onCancel={() => !saving && setShowConfirm(false)}
        />
      )}
    </>
  );
}

/* ── Env editor ──────────────────────────────────────────── */
function EnvSection({
  name,
  config,
  onUpdated,
  onAuthLost,
}: {
  name:       string;
  config:     BotConfig;
  onUpdated:  () => void;
  onAuthLost: () => void;
}) {
  const toast             = useToast();
  const [rows, setRows]   = useState<EnvRow[]>(() => envRowsFromConfig(config.env));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows(envRowsFromConfig(config.env));
  }, [config.env]);

  function update(id: number, patch: Partial<EnvRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id:      ++envRowSeq,
        key:     '',
        value:   '',
        removed: false,
        added:   true,
        edited:  false,
      },
    ]);
  }

  function toggleRemove(id: number) {
    setRows((prev) =>
      prev
        .map((r) => (r.id === id ? { ...r, removed: !r.removed } : r))
        .filter((r) => !(r.added && r.removed)), // dropping an unsaved new row
    );
  }

  async function handleSave() {
    const env:        Record<string, string> = {};
    const removeKeys: string[]               = [];
    const seen = new Set<string>();

    for (const r of rows) {
      const key = r.key.trim();
      if (!key) {
        if (r.added && !r.removed) continue; // empty unsaved row, just skip
        continue;
      }
      if (seen.has(key)) {
        toast.show(`重复的 key: ${key}`, 'error');
        return;
      }
      seen.add(key);

      if (r.removed) {
        removeKeys.push(key);
        continue;
      }

      // Only send keys whose value changed (or added rows) — backend merges
      const original = config.env?.[key];
      if (r.added || r.edited || original !== r.value) {
        env[key] = r.value;
      }
    }

    if (Object.keys(env).length === 0 && removeKeys.length === 0) {
      toast.show('未发生变更', 'info');
      return;
    }

    setSaving(true);
    try {
      await patchEnv(name, env, removeKeys.length ? removeKeys : undefined);
      toast.show('环境变量已更新', 'success');
      onUpdated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      toast.show(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>环境变量 (env)</div>

      <table className={styles.envTable}>
        <thead>
          <tr>
            <th style={{ width: '32%' }}>KEY</th>
            <th>VALUE</th>
            <th style={{ width: 80, textAlign: 'right' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className={styles.dim} style={{ textAlign: 'center', padding: 16 }}>
                暂无自定义环境变量
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} className={r.removed ? styles.envRowRemoved : ''}>
              <td>
                <input
                  className={styles.envKeyInput}
                  type="text"
                  value={r.key}
                  onChange={(e) => update(r.id, { key: e.target.value })}
                  disabled={!r.added}
                  spellCheck={false}
                />
              </td>
              <td>
                <input
                  className={styles.envValueInput}
                  type="text"
                  value={r.value}
                  placeholder={r.added ? '' : '(未变更)'}
                  onChange={(e) => update(r.id, { value: e.target.value, edited: true })}
                  spellCheck={false}
                />
              </td>
              <td style={{ textAlign: 'right' }}>
                <button
                  type="button"
                  className={styles.iconBtn + ' ' + styles.iconBtnDanger}
                  onClick={() => toggleRemove(r.id)}
                  title={r.removed ? '撤销删除' : '删除'}
                >
                  {r.removed ? '撤销' : '删除'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.formRowInline} style={{ justifyContent: 'space-between' }}>
        <button type="button" className={styles.actionBtn} onClick={addRow} disabled={saving}>
          + 新增
        </button>
        <button
          type="button"
          className={styles.actionBtn + ' ' + styles.actionBtnPrimary}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <div className={styles.dim} style={{ marginTop: 8, fontSize: 11.5 }}>
        说明: 已存在的密钥服务端会以 <code>***last4</code> 形式返回。输入新值即替换；空着不动表示保留原值。
      </div>
    </div>
  );
}

/* ── Sessions ────────────────────────────────────────────── */
const TITLE_MAX_LEN = 50;

function truncateTitle(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '(untitled)';
  return t.length > TITLE_MAX_LEN ? t.slice(0, TITLE_MAX_LEN) + '…' : t;
}

/** Format millis as a Chinese relative time (e.g. "2分钟前"). Falls back to locale date for >30 days. */
function formatRelative(ms: number | undefined): string {
  if (ms == null) return '';
  const diff = Date.now() - ms;
  if (diff < 0)              return '刚刚';
  const sec  = Math.floor(diff / 1000);
  if (sec    < 60)           return '刚刚';
  const min  = Math.floor(sec / 60);
  if (min    < 60)           return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour   < 24)           return `${hour}小时前`;
  const day  = Math.floor(hour / 24);
  if (day    < 30)           return `${day}天前`;
  return new Date(ms).toLocaleDateString();
}

function openTranscript(chatId: string) {
  const url = '/web/transcript/' + encodeURIComponent(chatId) + '?turn=all';
  window.open(url, '_blank', 'noopener,noreferrer');
}

function SessionsSection({ sessions }: { sessions: SessionMapping[] | undefined }) {
  if (sessions === undefined) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>会话</div>
        <div className={styles.sessionsEmpty}>正在加载…</div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>会话</div>
        <div className={styles.sessionsEmpty}>该 bot 暂无会话记录</div>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>会话</div>
      <ul className={styles.sessionsList} role="list">
        {sessions.map((s) => {
          const title    = truncateTitle(s.title);
          const subRight = formatRelative(s.lastUsed);
          return (
            <li key={s.chatId}>
              <button
                type="button"
                className={styles.sessionsRow}
                onClick={() => openTranscript(s.chatId)}
                title={`打开会话 ${s.chatId} 的完整对话`}
              >
                <div className={styles.sessionsIcon}>
                  <MessageSquare size={16} strokeWidth={2} />
                </div>
                <div className={styles.sessionsBody}>
                  <div className={styles.sessionsTitle}>{title}</div>
                  <div className={styles.sessionsSub}>
                    <span className={styles.sessionsChatId}>{s.chatId}</span>
                    {subRight && (
                      <>
                        <span className={styles.sessionsDot}>·</span>
                        <span className={styles.sessionsLastUsed}>{subRight}</span>
                      </>
                    )}
                  </div>
                </div>
                <ChevronRight size={16} strokeWidth={2} className={styles.sessionsChevron} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
