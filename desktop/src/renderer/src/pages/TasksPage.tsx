import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, Clock, CalendarClock, Play, Plus, RefreshCw, Check } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import apiClient from '../api/client'
import type {
  SchedulerTask,
  TaskSchedule,
  TaskAction,
  SchedulerInstance,
  TaskRecipient,
} from '../types'
import { Modal, Btn, Toggle, TextInput, Dropdown, Field } from './settings/primitives'
import type { DropdownOption } from './settings/primitives'
import AgentAvatar from '../components/AgentAvatar'
import { useAgentStore, selectMultiAgent, findAgent } from '../store/agentStore'
import { askConfirm } from '../store/confirmStore'

interface TasksPageProps {
  baseUrl: string
}

// Human-readable schedule summary, mirroring the web console.
const scheduleSummary = (s: TaskSchedule): string => {
  if (s.type === 'cron') return s.expression || 'cron'
  if (s.type === 'interval') {
    const sec = s.seconds || 0
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const r = sec % 60
    const parts: string[] = []
    if (h) parts.push(`${h}h`)
    if (m) parts.push(`${m}m`)
    if (r || parts.length === 0) parts.push(`${r}s`)
    return parts.join(' ')
  }
  return s.type || 'once'
}

const formatNextRun = (iso?: string): string => {
  if (!iso) return '--'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '--' : d.toLocaleString()
}

