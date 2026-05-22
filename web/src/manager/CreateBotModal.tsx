/* ============================================================
   manager/CreateBotModal.tsx — modal for creating a new bot.

   Required fields: name, feishuAppId, feishuAppSecret, defaultWorkingDirectory.
   Optional: description, publicBaseUrl, transcriptDisableAuth/AllowOpenIds,
   env (JSON), insertAtIndex.
============================================================ */

import { useState, type FormEvent } from 'react';
import { ApiError, createBot, type CreateBotInput } from './api';
import { Modal } from './ui';
import { useToast } from './toast';
import styles from './manager.module.css';

interface CreateBotModalProps {
  onClose:     () => void;
  onCreated:   (name: string) => void;
  onAuthLost:  () => void;
}

export function CreateBotModal({ onClose, onCreated, onAuthLost }: CreateBotModalProps) {
  const toast                       = useToast();
  const [name, setName]             = useState('');
  const [feishuAppId, setAppId]     = useState('');
  const [feishuAppSecret, setSec]   = useState('');
  const [workdir, setWorkdir]       = useState('');
  const [description, setDesc]     = useState('');
  const [publicBaseUrl, setBase]    = useState('');
  const [envJson, setEnvJson]       = useState('');
  const [insertIdx, setInsertIdx]   = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim())            { setError('name 必填');             return; }
    if (!feishuAppId.trim())     { setError('feishuAppId 必填');      return; }
    if (!feishuAppSecret.trim()) { setError('feishuAppSecret 必填');  return; }
    if (!workdir.trim())         { setError('工作目录必填');           return; }
    if (!workdir.startsWith('/')) { setError('工作目录必须是绝对路径'); return; }

    let env: Record<string, string> | undefined;
    const envTrim = envJson.trim();
    if (envTrim) {
      try {
        const parsed = JSON.parse(envTrim);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError('env 必须是 JSON 对象');
          return;
        }
        env = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v !== 'string') {
            setError(`env.${k} 必须是字符串`);
            return;
          }
          env[k] = v;
        }
      } catch (err) {
        setError(`env JSON 解析失败: ${(err as Error).message}`);
        return;
      }
    }

    let insertAtIndex: number | undefined;
    const idxTrim = insertIdx.trim();
    if (idxTrim) {
      const n = parseInt(idxTrim, 10);
      if (!Number.isFinite(n) || n < 0) {
        setError('插入位置必须是非负整数');
        return;
      }
      insertAtIndex = n;
    }

    const input: CreateBotInput = {
      name:                    name.trim(),
      feishuAppId:             feishuAppId.trim(),
      feishuAppSecret:         feishuAppSecret.trim(),
      defaultWorkingDirectory: workdir.trim(),
    };
    if (description.trim())   input.description   = description.trim();
    if (publicBaseUrl.trim()) input.publicBaseUrl = publicBaseUrl.trim();
    if (env && Object.keys(env).length > 0) input.env = env;
    if (insertAtIndex !== undefined) input.insertAtIndex = insertAtIndex;

    setBusy(true);
    try {
      await createBot(input);
      toast.show(`bot ${input.name} 已创建`, 'success');
      onCreated(input.name);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      const msg = err instanceof Error ? err.message : '创建失败';
      setError(msg);
      toast.show(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新建 bot"
      onClose={onClose}
      maxWidth={620}
      footer={
        <>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="submit"
            form="create-bot-form"
            className={styles.actionBtn + ' ' + styles.actionBtnPrimary}
            disabled={busy}
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <form id="create-bot-form" onSubmit={handleSubmit} className={styles.createBotForm}>
        <label className={styles.formField}>
          <span className={styles.formLabel}>name <em>*</em></span>
          <input
            className={styles.input}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 MyBot (字母/数字/CJK/下划线/短横)"
            autoFocus
            required
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>feishuAppId <em>*</em></span>
          <input
            className={styles.input}
            type="text"
            value={feishuAppId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="cli_..."
            required
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>feishuAppSecret <em>*</em></span>
          <input
            className={styles.input}
            type="password"
            value={feishuAppSecret}
            onChange={(e) => setSec(e.target.value)}
            placeholder="飞书 app secret"
            autoComplete="new-password"
            required
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>工作目录 (绝对路径) <em>*</em></span>
          <input
            className={styles.input}
            type="text"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="/vepfs/users/ameng/workspace/MY_PROJECT"
            required
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>描述 (可选)</span>
          <input
            className={styles.input}
            type="text"
            value={description}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="一句话说明这个 bot 用来干什么"
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>publicBaseUrl (可选)</span>
          <input
            className={styles.input}
            type="text"
            value={publicBaseUrl}
            onChange={(e) => setBase(e.target.value)}
            placeholder="https://xxx.trycloudflare.com (transcript 页公网入口)"
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>env (JSON, 可选)</span>
          <textarea
            className={styles.input}
            value={envJson}
            onChange={(e) => setEnvJson(e.target.value)}
            placeholder={`{\n  "ANTHROPIC_BASE_URL": "https://...",\n  "ANTHROPIC_AUTH_TOKEN": "sk-..."\n}`}
            rows={6}
            spellCheck={false}
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>插入位置 (可选)</span>
          <input
            className={styles.input}
            type="number"
            value={insertIdx}
            onChange={(e) => setInsertIdx(e.target.value)}
            placeholder="留空 = 追加到末尾;指定整数会插入到该 index"
            min={0}
          />
          <div className={styles.formHint}>
            端口由 ecosystem 按位置计算 (API_PORT_BASE + index*3)。
            重建 bot 想保留原端口时填回原 index。
          </div>
        </label>

        {error && <div className={styles.formError}>{error}</div>}
      </form>
    </Modal>
  );
}
