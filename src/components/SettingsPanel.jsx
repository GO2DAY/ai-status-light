import React, { useCallback, useEffect, useState } from 'react';
import { STATUS_META, statusLabel, formatRelativeTime, t } from '../statusMeta';

/**
 * Settings card: fully self-service management of AI sources.
 *
 * The user adds / removes / edits AI lights here WITHOUT talking to any
 * assistant. Key UX decisions:
 *  - Add form only asks for a display name (required) + an optional process
 *    name (e.g. ChatGPT.exe). The agent id is auto-derived; latin names slug
 *    directly, non-latin names fall back to a generated id.
 *  - Filling in a process name wires up the desktop watcher automatically
 *    (config.json "watchers"), effective within ~5s, no restart.
 *  - Each agent row shows its watched process and allows inline editing.
 *  - A usage guide (light colors, how to find a process name) lives at the
 *    bottom, expanded by default, collapsible.
 * v1.5.0: 全部文案双语；关闭 × 醒目化（34px 命中区 + 悬停底色块）。
 */
export default function SettingsPanel({ agents, settings, onToggleSound, onAdd, onRemove, onClose }) {
  const [name, setName] = useState('');
  const [processName, setProcessName] = useState('');
  const [error, setError] = useState('');
  const [watchers, setWatchers] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [guideOpen, setGuideOpen] = useState(true);
  const soundOn = settings ? settings.soundOn !== false : true;

  const refreshWatchers = useCallback(() => {
    if (window.statusLight && window.statusLight.getWatchers) {
      window.statusLight.getWatchers().then((list) => setWatchers(Array.isArray(list) ? list : []));
    }
  }, []);

  useEffect(() => {
    refreshWatchers();
  }, [refreshWatchers]);

  const watcherFor = (agentId) => watchers.find((w) => w.agent === agentId) || null;

  const makeId = (displayName) => {
    const slug = displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || `ai-${Date.now().toString(36)}`;
  };

  const handleAdd = async (event) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('panel.errNameRequired'));
      return;
    }
    const proc = processName.trim();
    const result = await onAdd({
      id: makeId(trimmedName),
      name: trimmedName,
      ...(proc ? { process: proc } : {}),
    });
    if (result && result.ok) {
      setName('');
      setProcessName('');
      setError('');
      refreshWatchers();
    } else {
      setError((result && result.error) || t('panel.errAddFailed'));
    }
  };

  const startEdit = (agentId) => {
    const w = watcherFor(agentId);
    setEditingId(agentId);
    setEditValue(w ? w.process : '');
  };

  const saveEdit = async () => {
    if (!editingId) return;
    await window.statusLight.setWatcher(editingId, editValue.trim());
    setEditingId(null);
    setEditValue('');
    refreshWatchers();
  };

  return (
    <div className="asl-no-drag max-h-[460px] overflow-y-auto border-t border-white/10 bg-[#111827] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="whitespace-nowrap text-sm font-semibold text-gray-100">{t('panel.title')}</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-[34px] w-[34px] items-center justify-center rounded-md bg-white/5 text-xl font-bold leading-none text-gray-300 transition-colors hover:bg-red-500/25 hover:text-red-300"
          aria-label={t('panel.close')}
          title={t('panel.close')}
        >
          ×
        </button>
      </div>

      {/* Alert sound toggle */}
      <div className="mt-2 flex items-center gap-2 border-t border-white/5 pt-2 text-[12px]">
        <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-gray-200">
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(e) => onToggleSound(e.target.checked)}
            className="h-3.5 w-3.5 accent-purple-500"
          />
          {t('panel.sound')}
        </label>
        <span className="ml-auto whitespace-nowrap text-[10px] text-gray-500">
          {t('panel.soundHint')}
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {agents.map((agent) => {
          const meta = STATUS_META[agent.status] || STATUS_META.offline;
          const hb = agent.lastHeartbeat ? formatRelativeTime(agent.lastHeartbeat) : t('time.never');
          const w = watcherFor(agent.id);
          return (
            <li key={agent.id} className="rounded px-1.5 py-1 text-[12px] hover:bg-white/5">
              <div className="flex items-center gap-2">
                <span className={`block h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
                <span className="whitespace-nowrap text-gray-200">{agent.name}</span>
                <span className="shrink-0 whitespace-nowrap rounded bg-white/5 px-1 text-[10px] text-gray-400">
                  {statusLabel(agent.status)}
                </span>
                <span className="ml-auto whitespace-nowrap text-[10px] text-gray-500">{hb}</span>
                <button
                  type="button"
                  onClick={() => onRemove(agent.id)}
                  className="shrink-0 whitespace-nowrap rounded px-1.5 text-[11px] text-red-400 hover:bg-red-500/10"
                >
                  {t('panel.delete')}
                </button>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-[18px] text-[10px] text-gray-500">
                {editingId === agent.id ? (
                  <>
                    <span className="whitespace-nowrap">{t('panel.monitorEditing')}</span>
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                      placeholder={t('panel.monitorPlaceholder')}
                      className="flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-100 outline-none placeholder:text-gray-600 focus:border-white/30"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={saveEdit}
                      className="shrink-0 whitespace-nowrap rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-blue-500"
                    >
                      {t('panel.save')}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="whitespace-nowrap">
                      {t('panel.monitor')} {w ? w.process : <span className="text-gray-600">{t('panel.monitorNone')}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEdit(agent.id)}
                      className="shrink-0 whitespace-nowrap rounded px-1 text-[10px] text-blue-400 hover:bg-blue-500/10"
                    >
                      {t('panel.monitorEdit')}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
        {agents.length === 0 ? (
          <li className="text-[12px] text-gray-500">{t('panel.empty')}</li>
        ) : null}
      </ul>

      {/* Add form: display name (required) + optional process watcher */}
      <form onSubmit={handleAdd} className="mt-3 space-y-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('panel.namePlaceholder')}
          className="w-full rounded border border-white/10 bg-white/5 px-1.5 py-1 text-[12px] text-gray-100 outline-none placeholder:text-gray-600 focus:border-white/30"
        />
        <div className="flex items-center gap-1.5">
          <input
            value={processName}
            onChange={(e) => setProcessName(e.target.value)}
            placeholder={t('panel.procPlaceholder')}
            className="flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-1 text-[12px] text-gray-100 outline-none placeholder:text-gray-600 focus:border-white/30"
          />
          <button
            type="submit"
            className="shrink-0 whitespace-nowrap rounded bg-blue-600 px-2.5 py-1 text-[12px] text-white hover:bg-blue-500"
          >
            {t('panel.add')}
          </button>
        </div>
      </form>
      {error ? <div className="mt-1 text-[11px] text-red-400">{error}</div> : null}

      {/* Usage guide */}
      <div className="mt-3 border-t border-white/10 pt-2">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] font-medium text-gray-300 hover:text-gray-100"
        >
          <span>{t('panel.guide')}</span>
          <span className="text-gray-500">{guideOpen ? t('panel.collapse') : t('panel.expand')}</span>
        </button>
        {guideOpen ? (
          <div className="mt-1.5 space-y-1.5 text-[11px] leading-relaxed text-gray-400">
            <p>
              <span className="text-gray-200">{t('panel.guideColors')}</span>
              {t('panel.guideColorsBody')}
            </p>
            <p>
              <span className="text-gray-200">{t('panel.guideAdd')}</span>
              {t('panel.guideAddBody')}
            </p>
            <p>
              <span className="text-gray-200">{t('panel.guideFind')}</span>
              {t('panel.guideFindBody')}
            </p>
            <p>
              <span className="text-gray-200">{t('panel.guideApi')}</span>
              {t('panel.guideApiBody')}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