// Middle-truncate a long recipient id so a dropdown row's right-hand id stays on
// one line (e.g. "o9cq807...MYB0@im.wechat"). Mirrors the web console.
const truncateId = (id: string, max = 22): string => {
  const s = String(id || '')
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

const recipientKey = (r: TaskRecipient): string =>
  `${r.instance_id || r.channel_type}:${r.receiver}`

// A visible error banner pinned to the top of a modal body, so a validation or
// save failure is never buried below a scrolled-past field.
const FormError: React.FC<{ message: string }> = ({ message }) =>
  message ? (
    <div className="rounded-btn border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </div>
  ) : null

const TasksPage: React.FC<TasksPageProps> = ({ baseUrl }) => {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<SchedulerTask[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<SchedulerTask | null>(null)
  const [creating, setCreating] = useState(false)
  const [runningId, setRunningId] = useState('')
  const multiAgent = useAgentStore(selectMultiAgent)

  const loadTasks = async () => {
    try {
      setLoading(true)
      const data = await apiClient.getSchedulerTasks()
      setTasks(data || [])
    } catch (err) {
      console.error('Failed to load tasks:', err)
      setTasks([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    apiClient.setBaseUrl(baseUrl)
    void loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl])

  const toggle = async (task: SchedulerTask, enabled: boolean) => {
    // Optimistic flip; revert on failure.
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, enabled } : x)))
    try {
      await apiClient.toggleTask(task.id, enabled, task.agent_id || '')
    } catch {
      setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, enabled: !enabled } : x)))
    }
  }

  // Run a task straight from its card, matching the web console's card action.
  const runFromCard = async (task: SchedulerTask) => {
    const ok = await askConfirm({ titleKey: 'task_run_now', msgKey: 'task_run_confirm', okKey: 'task_run_now' })
    if (!ok) return
    setRunningId(task.id)
    try {
      await apiClient.runTask(task.id, task.agent_id || '')
    } catch (err) {
      console.error('Failed to run task:', err)
    } finally {
      setRunningId('')
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 pt-5 pb-3 flex-shrink-0 flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-content">{t('tasks_title')}</h2>
          <p className="text-xs text-content-tertiary mt-1">{t('tasks_desc')}</p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => void loadTasks()}
          className="p-2 rounded-btn border border-strong text-content-secondary hover:bg-surface-2 cursor-pointer transition-colors"
          title={t('tasks_refresh')}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-btn bg-accent text-accent-contrast hover:bg-accent-hover text-sm font-medium cursor-pointer transition-colors"
        >
          <Plus size={15} />
          {t('tasks_new')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto border-t border-default">
        <div className="max-w-3xl mx-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-content-tertiary">
              <Loader2 size={18} className="animate-spin mr-2" />
              {t('tasks_loading')}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <CalendarClock size={32} className="mb-3 text-content-tertiary opacity-60" />
              <p className="text-content font-medium mb-1">{t('tasks_empty')}</p>
              <p className="text-sm text-content-tertiary max-w-sm mb-5">{t('tasks_empty_guide')}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCreating(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-btn bg-accent text-accent-contrast hover:bg-accent-hover text-sm font-medium cursor-pointer transition-colors"
                >
                  <Plus size={15} />
                  {t('tasks_new')}
                </button>
                <button
                  onClick={() => navigate('/')}
                  className="px-4 py-2 rounded-btn border border-strong text-content-secondary hover:bg-surface-2 text-sm font-medium cursor-pointer transition-colors"
                >
                  {t('tasks_go_chat')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              {tasks.map((task) => {
                const content = task.action?.content || task.action?.task_description || ''
                const owner = multiAgent && task.agent_id ? findAgent(task.agent_id) : null
                return (
                  <div
                    key={task.id}
                    onClick={() => setEditing(task)}
                    className={`rounded-card border border-default bg-surface p-4 cursor-pointer hover:border-strong transition-colors ${
                      task.enabled ? '' : 'opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${task.enabled ? 'bg-accent' : 'bg-content-tertiary'}`} />
                      <span className="font-medium text-sm text-content truncate">{task.name || task.id}</span>
                      {owner && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-inset-2 text-content-secondary flex-shrink-0"
                          title={owner.name || owner.id}
                        >
                          <AgentAvatar agent={owner} size={14} />
                          <span className="text-[11px] max-w-[80px] truncate">{owner.name || owner.id}</span>
                        </span>
                      )}
                      <div className="flex-1" />
                      <span className="text-xs font-mono text-content-tertiary">{scheduleSummary(task.schedule)}</span>
                    </div>
                    {content && <p className="text-xs text-content-secondary mb-2 line-clamp-2">{content}</p>}
                    {/* Whole card is the edit hit area; only the actual controls
                        below stop propagation, so clicking anywhere else in this
                        row (text / empty space) still opens the editor. */}
                    <div className="flex items-center gap-2 text-xs text-content-tertiary">
                      <Clock size={12} />
                      <span>
                        {t('tasks_next_run')}: {formatNextRun(task.next_run_at)}
                      </span>
                      <div className="flex-1" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void runFromCard(task)
                        }}
                        disabled={runningId === task.id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-btn border border-strong text-content-secondary hover:bg-surface-2 cursor-pointer transition-colors disabled:opacity-50"
                        title={t('task_run_now')}
                      >
                        {runningId === task.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Play size={11} />
                        )}
                      </button>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Toggle checked={task.enabled} onChange={(v) => toggle(task, v)} />
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <TaskEditModal
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void loadTasks()
          }}
          onDeleted={() => {
            setEditing(null)
            void loadTasks()
          }}
        />
      )}

      {creating && (
        <TaskCreateModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void loadTasks()
          }}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------
// Two-step recipient picker (channel instance -> recipient), shared by the
// create modal and the IM branch of the edit modal. It owns fetching the
// instance + recipient directories, scoping recipients to the chosen instance,
// a refresh control, and reporting the currently chosen recipient plus the
// Agent that would own the task (derived from the instance's binding).
// ------------------------------------------------------------------

interface PickerValue {
  instanceId: string
  recipient: TaskRecipient | null
}

const useRecipientPicker = (initial: { instanceId?: string; receiver?: string }) => {
  const [instances, setInstances] = useState<SchedulerInstance[]>([])
  const [recipients, setRecipients] = useState<TaskRecipient[]>([])
  const [instanceId, setInstanceId] = useState(initial.instanceId || '')
  const [recipientId, setRecipientId] = useState('') // key form instance:receiver
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [justRefreshed, setJustRefreshed] = useState(false)

  const loadRecipients = async () => {
    const list = await apiClient.getSchedulerRecipients().catch(() => [])
    setRecipients(list)
    return list
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [insts, recs] = await Promise.all([
        apiClient.getSchedulerInstances().catch(() => []),
        apiClient.getSchedulerRecipients().catch(() => []),
      ])
      if (cancelled) return
      setInstances(insts)
      setRecipients(recs)
      // Only keep a preselected instance we actually offer.
      const wanted = initial.instanceId && insts.some((i) => i.instance_id === initial.instanceId)
        ? initial.instanceId
        : ''
      setInstanceId(wanted)
      if (wanted && initial.receiver) {
        const match = recs.find(
          (r) => (r.instance_id || r.channel_type) === wanted && r.receiver === initial.receiver
        )
        if (match) setRecipientId(recipientKey(match))
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scoped = useMemo(
    () => recipients.filter((r) => (r.instance_id || r.channel_type) === instanceId),
    [recipients, instanceId]
  )

  // Default to the first recipient once an instance is chosen, so the common
  // case needs no extra click; keep a valid preselection otherwise.
  useEffect(() => {
    if (!instanceId) {
      setRecipientId('')
      return
    }
    const keys = scoped.map(recipientKey)
    if (!keys.includes(recipientId)) setRecipientId(keys[0] || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, scoped])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await loadRecipients()
      // Flash a check so the click has visible feedback even when the directory
      // is unchanged (the common case right after messaging the bot).
      setJustRefreshed(true)
      setTimeout(() => setJustRefreshed(false), 1200)
    } finally {
      setRefreshing(false)
    }
  }

  const selectedInstance = instances.find((i) => i.instance_id === instanceId) || null
  const selectedRecipient = scoped.find((r) => recipientKey(r) === recipientId) || null

  const value: PickerValue = { instanceId, recipient: selectedRecipient }

  return {
    instances,
    scoped,
    instanceId,
    setInstanceId,
    recipientId,
    setRecipientId,
    selectedInstance,
    loading,
    refreshing,
    justRefreshed,
    refresh,
    value,
  }
}

// The channel-instance dropdown (step 1). Rendered on its own so it can sit in
// the same 2-column row as the task-type dropdown, exactly like the web form.
// The instance name is the label; its channel type is a dim right-aligned hint,
// so the two never blur into one string.
const InstanceField: React.FC<{ picker: ReturnType<typeof useRecipientPicker> }> = ({ picker }) => {
  const { instances, instanceId, setInstanceId, loading } = picker
  const instanceOptions: DropdownOption[] = instances.map((i) => ({
    value: i.instance_id,
    label: i.name || i.instance_id,
    hint: i.channel_label || i.channel_type || '',
  }))
  return (
    <Field label={t('task_instance_label')} labelTip={t('task_channel_tip')}>
      <Dropdown
        value={instanceId}
        options={instanceOptions}
        hintAlign="inline"
        placeholder={loading ? t('tasks_loading') : instanceOptions.length ? t('task_instance_placeholder') : t('task_instance_empty')}
        disabled={loading || instanceOptions.length === 0}
        onChange={setInstanceId}
      />
    </Field>
  )
}

// The recipient dropdown (step 2), appearing once an instance is chosen. The
// refresh control spins while re-fetching and briefly flashes a check so the
// click always has visible feedback.
const RecipientField: React.FC<{ picker: ReturnType<typeof useRecipientPicker> }> = ({ picker }) => {
  const { scoped, instanceId, recipientId, setRecipientId, refresh, refreshing, justRefreshed } = picker
  if (!instanceId) return null
  const recipientOptions: DropdownOption[] = scoped.map((r) => ({
    value: recipientKey(r),
    label: r.name || r.receiver,
    hint: truncateId(r.receiver),
  }))
  return (
    <Field
      label={t('task_recipient_label')}
      labelAction={
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex items-center gap-1 text-content-tertiary hover:text-content-secondary cursor-pointer disabled:cursor-default"
          title={t('task_recipient_refresh')}
        >
          {justRefreshed ? (
            <Check size={12} className="text-success" />
          ) : (
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          )}
        </button>
      }
    >
      <Dropdown
        value={recipientId}
        options={recipientOptions}
        hintAlign="inline"
        placeholder={recipientOptions.length ? t('task_recipient_placeholder') : t('task_recipient_empty_hint')}
        disabled={recipientOptions.length === 0}
        onChange={setRecipientId}
      />
    </Field>
  )
}

// Which Agent will own the task, derived from the picked instance's binding
// (falls back to the default Agent). Rendered as a compact pill meant to sit in
// the modal header (next to the title) so it doesn't consume a body row.
// Hidden on a single-Agent install, and renders nothing when there is no owner.
const OwnerChip: React.FC<{ instance: SchedulerInstance | null; fallbackAgentId?: string }> = ({
  instance,
  fallbackAgentId,
}) => {
  const multiAgent = useAgentStore(selectMultiAgent)
  const defaultAgentId = useAgentStore((s) => s.defaultAgentId)
  const agentId = instance ? instance.agent_id || defaultAgentId : fallbackAgentId || ''
  const owner = agentId ? findAgent(agentId) : null
  if (!multiAgent || !owner) return null
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default bg-inset text-content-secondary min-w-0"
      title={owner.name || owner.id}
    >
      <AgentAvatar agent={owner} size={16} />
      <span className="text-xs max-w-[140px] truncate">{owner.name || owner.id}</span>
    </div>
  )
}

// ------------------------------------------------------------------
// Shared schedule + action form fields, so create and edit stay in lockstep.
// ------------------------------------------------------------------

interface FormState {
  name: string
  enabled: boolean
  schedType: TaskSchedule['type']
  cron: string
  interval: string
  runAt: string
  actionType: TaskAction['type']
  content: string
}

const buildSchedule = (f: FormState): TaskSchedule => {
  if (f.schedType === 'cron') return { type: 'cron', expression: f.cron.trim() }
  if (f.schedType === 'interval') return { type: 'interval', seconds: Number(f.interval) || 0 }
  return { type: 'once', run_at: f.runAt }
}

// Client-side required-field check so we never hand the backend an empty cron
// (which comes back as an opaque "cannot calculate next run time" error).
// Returns a localized message for the first problem, or '' when valid.
const validateForm = (f: FormState): string => {
  if (!f.name.trim()) return t('task_name_required')
  if (f.schedType === 'cron' && !f.cron.trim()) return t('task_cron_required')
  if (f.schedType === 'interval' && (!f.interval.trim() || Number(f.interval) < 60)) return t('task_interval_required')
  if (f.schedType === 'once' && !f.runAt) return t('task_once_required')
  return ''
}

// Name + enabled row, then schedule type paired with its value input — the
// exact top of the web console's task form.
const TaskScheduleFields: React.FC<{
  form: FormState
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void
}> = ({ form, set }) => (
  <>
    <div className="flex gap-4 items-end">
      <div className="flex-1">
        <Field label={t('task_name')} required>
          <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('task_name')} />
        </Field>
      </div>
      <div className="flex items-center gap-2 pb-2.5">
        <span className="text-xs font-medium text-content-secondary">{t('task_enabled')}</span>
        <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} />
      </div>
    </div>

    <div className="grid grid-cols-2 gap-4">
      <Field label={t('task_schedule_type')}>
        <Dropdown
          value={form.schedType}
          onChange={(v) => set('schedType', v as TaskSchedule['type'])}
          options={[
            { value: 'cron', label: t('task_type_cron') },
            { value: 'interval', label: t('task_type_interval') },
            { value: 'once', label: t('task_type_once') },
          ]}
        />
      </Field>
      {/* The value input for the chosen schedule type. Its usage hint lives in an
          info icon next to the label (dynamic per type), not a stray line below,
          and the field is marked required. */}
      {form.schedType === 'cron' && (
        <Field label={t('task_cron_expr')} labelTip={t('task_cron_hint')} required>
          <TextInput value={form.cron} onChange={(e) => set('cron', e.target.value)} placeholder="0 9 * * *" className="font-mono" />
        </Field>
      )}
      {form.schedType === 'interval' && (
        <Field label={t('task_interval_seconds')} labelTip={t('task_interval_hint')} required>
          <TextInput type="number" min={60} value={form.interval} onChange={(e) => set('interval', e.target.value)} placeholder="3600" />
        </Field>
      )}
      {form.schedType === 'once' && (
        <Field label={t('task_once_time')} required>
          <TextInput type="datetime-local" value={form.runAt} onChange={(e) => set('runAt', e.target.value)} />
        </Field>
      )}
    </div>
  </>
)

