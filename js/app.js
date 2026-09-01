import { state, initSupabase, dbClient, logAudit, handleError } from './state.js';
import { UI, notify, injectSkeleton } from './ui.js';
import { OfflineStore } from './offline.js';
import { LifecycleEngine, renderSustainabilityKPIs, getStandardEmbodiedCarbon, ResilientAI, agentTools, sanitizeAIResponse, openNewSustainabilityModal, loadComponentForTCO, fetchCurrentMarketPrice, calculateRvR, generateExecutiveReport, calculateWarrantyStatus } from './analytics.js';
import { 
  openRegisterEquipmentModal, openEditEquipmentModal, 
  openNewWorkOrderModal, openEditWorkOrderModal, 
  openNewWarrantyModal, openEditWarrantyModal, 
  openNewInventoryModal, openEditInventoryModal,
  deleteRecord, approveAgentTask, approveDeletion, approveUpdate, approveInsert
} from './crud.js';
import { processRealOCR, confirmOCR, openQRScanner, closeQRModal } from './ocr.js';

// Expose UI and Modals to global window for HTML onclick attributes
window.UI = UI;
window.notify = notify;
window.openRegisterEquipmentModal = openRegisterEquipmentModal;
window.openEditEquipmentModal = openEditEquipmentModal;
window.openNewWorkOrderModal = openNewWorkOrderModal;
window.openEditWorkOrderModal = openEditWorkOrderModal;
window.openNewWarrantyModal = openNewWarrantyModal;
window.openEditWarrantyModal = openEditWarrantyModal;
window.openNewInventoryModal = openNewInventoryModal;
window.openEditInventoryModal = openEditInventoryModal;
window.openNewSustainabilityModal = openNewSustainabilityModal;
window.deleteRecord = deleteRecord;
window.loadComponentForTCO = loadComponentForTCO;
window.fetchCurrentMarketPrice = fetchCurrentMarketPrice;
window.calculateRvR = calculateRvR;
window.generateExecutiveReport = generateExecutiveReport;
window.processRealOCR = processRealOCR;
window.confirmOCR = confirmOCR;
window.openQRScanner = openQRScanner;
window.closeQRModal = closeQRModal;
window.approveAgentTask = approveAgentTask;
window.approveDeletion = approveDeletion;
window.approveUpdate = approveUpdate;
window.approveInsert = approveInsert;

const titles = {
  dashboard: "Command Center", equipment: "Equipment Intelligence",
  maintenance: "Maintenance Operations", warranty: "Warranty Intelligence",
  documents: "Document Intelligence", analytics: "Lifecycle Analytics",
  decision: "Repair vs Replacement", sustainability: "Sustainability Intelligence",
  ai: "AI Intelligence", inventory: "Parts Intelligence", 
  audit: "System Audit Logs", settings: "System Configuration"
};

const DataLayer = {
  async fetchAllData() {
    const { data: equip, error: err1 } = await dbClient.from('equipment').select('*');
    if (err1) throw err1;
    const { data: maint, error: err2 } = await dbClient.from('maintenance_orders').select('*, equipment(name)').order('due_date', { ascending: true });
    if (err2) throw err2;
    const { data: warranties, error: err3 } = await dbClient.from('warranties').select('*, equipment(name)').order('expiry_date', { ascending: true });
    if (err3) throw err3;
    const { data: inventory, error: err4 } = await dbClient.from('parts_inventory').select('*, equipment(name)').order('name', { ascending: true });
    if (err4) throw err4;
    const { data: logs, error: err5 } = await dbClient.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(15);
    if (err5) throw err5;
    return { equip: equip || [], maint: maint || [], warranties: warranties || [], inventory: inventory || [], logs: logs || [] };
  }
};

async function checkSession() {
  if (!dbClient) return;
  try {
    const { data: { session } } = await dbClient.auth.getSession();
    if (session) await fetchUserProfile(session.user);
  } catch (e) {}
}

async function fetchUserProfile(authUser) {
  const { data: profile, error } = await dbClient
    .from('profiles').select('role, email').eq('id', authUser.id).single();
  if (error || !profile) return notify("Error fetching user profile.");
  state.currentUser = { id: authUser.id, email: profile.email, role: profile.role };
  enterApp();
}

function continueAsGuest() {
  state.currentUser = { id: null, email: 'guest@equipiq.com', role: 'viewer' };
  enterApp();
}

function enterApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('userAvatar').innerText = state.currentUser.email[0].toUpperCase();
  if (state.currentUser.role === 'viewer') document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  document.getElementById('settingsEmail').value = state.currentUser.email;
  document.getElementById('settingsRole').value = state.currentUser.role.toUpperCase();
  logAudit('USER_LOGIN', `${state.currentUser.email} logged in as ${state.currentUser.role}`);
  initializeAppData();
  initRealtimeSubscriptions();
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value;
  const pass = document.getElementById('loginPass').value;
  if (!email || !pass) return notify("Please enter credentials");
  notify("Authenticating...");
  const { data, error } = await dbClient.auth.signInWithPassword({ email, password: pass });
  if (error) notify("Authentication failed: " + error.message);
  else if (data.user) await fetchUserProfile(data.user);
}

async function handleLogout() {
  logAudit('USER_LOGOUT', `${state.currentUser.email} logged out`);
  if (state.currentUser.email !== 'guest@equipiq.com' && dbClient) await dbClient.auth.signOut();
  location.reload();
}

function initRealtimeSubscriptions() {
  if (!dbClient || window.__realtimeSubscribed) return;
  window.__realtimeSubscribed = true;
  dbClient.channel('schema-db-changes')
    .on('postgres_changes', { event: '*', schema: 'public' }, payload => {
      state.chartRenderStatus.dashboard = false;
      state.chartRenderStatus.analytics = false;
      initializeAppData(true); 
    })
    .subscribe();
}

const MaintenanceAnalytics = {
  calculateMTBF(installationDate, failureDates) {
    if (!failureDates || failureDates.length === 0) return 'N/A';
    const totalDays = (new Date() - new Date(installationDate)) / (1000 * 60 * 60 * 24);
    if (failureDates.length === 1) return totalDays.toFixed(1);
    const sorted = failureDates.map(d => new Date(d)).sort((a,b) => a - b);
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) totalGap += (sorted[i] - sorted[i-1]) / 86400000;
    return (totalGap / (sorted.length - 1)).toFixed(1);
  },
  calculateMTTR(repairTimesInHours) {
    if (!repairTimesInHours || repairTimesInHours.length === 0) return 0;
    const totalTime = repairTimesInHours.reduce((acc, curr) => acc + parseFloat(curr || 0), 0);
    return (totalTime / repairTimesInHours.length).toFixed(1);
  },
  renderDashboardStats() {
    if (!state.globalData) return;
    const compMaint = state.globalData.maint?.filter(m => m.status === 'COMPLETED') || [];
    const failures = state.globalData.maint?.filter(m => m.type === 'CORRECTIVE') || [];

    const mttr = this.calculateMTTR(compMaint.map(m => m.mttr_hours));
    document.getElementById('stat-mttr').textContent = mttr;

    if (failures.length > 0) {
      const earliest = new Date(Math.min(...failures.map(m => new Date(m.due_date || m.created_at).getTime())));
      const days = (Date.now() - earliest) / 86400000;
      const mtbf = failures.length === 1 ? days : days / failures.length;
      document.getElementById('stat-mtbf').textContent = mtbf > 0 ? mtbf.toFixed(1) : 'N/A';
    } else {
      document.getElementById('stat-mtbf').textContent = 'N/A';
    }

    const totalMaint = state.globalData.maint?.length || 0;
    const compliance = totalMaint > 0 ? ((compMaint.length / totalMaint) * 100).toFixed(1) : 0;
    document.getElementById('stat-compliance').textContent = compliance;
  }
};

function getMonthLabels() {
  const months = [];
  const today = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push(d.toLocaleString('default', { month: 'short' }).toUpperCase());
  }
  return months;
}

function renderDashboardCharts() {
  if (state.chartRenderStatus.dashboard || !state.globalData) return;
  const labels = getMonthLabels();
  const costData = new Array(6).fill(0);
  const today = new Date();
  state.globalData.maint.forEach(m => {
    const mDate = new Date(m.due_date);
    const diff = (today.getFullYear() - mDate.getFullYear()) * 12 + (today.getMonth() - mDate.getMonth());
    if (diff >= 0 && diff < 6 && m.status === 'COMPLETED') costData[5 - diff] += parseFloat(m.cost || 0);
  });
  const ctx = document.getElementById("costChart");
  if (ctx) {
    if (state.myCostChart) state.myCostChart.destroy();
    state.myCostChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ data: costData, borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.08)", borderWidth: 2, fill: true, tension: .45 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }
  state.chartRenderStatus.dashboard = true;
}

