import { state, dbClient, logAudit } from './state.js';
import { notify, UI } from './ui.js';
import { downloadCsv } from './platform-utils.js';
import { LifecycleEngine, ResilientAI } from './analytics.js';

const actions = new Map();
export function registerAction(name, handler) { actions.set(name, handler); }

export function installEventDelegation() {
  document.body.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = actions.get(target.dataset.action);
    if (!action) return;
    event.preventDefault();
    action(target.dataset.id, target.dataset.value, event);
  });
}

export function notifyOverdueItems() {
  if (!state.globalData || !('Notification' in window) || document.hidden === false) return;
  const overdue = state.globalData.maint.filter(wo => wo.status !== 'COMPLETED' && wo.due_date && new Date(wo.due_date) < new Date());
  const expiring = state.globalData.warranties.filter(w => {
    const days = (new Date(w.expiry_date) - Date.now()) / 86400000;
    return days >= 0 && days <= 7;
  });
  if (overdue.length || expiring.length) new Notification('EquipIQ attention required', { body: `${overdue.length} overdue work order(s), ${expiring.length} warranty(ies) expiring within 7 days.` });
}

export async function requestNotifications() {
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
}

export function exportTable(name, collection) {
  const rows = state.globalData?.[collection] || [];
  downloadCsv(`equipiq-${name}-${new Date().toISOString().slice(0, 10)}`, rows);
  logAudit('CSV_EXPORT', `Exported ${collection} data`);
}

export async function explainCriticalTransition(asset, previousScore) {
  if (!asset || previousScore >= 40 || asset.health_score >= 40) return;
  const result = await ResilientAI.invoke(`Explain why ${asset.name} health changed from ${previousScore}% to ${asset.health_score}%. Use lifecycle reasons: ${(asset._lifecycle?.reasons || []).join(', ')}.`, { skipCache: true });
  asset._lifecycleExplanation = result.text;
}

export function applyTechnicianPolicy() {
  if (state.currentUser?.role !== 'technician') return;
  document.querySelectorAll('.financial-only,.admin-only').forEach(el => el.remove());
  state.globalData.maint = state.globalData.maint.filter(wo => wo.technician === state.currentUser.email || wo.technician === state.currentUser.id);
}

export function registerPlatformActions({ openEquipment, openWorkOrder, closeModal } = {}) {
  registerAction('edit-equipment', id => openEquipment?.(id));
  registerAction('edit-work-order', id => openWorkOrder?.(id));
  registerAction('close-modal', () => closeModal?.());
  registerAction('export-equipment', () => exportTable('equipment', 'equip'));
  registerAction('export-maintenance', () => exportTable('maintenance', 'maint'));
  registerAction('export-inventory', () => exportTable('inventory', 'inventory'));
}

export function mountPlatformFeatures() {
  installEventDelegation();
  requestNotifications();
  notifyOverdueItems();
  window.setInterval(notifyOverdueItems, 60 * 60 * 1000);
}