// Just the task-type dropdown, so it can share a 2-column row with the channel
// dropdown exactly like the web form.
const TaskTypeField: React.FC<{
  form: FormState
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void
}> = ({ form, set }) => (
  <Field label={t('task_action_type')}>
    <Dropdown
      value={form.actionType}
      onChange={(v) => set('actionType', v as TaskAction['type'])}
      options={[
        { value: 'send_message', label: t('task_action_send') },
        { value: 'agent_task', label: t('task_action_agent') },
      ]}
    />
  </Field>
)

// The content/description textarea. Its label follows the task type: "固定内容"
// for a fixed message, "任务描述" for an AI task — matching the web console.
const TaskContentField: React.FC<{
  form: FormState
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void
}> = ({ form, set }) => (
  <Field label={form.actionType === 'send_message' ? t('task_fixed_content') : t('task_task_description')}>
    <textarea
      value={form.content}
      onChange={(e) => set('content', e.target.value)}
      rows={3}
      placeholder={form.actionType === 'send_message' ? t('task_fixed_content') : t('task_task_description')}
      className="w-full px-3 py-2 rounded-btn border border-strong bg-inset text-sm text-content placeholder:text-content-tertiary focus:outline-none focus:border-accent transition-colors resize-none"
    />
  </Field>
)

