import React from 'react';
import { STATUS_META, statusLabel, formatRelativeTime, t } from '../statusMeta';

/**
 * Detail card shown under the strip when a light is clicked.
 * v1.5.0: 全部文案双语（statusMeta.t 跟随当前语言）；关闭 × 醒目化
 * （34px 命中区 + 高对比 + 悬停底色块）。
 *
 * @param {object} props
 * @param {{id: string, name: string, status: string, task: string, lastHeartbeat: number, auto: boolean}} props.agent
 * @param {() => void} props.onClose
 * @param {(id: string) => void} props.onRemove
 * @param {(id: string) => void} props.onAck Called when the human acknowledges an assist alert.
 */
export default function DetailPanel({ agent, onClose, onRemove, onAck }) {
  const meta = STATUS_META[agent.status] || STATUS_META.offline;
  const heartbeatDate = agent.lastHeartbeat ? new Date(agent.lastHeartbeat) : null;
  // v1.7.0 rev4 对话溯源（老吴需求）：红/紫灯时高亮「出问题的对话」，
  // 取值优先级 thread 上报字段 > 活跃对话标题 > task 文案。
  const isAttention = agent.status === 'stuck' || agent.status === 'assist';
  const activeDialog =
    Array.isArray(agent.dialogs) ? agent.dialogs.find((d) => d && d.active) : null;
  const problemSource = agent.thread || (activeDialog && activeDialog.title) || agent.task || '';

  return (
    <div className="asl-no-drag border-t border-white/10 bg-[#111827] px-3 py-2.5">
      {isAttention ? (
        <div
          className={`mb-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] font-semibold ${
            agent.status === 'assist'
              ? 'bg-purple-500/20 text-purple-200'
              : 'bg-red-500/20 text-red-200'
          }`}
          data-testid="problem-dialog"
        >
          <span className="shrink-0">{agent.status === 'assist' ? '🟣' : '🔴'}</span>
          <span className="min-w-0 break-words">
            {t('detail.problemDialog')}
            {problemSource ? `：${problemSource}` : ''}
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`block h-3 w-3 rounded-full ${meta.dot}`} />
          <span className="text-sm font-semibold text-gray-100">{agent.name}</span>
          <span className="text-[11px] text-gray-500">{agent.id}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-[34px] w-[34px] items-center justify-center rounded-md bg-white/5 text-xl font-bold leading-none text-gray-300 transition-colors hover:bg-red-500/25 hover:text-red-300"
          aria-label={t('detail.close')}
          title={t('detail.close')}
        >
          ×
        </button>
      </div>

      <dl className="mt-2 space-y-1 text-[12px] leading-snug">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-gray-500">{t('detail.status')}</dt>
          <dd className="text-gray-200">
            {statusLabel(agent.status)}
            {agent.auto ? t('status.autoDowngrade') : ''}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-gray-500">{t('detail.task')}</dt>
          <dd className="break-words text-gray-200">{agent.task || t('detail.noTask')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-gray-500">{t('detail.heartbeat')}</dt>
          <dd className="text-gray-200">
            {heartbeatDate
              ? `${formatRelativeTime(agent.lastHeartbeat)}（${heartbeatDate.toLocaleTimeString()}）`
              : t('time.never')}
          </dd>
        </div>
        {/* 对话列表（v1.4.0）：该 AI 当前开着的每个窗口 = 一个并行对话。
            活跃的（画面还在变化 = 正在生成）排前面并带标记。 */}
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-gray-500">{t('detail.dialogs')}</dt>
          <dd className="min-w-0 flex-1 text-gray-200">
            {Array.isArray(agent.dialogs) && agent.dialogs.length > 0 ? (
              <ul className="space-y-0.5">
                {agent.dialogs.map((dlg, i) => (
                  <li key={i} className="flex items-center gap-1.5 break-words">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        dlg.active ? 'bg-green-400' : 'bg-gray-600'
                      }`}
                    />
                    <span className={dlg.active ? 'text-green-200' : 'text-gray-300'}>
                      {dlg.title}
                    </span>
                    {dlg.active ? (
                      <span className="shrink-0 rounded bg-green-500/20 px-1 text-[10px] text-green-300">
                        {t('detail.generating')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-gray-500">{t('detail.noDialogs')}</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-2.5 flex items-center justify-end gap-2">
        {agent.status === 'assist' ? (
          <button
            type="button"
            onClick={() => onAck(agent.id)}
            className="rounded bg-purple-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-purple-500"
            title={t('detail.ackTitle')}
          >
            {t('detail.ack')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onRemove(agent.id)}
          className="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10"
        >
          {t('detail.remove')}
        </button>
      </div>
    </div>
  );
}