function renderAnalyticsCharts() {
  if (state.chartRenderStatus.analytics || !state.globalData) return;
  const labels = getMonthLabels();
  const failureData = new Array(6).fill(0);
  const complianceData = new Array(6).fill(0);
  const today = new Date();
  state.globalData.maint.forEach(m => {
    const mDate = new Date(m.due_date);
    const diff = (today.getFullYear() - mDate.getFullYear()) * 12 + (today.getMonth() - mDate.getMonth());
    if (diff >= 0 && diff < 6) {
      const idx = 5 - diff;
      if (m.type === 'CORRECTIVE') failureData[idx]++;
      if (m.status === 'COMPLETED') complianceData[idx]++;
    }
  });
  const fCtx = document.getElementById("failureChart");
  if (fCtx) {
    if (state.myFailureChart) state.myFailureChart.destroy();
    state.myFailureChart = new Chart(fCtx, {
      type: "bar",
      data: { labels, datasets: [{ data: failureData, backgroundColor: "rgba(124,58,237,.55)" }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }
  const cCtx = document.getElementById("complianceChart");
  if (cCtx) {
    if (state.myComplianceChart) state.myComplianceChart.destroy();
    state.myComplianceChart = new Chart(cCtx, {
      type: "line",
      data: { labels, datasets: [{ data: complianceData, borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,.05)", fill: true }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }
  state.chartRenderStatus.analytics = true;
}

function renderEsgChart() {
  if (!state.globalData) return;
  const ctx = document.getElementById('esgChart');
  if (!ctx) return;

  const labels = getMonthLabels();
  const esgData = new Array(6).fill(0);
  const today = new Date();

  state.globalData.maint.forEach(m => {
    if (m.status === 'COMPLETED' && m.type === 'CORRECTIVE') {
      const mDate = new Date(m.due_date);
      const diff = (today.getFullYear() - mDate.getFullYear()) * 12 + (today.getMonth() - mDate.getMonth());
      if (diff >= 0 && diff < 6) {
        const eq = state.globalData.equip.find(e => e.id === m.equipment_id);
        if (eq) {
          esgData[5 - diff] += getStandardEmbodiedCarbon(eq.name);
        }
      }
    }
  });

  if (window.myEsgChart) window.myEsgChart.destroy();
  window.myEsgChart = new Chart(ctx, {
    type: "bar",
    data: { 
      labels, 
      datasets: [{ 
        label: "CO2e Saved (kg)", 
        data: esgData, 
        backgroundColor: "rgba(34,197,94,.55)", 
        borderColor: "#22c55e",
        borderWidth: 1
      }] 
    },
    options: { 
      responsive: true, 
      maintainAspectRatio: false, 
      plugins: { legend: { display: false } } 
    }
  });
}

async function askAI() {
  const q = document.getElementById("aiInput").value.trim();
  if (!q) return;
  
  const responseDiv = document.getElementById("aiResponse");
  responseDiv.innerHTML = `<div class="skeleton" style="height:60px; margin-bottom:10px;"></div><div class="skeleton" style="height:20px; width:80%;"></div>`;
  
  try { logAudit('AI_QUERY', `Query: ${q}`); } catch (e) {}

  const aiResult = await ResilientAI.invoke(q);
  let displayText = aiResult.text;
  let isAIError = aiResult.source === 'fallback' || aiResult.source === 'offline';

  let approvalHTML = "";
  const lowerQ = q.toLowerCase();
  
  try {
    let eqMatch = null;
    if (state.globalData && state.globalData.equip) {
      eqMatch = state.globalData.equip.find(e => lowerQ.includes(e.name.toLowerCase()) || (e.asset_tag && lowerQ.includes(e.asset_tag.toLowerCase())));
    }
    
    const closeKeywords = ["close", "complete", "finish"];
    const woMatch = state.globalData.maint.find(m => lowerQ.includes(m.work_order_number?.toLowerCase()));
    if (woMatch && closeKeywords.some(kw => lowerQ.includes(kw))) {
      const closeData = JSON.parse(agentTools.closeWorkOrder(woMatch.work_order_number));
      if (closeData.update_payload) {
        displayText = `I have identified a request to close Work Order ${woMatch.work_order_number}. This action requires explicit admin authorization.`;
        approvalHTML = `
          <div class="approval-box" style="border-color: var(--green); background: rgba(34,197,94,0.05);">
            <strong>⏸ PENDING ADMIN APPROVAL (CLOSE WO)</strong><br>
            <div class="approval-meta"><strong>WO:</strong> ${woMatch.work_order_number}</div>
            <button class="btn btn-primary" style="margin-top:10px; width:100%; background: var(--green);" onclick='window.approveUpdate(${JSON.stringify(closeData.update_payload)})'>Authorize & Close Work Order</button>
          </div>`;
      }
    } 
    else if (lowerQ.includes("add") && lowerQ.includes("part")) {
      const partName = q.replace(/.*add part (for|named|called)?\s*/i, '').replace(/.*add\s*/i, '').trim() || "New AI Part";
      const qtyMatch = q.match(/\d+/);
      const qty = qtyMatch ? qtyMatch[0] : 1;
      const invData = JSON.parse(agentTools.createInventoryPart(partName, qty));
      if (invData.insert_payload) {
        displayText = `I have prepared the inventory payload for '${partName}'. This action requires explicit admin authorization.`;
        approvalHTML = `
          <div class="approval-box">
            <strong>⏸ PENDING ADMIN APPROVAL (ADD PART)</strong><br>
            <div class="approval-meta"><strong>Part:</strong> ${partName} | <strong>Qty:</strong> ${qty}</div>
            <button class="btn btn-primary" style="margin-top:10px; width:100%;" onclick='window.approveInsert(${JSON.stringify(invData.insert_payload)})'>Authorize & Add Part</button>
          </div>`;
      }
    }
    else {
      const deleteKeywords = ["delete", "remove", "dispose", "scrap"];
      if (eqMatch && deleteKeywords.some(kw => lowerQ.includes(kw))) {
        const delData = JSON.parse(agentTools.deleteEquipment(eqMatch.name));
        if (delData.delete_payload) {
          displayText = `I have identified a request to delete ${eqMatch.name}. This destructive action requires explicit admin authorization.`;
          approvalHTML = `
            <div class="approval-box" style="border-color: var(--red); background: rgba(239,68,68,0.05);">
              <strong>⏸ PENDING ADMIN APPROVAL (DELETION)</strong><br>
              <div class="approval-meta"><strong>Asset:</strong> ${delData.delete_payload.name}</div>
              <button class="btn btn-primary" style="margin-top:10px; width:100%; background: var(--red);" onclick='window.approveDeletion(${JSON.stringify(delData.delete_payload)})'>Authorize & Delete Equipment</button>
            </div>`;
        }
      } 
      else if (eqMatch && lowerQ.includes("health")) {
        const healthMatch = q.match(/\d+/);
        const newHealth = healthMatch ? healthMatch[0] : 50;
        const updateData = JSON.parse(agentTools.updateEquipmentHealth(eqMatch.name, newHealth));
        if (updateData.update_payload) {
          displayText = `I have prepared a health update for ${eqMatch.name} to ${newHealth}%. This action requires explicit admin authorization.`;
          approvalHTML = `
            <div class="approval-box" style="border-color: var(--orange); background: rgba(245,158,11,0.05);">
              <strong>⏸ PENDING ADMIN APPROVAL (UPDATE)</strong><br>
              <div class="approval-meta"><strong>Asset:</strong> ${eqMatch.name} | <strong>New Health:</strong> ${newHealth}%</div>
              <button class="btn btn-primary" style="margin-top:10px; width:100%; background: var(--orange);" onclick='window.approveUpdate(${JSON.stringify(updateData.update_payload)})'>Authorize & Update Health</button>
            </div>`;
        }
      }
      else if (eqMatch) {
        const maintKeywords = ["prepare", "create", "schedule", "fix", "repair", "maintain"];
        if (maintKeywords.some(kw => lowerQ.includes(kw))) {
          const taskData = JSON.parse(agentTools.prepareMaintenanceTask(eqMatch.name));
          if (taskData.task) {
            approvalHTML = `
              <div class="approval-box">
                <strong>⏸ PENDING ADMIN APPROVAL</strong><br>
                <div class="approval-meta">
                  <strong>WO:</strong> ${taskData.task.work_order_number} | 
                  <strong>Type:</strong> ${taskData.task.type} | 
                  <strong>Due:</strong> ${taskData.task.due_date}
                </div>
                <button class="btn btn-primary" style="margin-top:10px; width:100%;" onclick='window.approveAgentTask(${JSON.stringify(taskData.task)})'>Authorize & Commit Work Order</button>
              </div>`;
          }
        }
      }
    }
  } catch (toolErr) {
    console.error("[Agent] Tool processing failed:", toolErr);
  }

  const sourceLabel = {
    'edge':    '🟢 Live AI',
    'cache':   '🔵 Cached Response',
    'offline': '🟠 Offline Mode',
    'fallback':'🟠 Fallback Heuristic'
  }[aiResult.source] || 'AI';

  const textHtml = isAIError 
    ? `<p style="color:var(--orange); line-height:1.6;">${displayText}</p>`
    : `<p style="color:#cbd5e1; line-height:1.6;">${displayText}</p>`;

  responseDiv.innerHTML = `
    <h4 style="color:var(--violet); margin-bottom:10px;">✦ Agent Intelligence Response <span style="font-size:9px; color:var(--muted); margin-left:8px;">${sourceLabel}</span></h4>
    <div class="agent-trace"><strong>Mode:</strong> Human-in-the-loop Sandboxed Execution<br><strong>Security Context:</strong> Least-Privilege Active</div>
    ${textHtml}
    ${approvalHTML}
  `;
}

async function updatePendingSyncBadge() {
  const count = await OfflineStore.countPendingMutations();
  const badge = document.getElementById('pending-sync-badge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.style.display = 'flex'; } else { badge.style.display = 'none'; }
  }
}

async function initializeAppData(silent = false) {
  if (!dbClient) return notify("Database connection unavailable.");

  if (!silent) {
    injectSkeleton('dashStats', 4);
    injectSkeleton('equipGrid', 4);
    injectSkeleton('maintTable', 3);
  }

  let data = null;
  let dataSource = 'network';

  try {
    if (navigator.onLine) {
      data = await DataLayer.fetchAllData();
      if (!data) throw new Error("Empty response");
      await OfflineStore.saveAppState(data);
    } else {
      throw new Error('Offline');
    }
  } catch (error) {
    dataSource = 'offline-cache';
    data = await OfflineStore.loadAppState();
    if (!silent) notify(`Offline mode: showing last saved data (${data ? 'cached' : 'none'})`, 'warning', 5000);
    if (!data) { if (navigator.onLine) handleError("Data Render", error); return; }
  }

  try {
    state.globalData = data;
    if (dataSource === 'network') state.globalData._savedAt = Date.now();

    const lifecycleResult = await LifecycleEngine.autoUpdateAll(dataSource === 'offline-cache');
    if (lifecycleResult.updated > 0 && !silent) {
      notify(`🔄 Lifecycle health auto-adjusted for ${lifecycleResult.updated} asset(s) based on MTTR/MTBF analytics`, 'info', 4000);
    }

    const totalEquip = data.equip.length;
    const operational = data.equip.filter(e => e.status === 'OPERATIONAL').length;
    const openMaint = data.maint.filter(m => m.status !== 'COMPLETED').length;
    const urgent = data.equip.filter(e => e.health_score < 50).length;

    document.getElementById('dashStats').innerHTML = `
      <div class="stat"><div class="stat-top"><div class="stat-icon">◈</div><div class="stat-change">System Active</div></div><div class="stat-value">${totalEquip}</div><div class="stat-label">TOTAL EQUIPMENT</div></div>
      <div class="stat"><div class="stat-top"><div class="stat-icon">✓</div><div class="stat-change">Healthy</div></div><div class="stat-value">${operational}</div><div class="stat-label">OPERATIONAL ASSETS</div></div>
      <div class="stat"><div class="stat-top"><div class="stat-icon">⌁</div><div class="stat-change">In Progress</div></div><div class="stat-value">${openMaint}</div><div class="stat-label">MAINTENANCE TASKS</div></div>
      <div class="stat"><div class="stat-top"><div class="stat-icon">!</div><div class="stat-change" style="color:#f87171">${urgent} URGENT</div></div><div class="stat-value">${urgent}</div><div class="stat-label">ATTENTION REQUIRED</div></div>
    `;

    const expWarr = data.warranties.filter(w => w.status === 'EXPIRING SOON').length;
    document.getElementById('dashAI1').innerHTML = `<h4>⚠ Recurring patterns detected</h4><p>${urgent} asset(s) fall below 50% lifecycle health score. Recommended for preventive inspection.</p>`;
    document.getElementById('dashAI2').innerHTML = `<h4>◉ Lifecycle opportunity</h4><p>${expWarr} warranties expiring within 30 days. Review claim feasibility prior to expiration.</p>`;

    const sortedEquip = [...data.equip].sort((a, b) => a.health_score - b.health_score).slice(0, 3);
    document.getElementById('dashCriticalTable').innerHTML = sortedEquip.map(eq => `
      <tr class="clickable-row" onclick="window.openEditEquipmentModal('${eq.id}')">
        <td><div class="equipment"><div class="equip-icon">◈</div><div><strong>${eq.name}</strong><div class="sub-text">${eq.asset_tag || 'N/A'} · ${eq.model || 'N/A'}</div></div></div></td>
        <td><span class="badge ${eq.health_score > 70 ? 'green' : eq.health_score > 40 ? 'orange' : 'red'}">${eq.health_score}% HEALTH</span></td>
        <td><span class="badge ${eq.status === 'OPERATIONAL' ? 'green' : eq.status === 'MAINTENANCE' ? 'orange' : 'red'}">${eq.status}</span></td>
      </tr>
    `).join('');

    document.getElementById('equipGrid').innerHTML = data.equip.map(eq => `
      <div class="asset clickable-card" onclick="window.openEditEquipmentModal('${eq.id}')">
        <div class="asset-head"><div class="asset-symbol">◈</div><span class="badge ${eq.status === 'OPERATIONAL' ? 'green' : eq.status === 'MAINTENANCE' ? 'orange' : 'red'}">${eq.status}</span></div>
        <h3>${eq.name}</h3><p>${eq.asset_tag || 'NO TAG'}<br>${eq.category || 'N/A'} · ${eq.model || 'N/A'}<br>${eq.serial_number || 'N/A'}</p>
        <div class="health-label"><span>LIFECYCLE HEALTH</span><strong>${eq.health_score}%</strong></div>
        <div class="progress"><span style="width:${eq.health_score}%; background:${eq.health_score < 50 ? 'linear-gradient(90deg,#ef4444,#f97316)' : 'linear-gradient(90deg,#3b82f6,#22d3ee)'}"></span></div>
        ${eq._lifecycle ? `<div class="lifecycle-meta" style="margin-top:8px; font-size:9px; color:var(--muted); line-height:1.4;">MTBF: ${eq._lifecycle.mtbf ? eq._lifecycle.mtbf.toFixed(0) + 'd' : '—'} · MTTR: ${eq._lifecycle.mttr ? eq._lifecycle.mttr.toFixed(1) + 'h' : '—'} · Failures: ${eq._lifecycle.total_failures}</div>` : ''}
      </div>
    `).join('');

    const compMaint = data.maint.filter(m => m.status === 'COMPLETED');
    const avgMTTR = compMaint.length > 0 ? (compMaint.reduce((s, m) => s + parseFloat(m.mttr_hours || 0), 0) / compMaint.length).toFixed(1) : 0;
    const totalMaintCost = data.maint.reduce((s, m) => s + parseFloat(m.cost || 0), 0);
    document.getElementById('maintStats').innerHTML = `
      <div class="stat"><div class="stat-value">${openMaint}</div><div class="stat-label">OPEN WORK ORDERS</div></div>
      <div class="stat"><div class="stat-value">${compMaint.length}</div><div class="stat-label">COMPLETED TASKS</div></div>
      <div class="stat"><div class="stat-value">${avgMTTR}h</div><div class="stat-label">AVERAGE MTTR</div></div>
      <div class="stat"><div class="stat-value">Rs.${(totalMaintCost/1000).toFixed(1)}K</div><div class="stat-label">TOTAL MAINT COST</div></div>
    `;
    
    // OVERDUE FLAG LOGIC
    document.getElementById('maintTable').innerHTML = data.maint.map(m => {
      const isOverdue = m.status !== 'COMPLETED' && m.due_date && (() => {
        const d = new Date(m.due_date);
        if (!isNaN(d)) d.setHours(23, 59, 59);
        return d < new Date();
      })();
      return `
      <tr class="clickable-row" onclick="window.openEditWorkOrderModal('${m.id}')">
        <td>${m.work_order_number || 'WO-SYS'}</td>
        <td>${m.equipment ? m.equipment.name : 'Unknown Asset'}</td>
        <td><span class="badge ${m.type === 'PREVENTIVE' ? 'blue' : 'red'}">${m.type}</span></td>
        <td>${m.technician || 'Unassigned'}</td>
        <td>Rs. ${(m.cost || 0).toLocaleString()}</td>
        <td>
          <span class="badge ${m.status === 'PENDING' ? 'orange' : m.status === 'IN PROGRESS' ? 'blue' : 'green'}">${m.status}</span>
          ${isOverdue ? '<span class="badge red" style="margin-left:5px;">OVERDUE</span>' : ''}
        </td>
      </tr>`;
    }).join('');
    
    const warrStatuses = data.warranties.map(w => calculateWarrantyStatus(w.expiry_date));
    const aW = warrStatuses.filter(s => s === 'ACTIVE').length;
    const eW = warrStatuses.filter(s => s === 'EXPIRING SOON').length;
    const xW = warrStatuses.filter(s => s === 'EXPIRED').length;
    const cV = data.warranties.reduce((s, w) => s + parseFloat(w.claim_value || 0), 0);
    
    document.getElementById('warrStats').innerHTML = `
      <div class="stat"><div class="stat-value">${aW}</div><div class="stat-label">ACTIVE WARRANTIES</div></div>
      <div class="stat"><div class="stat-value">${eW}</div><div class="stat-label">EXPIRING SOON</div></div>
      <div class="stat"><div class="stat-value">${xW}</div><div class="stat-label">EXPIRED</div></div>
      <div class="stat"><div class="stat-value">Rs.${(cV/1000).toFixed(0)}K</div><div class="stat-label">POTENTIAL CLAIM VALUE</div></div>
    `;
    
    document.getElementById('warrTable').innerHTML = data.warranties.map(w => {
      const status = calculateWarrantyStatus(w.expiry_date); // DYNAMIC STATUS
      return `
      <tr class="clickable-row" onclick="window.openEditWarrantyModal('${w.id}')">
        <td>${w.equipment ? w.equipment.name : 'Unknown Asset'}</td>
        <td>${w.supplier || 'N/A'}</td>
        <td>${w.start_date ? new Date(w.start_date).toLocaleDateString() : 'N/A'}</td>
        <td>${w.expiry_date ? new Date(w.expiry_date).toLocaleDateString() : 'N/A'}</td>
        <td><span class="badge ${status === 'ACTIVE' ? 'green' : status === 'EXPIRING SOON' ? 'orange' : 'red'}">${status}</span></td>
      </tr>`;
    }).join('');


    const tP = data.inventory.reduce((s, i) => s + (i.stock_quantity || 0), 0);
    const lS = data.inventory.filter(i => i.status === 'LOW STOCK').length;
    const oS = data.inventory.filter(i => i.status === 'OUT OF STOCK').length;
    document.getElementById('invStats').innerHTML = `
      <div class="stat"><div class="stat-value">${tP}</div><div class="stat-label">TOTAL PARTS</div></div>
      <div class="stat"><div class="stat-value">${data.inventory.length}</div><div class="stat-label">UNIQUE SKUS</div></div>
      <div class="stat"><div class="stat-value">${lS}</div><div class="stat-label">LOW STOCK</div></div>
      <div class="stat"><div class="stat-value">${oS}</div><div class="stat-label">OUT OF STOCK</div></div>
    `;
    document.getElementById('invTable').innerHTML = data.inventory.map(i => `
      <tr class="clickable-row" onclick="window.openEditInventoryModal('${i.id}')">
        <td>${i.name}</td>
        <td>${i.part_number || 'N/A'}</td>
        <td>${i.equipment ? i.equipment.name : 'Generic'}</td>
        <td>${i.stock_quantity}</td>
        <td>Rs. ${(i.unit_cost || 0).toLocaleString()}</td>
        <td><span class="badge ${i.status === 'AVAILABLE' ? 'green' : i.status === 'LOW STOCK' ? 'orange' : 'red'}">${i.status}</span></td>
      </tr>
    `).join('');

    if (data.logs) {
      document.getElementById('auditLogList').innerHTML = data.logs.map(l => `
        <div class="audit-item"><strong>${l.action}</strong> - ${l.details}<br>
        <span class="audit-meta">${l.user_email || 'System'} at ${new Date(l.created_at).toLocaleString()}</span></div>
      `).join('');
    }

    const tcoSelect = document.getElementById('tco-equipment-select');
    if (tcoSelect) tcoSelect.innerHTML = '<option value="">Select Equipment...</option>' + data.equip.map(e => `<option value="${e.id}">${e.name} (${e.asset_tag || 'No Tag'})</option>`).join('');

    MaintenanceAnalytics.renderDashboardStats();
    updatePendingSyncBadge();

    try {
      const divertedAssets = data.maint.filter(m => m.status === 'COMPLETED' && m.type === 'CORRECTIVE').length;
      const eWasteDiverted = divertedAssets * 50; 
      let carbonSaved = 0, energySaved = 0;
      data.maint.filter(m => m.status === 'COMPLETED' && m.type === 'CORRECTIVE').forEach(m => {
        const eq = data.equip.find(e => e.id === m.equipment_id);
        if (eq) {
          carbonSaved += getStandardEmbodiedCarbon(eq.name);
          energySaved += getStandardEmbodiedCarbon(eq.name) * 0.1; 
        }
      });
      const elCarbon = document.getElementById('esg-carbon-saved');
      const elEwaste = document.getElementById('esg-ewaste');
      const elEnergy = document.getElementById('esg-energy-saved');
      if (elCarbon) elCarbon.innerText = carbonSaved.toLocaleString() + ' kg';
      if (elEwaste) elEwaste.innerText = eWasteDiverted.toLocaleString() + ' kg';
      if (elEnergy) elEnergy.innerText = energySaved.toLocaleString() + ' kWh';
    } catch (e) {}

    renderSustainabilityKPIs();
    
    if (silent) {
      state.chartRenderStatus.dashboard = false;
      state.chartRenderStatus.analytics = false;
      const activePage = document.querySelector('.page.active')?.id;
      if (activePage === 'dashboard') renderDashboardCharts();
      if (activePage === 'analytics') { MaintenanceAnalytics.renderDashboardStats(); renderAnalyticsCharts(); renderEsgChart(); }
    } else {
      renderDashboardCharts();
      renderEsgChart();
    }
  } catch (error) {
    if (navigator.onLine) handleError("Data Render", error);
  }
}
window.initializeAppData = initializeAppData;
window.askAI = askAI;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.continueAsGuest = continueAsGuest;
window.toggleSidebar = () => { document.getElementById("sidebar").classList.toggle("open"); document.getElementById("sidebarOverlay").classList.toggle("show"); };
window.toggleFullscreen = () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); };
window.navigate = (page) => UI.navigate(page);

// --- Bootstrap ---
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  UI.initListeners();
  checkSession();

  const commitBtn = document.getElementById('commit-ocr-data');
  if (commitBtn) {
    commitBtn.addEventListener('click', () => {
      UI.closeModal();
      UI.toast('Document committed as trusted database record.', 'success');
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('PWA Service Worker Registered', reg.scope);
        if (navigator.onLine) setInterval(() => reg.update().catch(()=>{}), 60 * 60 * 1000);
      })
      .catch(err => console.warn('SW registration skipped:', err));
      
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SYNC_COMPLETE') {
        const msg = event.data.flushed > 0 ? `✓ Synced ${event.data.flushed} offline change(s)` : 'Sync complete';
        notify(msg, 'success', 3000);
        updatePendingSyncBadge();
        initializeAppData(true);
      }
      if (event.data?.type === 'SYNC_CONFLICT') {
        notify(`⚠️ Sync conflict detected. Reverting local changes to prevent data loss.`, 'warning', 6000);
        updatePendingSyncBadge();
        initializeAppData(true); 
      }
      if (event.data?.type === 'SW_UPDATED') {
        notify('App updated to latest version', 'success', 3000);
      }
    });
  }

  window.addEventListener('online', () => {
    const status = document.getElementById('connection-status');
    if (status) {
      status.innerHTML = `<span class="live-dot" style="width:6px; height:6px;"></span> ONLINE`;
      status.className = "badge green";
    }
    notify('Connection restored. Syncing offline changes...', 'info', 4000);

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => {
        if ('sync' in reg) {
          reg.sync.register('sync-equipment-mutations').catch(err => console.log('Sync registration failed:', err));
        } else {
          navigator.serviceWorker.controller.postMessage('FLUSH_QUEUE');
        }
      });
    }
    setTimeout(() => initializeAppData(true), 1500);
  });

  window.addEventListener('offline', () => {
    const status = document.getElementById('connection-status');
    if (status) {
      status.innerHTML = `<span class="live-dot" style="width:6px; height:6px; background:var(--orange); box-shadow:0 0 10px var(--orange);"></span> OFFLINE`;
      status.className = "badge orange";
    }
    notify('Network connection lost. Offline mode active — all changes will be synced when you reconnect.', 'warning', 5000);
  });

  window.addEventListener('focus', () => {
    if (state.globalData && navigator.onLine) {
      LifecycleEngine.autoUpdateAll().then(r => {
        if (r.updated > 0) {
          notify(`🔄 Health auto-adjusted for ${r.updated} asset(s)`, 'info', 3000);
          updatePendingSyncBadge();
        }
      });
    }
  });

  const navs = document.querySelectorAll(".nav");
  navs.forEach(nav => {
    nav.addEventListener("click", () => {
      const page = nav.dataset.page;
      if (!page) return;
      navs.forEach(n => n.classList.remove("active"));
      nav.classList.add("active");
      document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
      document.getElementById(page).classList.add("active");
      document.getElementById("pageTitle").textContent = titles[page] || "EquipIQ";
      document.getElementById("sidebar").classList.remove("open");
      document.getElementById("sidebarOverlay").classList.remove("show");
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (page === 'dashboard') renderDashboardCharts();
      if (page === 'analytics') { MaintenanceAnalytics.renderDashboardStats(); renderAnalyticsCharts(); renderEsgChart(); }
      if (page === 'sustainability') renderSustainabilityKPIs();
    });
  });
  
  // Chart.js Global Defaults
  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = "'Outfit', sans-serif";
    Chart.defaults.font.size = 10;
    Chart.defaults.color = "#7d879b";
  }
});