// ------------------------------------------------------------------
// Create modal: pick a channel instance + recipient, then schedule an action.
// ------------------------------------------------------------------

const TaskCreateModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const [form, setForm] = useState<FormState>({
    name: '',
    enabled: true,
    schedType: 'cron',
    cron: '',
    interval: '',
    runAt: '',
    actionType: 'send_message',
    content: '',
  })
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((p) => ({ ...p, [k]: v }))
  const picker = useRecipientPicker({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const invalid = validateForm(form)
    if (invalid) return setError(invalid)
    if (!picker.value.instanceId) return setError(t('task_instance_required'))
    const recipient = picker.value.recipient
    if (!recipient) return setError(t('task_recipient_required'))
    if (!form.content.trim()) return setError(t('task_content_required'))

    const action: TaskAction = {
      type: form.actionType,
      channel_type: recipient.channel_type,
      instance_id: recipient.instance_id || recipient.channel_type,
      receiver: recipient.receiver,
    }
    if (form.actionType === 'send_message') action.content = form.content.trim()
    else action.task_description = form.content.trim()

    setSaving(true)
    setError('')
    try {
      const res = await apiClient.createTask({
        name: form.name.trim(),
        enabled: form.enabled,
        schedule: buildSchedule(form),
        action,
      })
      if (res.status !== 'success') throw new Error(res.message || t('task_create_error'))
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('task_create_error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      size="lg"
      title={t('task_add_title')}
      headerRight={<OwnerChip instance={picker.selectedInstance} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>
            {t('task_cancel')}
          </Btn>
          <Btn variant="primary" onClick={submit} disabled={saving}>
            {t('task_save')}
          </Btn>
        </>
      }
    >
      <FormError message={error} />
      <TaskScheduleFields form={form} set={set} />
      {/* Task type + channel side by side, then the recipient below — the exact
          web layout. */}
      <div className="grid grid-cols-2 gap-4">
        <TaskTypeField form={form} set={set} />
        <InstanceField picker={picker} />
      </div>
      <RecipientField picker={picker} />
      <TaskContentField form={form} set={set} />
    </Modal>
  )
}

// ------------------------------------------------------------------
// Edit modal: IM tasks reuse the same two-step picker (channel + recipient are
// switchable); Web tasks keep a read-only channel/receiver since a chat session
// is not a switchable delivery target.
// ------------------------------------------------------------------

const TaskEditModal: React.FC<{
  task: SchedulerTask
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}> = ({ task, onClose, onSaved, onDeleted }) => {
  const isWeb = (task.action.channel_type || 'web') === 'web'

  const [form, setForm] = useState<FormState>({
    name: task.name || '',
    enabled: task.enabled,
    schedType: task.schedule.type || 'cron',
    cron: task.schedule.expression || '',
    interval: task.schedule.seconds ? String(task.schedule.seconds) : '',
    runAt: task.schedule.run_at ? task.schedule.run_at.slice(0, 16) : '',
    actionType: task.action.type || 'send_message',
    content: task.action.content || task.action.task_description || '',
  })
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((p) => ({ ...p, [k]: v }))

  // IM tasks drive a live picker preselected to the current target; Web tasks
  // never construct it (their channel/receiver are frozen).
  const picker = useRecipientPicker(
    isWeb ? {} : { instanceId: task.action.instance_id || task.action.channel_type, receiver: task.action.receiver }
  )

  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runStatus, setRunStatus] = useState('')
  const [error, setError] = useState('')

  const buildAction = (): TaskAction => {
    // Preserve stored channel-specific fields (notify_session_id, silent,
    // dingtalk ids, ...) and overwrite only what the form/picker changed.
    const a: TaskAction = { ...task.action, type: form.actionType }
    if (form.actionType === 'send_message') {
      a.content = form.content
      delete a.task_description
    } else {
      a.task_description = form.content
      delete a.content
    }
    if (!isWeb && picker.value.recipient) {
      const r = picker.value.recipient
      a.channel_type = r.channel_type
      a.instance_id = r.instance_id || r.channel_type
      a.receiver = r.receiver
      a.receiver_name = r.name || r.receiver
      a.is_group = r.is_group || false
      a.notify_session_id = r.session_id || r.receiver
    }
    return a
  }

  const save = async () => {
    const invalid = validateForm(form)
    if (invalid) return setError(invalid)
    if (!isWeb && !picker.value.recipient) return setError(t('task_recipient_required'))
    if (!form.content.trim()) return setError(t('task_content_required'))
    setSaving(true)
    setError('')
    try {
      await apiClient.updateTask(
        task.id,
        {
          name: form.name.trim(),
          enabled: form.enabled,
          schedule: buildSchedule(form),
          action: buildAction(),
        },
        task.agent_id || ''
      )
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('task_save_error'))
    } finally {
      setSaving(false)
    }
  }

  const del = async () => {
    const ok = await askConfirm({ titleKey: 'task_delete', msgKey: 'task_delete_confirm', okKey: 'task_delete' })
    if (!ok) return
    setSaving(true)
    try {
      await apiClient.deleteTask(task.id, task.agent_id || '')
      onDeleted()
    } catch {
      setSaving(false)
    }
  }

  const runNow = async () => {
    const ok = await askConfirm({ titleKey: 'task_run_now', msgKey: 'task_run_confirm', okKey: 'task_run_now' })
    if (!ok) return
    setRunning(true)
    setRunStatus('')
    setError('')
    try {
      const result = await apiClient.runTask(task.id, task.agent_id || '')
      if (result.status !== 'success') throw new Error(result.message || t('task_run_error'))
      setRunStatus(t('task_run_started'))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('task_run_error'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      open
      size="lg"
      title={t('task_edit_title')}
      headerRight={<OwnerChip instance={isWeb ? null : picker.selectedInstance} fallbackAgentId={task.agent_id} />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="danger" onClick={del} disabled={saving} className="mr-auto">
            {t('task_delete')}
          </Btn>
          <Btn variant="ghost" onClick={runNow} disabled={saving || running}>
            {running ? <Loader2 size={14} className="inline animate-spin mr-1" /> : <Play size={14} className="inline mr-1" />}
            {t('task_run_now')}
          </Btn>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>
            {t('task_cancel')}
          </Btn>
          <Btn variant="primary" onClick={save} disabled={saving}>
            {t('task_save')}
          </Btn>
        </>
      }
    >
      <FormError message={error} />
      <TaskScheduleFields form={form} set={set} />

      {isWeb ? (
        <>
          {/* Web tasks target a chat session — task type is editable, but the
              channel/receiver are frozen (shown read-only). */}
          <div className="grid grid-cols-2 gap-4">
            <TaskTypeField form={form} set={set} />
            <Field label={t('task_channel')}>
              <TextInput value={task.action.channel_type || 'web'} disabled />
            </Field>
          </div>
          <Field label={t('task_receiver')}>
            <TextInput value={task.action.receiver_name || task.action.receiver || '--'} disabled />
          </Field>
          <p className="text-xs text-content-tertiary">{t('task_channel_locked')}</p>
        </>
      ) : (
        <>
          {/* IM task: task type + channel side by side, recipient below —
              switchable, exactly like create. */}
          <div className="grid grid-cols-2 gap-4">
            <TaskTypeField form={form} set={set} />
            <InstanceField picker={picker} />
          </div>
          <RecipientField picker={picker} />
        </>
      )}

      <TaskContentField form={form} set={set} />

      {runStatus && <p className="text-xs text-success">{runStatus}</p>}
    </Modal>
  )
}

export default TasksPage
