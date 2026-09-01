import { state, dbClient, logAudit, handleError } from './state.js';
import { UI, notify } from './ui.js';
import { calculateWarrantyStatus } from './analytics.js';

// --- Auto ID Generators ---
export function generateAssetTag() {
  return `EQ-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
}

export function generateWONumber() {
  const year = new Date().getFullYear();
  return `WO-${year}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

export async function deleteRecord(table, id) {
  if (!confirm("Are you sure you want to delete this record?")) return;
  notify("Deleting record...");
  const { error } = await dbClient.from(table).delete().eq('id', id);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine && state.globalData) {
    if (table === 'equipment') state.globalData.equip = state.globalData.equip.filter(e => e.id !== id);
    if (table === 'maintenance_orders') state.globalData.maint = state.globalData.maint.filter(e => e.id !== id);
    if (table === 'warranties') state.globalData.warranties = state.globalData.warranties.filter(e => e.id !== id);
    if (table === 'parts_inventory') state.globalData.inventory = state.globalData.inventory.filter(e => e.id !== id);
  }

  logAudit('RECORD_DELETE', `Deleted from ${table} (ID: ${id})`);
  notify("Record deleted successfully.");
  UI.closeModal();
  await window.initializeAppData(true);
}

// --- Equipment CRUD ---
export function openRegisterEquipmentModal() {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  UI.openModal("Register New Asset", `
    <div class="modal-input-group"><label class="modal-label">Asset Name *</label><input type="text" id="reg_eq_name" class="modal-input" placeholder="e.g. CNC Milling Unit"></div>
    <div class="modal-input-group"><label class="modal-label">Category</label><input type="text" id="reg_eq_category" class="modal-input" placeholder="e.g. Motor, Pump, CNC"></div>
    <div class="modal-input-group"><label class="modal-label">Model</label><input type="text" id="reg_eq_model" class="modal-input" placeholder="Model Series X"></div>
    <div class="modal-input-group"><label class="modal-label">Serial Number</label><input type="text" id="reg_eq_serial" class="modal-input" placeholder="SN-882"></div>
    <div class="modal-input-group"><label class="modal-label">Status</label><select id="reg_eq_status" class="modal-input"><option value="OPERATIONAL">OPERATIONAL</option><option value="MAINTENANCE">MAINTENANCE</option><option value="CRITICAL">CRITICAL</option></select></div>
    <div class="modal-input-group"><label class="modal-label">Purchase Price (Rs)</label><input type="number" id="reg_eq_price" class="modal-input" value="0"></div>
    <div class="modal-input-group"><label class="modal-label">Purchase Date</label><input type="date" id="reg_eq_date" class="modal-input"></div>
    
    <h4 style="font-family:'Sora',sans-serif; margin:15px 0 10px; font-size:12px;">ESG Data</h4>
    <div class="modal-input-group"><label class="modal-label">Annual Emissions (kg CO2e)</label><input type="number" id="reg_eq_emissions" class="modal-input" value="0"></div>
    <div class="modal-input-group"><label class="modal-label">Annual Waste (kg)</label><input type="number" id="reg_eq_waste" class="modal-input" value="0"></div>
    
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.createEquipment()">Save Asset</button></div>
  `);
  window.createEquipment = createEquipment;
}

async function createEquipment() {
  const payload = {
    name: document.getElementById('reg_eq_name').value,
    asset_tag: generateAssetTag(), 
    category: document.getElementById('reg_eq_category').value,
    model: document.getElementById('reg_eq_model').value,
    serial_number: document.getElementById('reg_eq_serial').value,
    status: document.getElementById('reg_eq_status').value,
    health_score: 100,
    purchase_price: parseFloat(document.getElementById('reg_eq_price').value) || 0,
    purchase_date: document.getElementById('reg_eq_date').value || null,
    annual_emissions: parseFloat(document.getElementById('reg_eq_emissions').value) || 0,
    annual_waste: parseFloat(document.getElementById('reg_eq_waste').value) || 0
  };
  if (!payload.name) return notify("Asset Name is required.");
  const { error } = await dbClient.from('equipment').insert([payload]);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine) {
    payload.id = 'temp-' + Date.now();
    if (!state.globalData) state.globalData = { equip: [], maint: [], warranties: [], inventory: [], logs: [] };
    state.globalData.equip.push(payload);
  }

  logAudit('EQUIPMENT_CREATE', `Created asset: ${payload.name}`);
  notify("Equipment registered successfully.");
  UI.closeModal();
  await window.initializeAppData(true);
}

export function openEditEquipmentModal(id) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const eq = state.globalData.equip.find(e => e.id === id);
  if (!eq) return;
  UI.openModal("Edit Equipment", `
    <div class="modal-input-group"><label class="modal-label">Name *</label><input type="text" id="edit_eq_name" class="modal-input" value="${eq.name}"></div>
    <div class="modal-input-group"><label class="modal-label">Asset Tag</label><input type="text" class="modal-input" value="${eq.asset_tag || ''}" disabled></div>
    <div class="modal-input-group"><label class="modal-label">Category</label><input type="text" id="edit_eq_category" class="modal-input" value="${eq.category || ''}"></div>
    <div class="modal-input-group"><label class="modal-label">Serial Number</label><input type="text" id="edit_eq_serial" class="modal-input" value="${eq.serial_number || ''}"></div>
    <div class="modal-input-group"><label class="modal-label">Status</label><select id="edit_eq_status" class="modal-input"><option value="OPERATIONAL" ${eq.status==='OPERATIONAL'?'selected':''}>OPERATIONAL</option><option value="MAINTENANCE" ${eq.status==='MAINTENANCE'?'selected':''}>MAINTENANCE</option><option value="CRITICAL" ${eq.status==='CRITICAL'?'selected':''}>CRITICAL</option></select></div>
    <div class="modal-input-group"><label class="modal-label">Health Score (0-100)</label><input type="number" id="edit_eq_health" class="modal-input" value="${eq.health_score}"></div>
    <div class="modal-input-group"><label class="modal-label">Purchase Price (Rs)</label><input type="number" id="edit_eq_price" class="modal-input" value="${eq.purchase_price || 0}"></div>
    <div class="modal-input-group"><label class="modal-label">Purchase Date</label><input type="date" id="edit_eq_date" class="modal-input" value="${eq.purchase_date || ''}"></div>
    
    <h4 style="font-family:'Sora',sans-serif; margin:15px 0 10px; font-size:12px;">ESG Data</h4>
    <div class="modal-input-group"><label class="modal-label">Annual Emissions (kg CO2e)</label><input type="number" id="edit_eq_emissions" class="modal-input" value="${eq.annual_emissions || 0}"></div>
    <div class="modal-input-group"><label class="modal-label">Annual Waste (kg)</label><input type="number" id="edit_eq_waste" class="modal-input" value="${eq.annual_waste || 0}"></div>
    
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.updateEquipment('${id}')">Save Changes</button><button class="btn btn-ghost" style="border-color:var(--red); color:var(--red);" onclick="window.deleteRecord('equipment', '${id}')">Delete</button></div>
  `);
  window.updateEquipment = updateEquipment;
}

async function updateEquipment(id) {
  const payload = {
    name: document.getElementById('edit_eq_name').value,
    category: document.getElementById('edit_eq_category').value,
    serial_number: document.getElementById('edit_eq_serial').value,
    status: document.getElementById('edit_eq_status').value,
    health_score: parseInt(document.getElementById('edit_eq_health').value),
    purchase_price: parseFloat(document.getElementById('edit_eq_price').value) || 0,
    purchase_date: document.getElementById('edit_eq_date').value || null,
    annual_emissions: parseFloat(document.getElementById('edit_eq_emissions').value) || 0,
    annual_waste: parseFloat(document.getElementById('edit_eq_waste').value) || 0
  };
  const { error } = await dbClient.from('equipment').update(payload).eq('id', id);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine && state.globalData) {
    const idx = state.globalData.equip.findIndex(e => e.id === id);
    if (idx !== -1) Object.assign(state.globalData.equip[idx], payload);
  }

  logAudit('EQUIPMENT_UPDATE', `Updated asset ID: ${id}`);
  notify("Equipment updated.");
  UI.closeModal();
  await window.initializeAppData(true);
}

// --- Work Order CRUD ---
export function openNewWorkOrderModal() {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const options = state.globalData ? state.globalData.equip.map(e => `<option value="${e.id}">${e.name}</option>`).join('') : '';
  const partsOptions = state.globalData ? state.globalData.inventory.map(p => `<option value="${p.id}">${p.name} (Stock: ${p.stock_quantity} | Rs.${p.unit_cost})</option>`).join('') : '';
  
  UI.openModal("Create Work Order", `
    <div class="modal-input-group"><label class="modal-label">Equipment</label><select id="wo_eq_id" class="modal-input">${options}</select></div>
    <div class="modal-input-group"><label class="modal-label">WO Number</label><input type="text" class="modal-input" value="${generateWONumber()}" readonly></div>
    <div class="modal-input-group"><label class="modal-label">Type</label><select id="wo_type" class="modal-input"><option value="PREVENTIVE">PREVENTIVE</option><option value="CORRECTIVE">CORRECTIVE</option></select></div>
    <div class="modal-input-group"><label class="modal-label">Technician</label><input type="text" id="wo_tech" class="modal-input" placeholder="Assignee name"></div>
    <div class="modal-input-group"><label class="modal-label">Due Date</label><input type="date" id="wo_due" class="modal-input"></div>
    <div class="modal-input-group"><label class="modal-label">Failure Reason (if Corrective)</label><input type="text" id="wo_failure_reason" class="modal-input" placeholder="e.g. Bearing failure"></div>
    
    <h4 style="font-family:'Sora',sans-serif; margin:15px 0 10px; font-size:12px;">Parts & Costing</h4>
    <div style="display:flex; gap:10px; align-items:end; margin-bottom:10px;">
      <div class="modal-input-group" style="flex:2; margin:0;">
        <label class="modal-label">Select Part</label>
        <select id="wo_part_select" class="modal-input"><option value="">Select Part...</option>${partsOptions}</select>
      </div>
      <div class="modal-input-group" style="flex:1; margin:0;">
        <label class="modal-label">Qty</label>
        <input type="number" id="wo_part_qty" class="modal-input" value="1" min="1">
      </div>
      <button class="btn btn-primary" onclick="window.addPartToWorkOrder()">Add</button>
    </div>
    <table class="table" style="font-size:10px; margin-bottom:10px;">
      <thead><tr><th>PART</th><th>QTY</th><th>UNIT</th><th>TOTAL</th><th></th></tr></thead>
      <tbody id="wo_parts_table"></tbody>
    </table>
    
    <div class="modal-input-group"><label class="modal-label">Labor Cost (Rs)</label><input type="number" id="wo_labor_cost" class="modal-input" value="0" oninput="window.calculateWorkOrderCost()"></div>
    <div class="cost-row"><span>Parts Cost</span><strong id="wo_parts_cost">Rs. 0.00</strong></div>
    <div class="cost-row" style="border-bottom:none; font-size:13px;"><strong>Total Cost</strong><strong id="wo_total_cost">Rs. 0.00</strong></div>
    
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.createWorkOrder()">Submit Work Order</button></div>
  `);
  
  state.woPartsUsed = [];
  window.addPartToWorkOrder = addPartToWorkOrder;
  window.renderWorkOrderParts = renderWorkOrderParts;
  window.calculateWorkOrderCost = calculateWorkOrderCost;
  window.createWorkOrder = createWorkOrder;
  
  renderWorkOrderParts();
  calculateWorkOrderCost();
}

function addPartToWorkOrder() {
  const partId = document.getElementById('wo_part_select').value;
  const part = state.globalData.inventory.find(p => p.id === partId);
  if (!part) return notify("Select a part first.");
  const qty = parseInt(document.getElementById('wo_part_qty').value) || 1;
  
  const existing = state.woPartsUsed.find(p => p.part_id === partId);
  if (existing) existing.qty += qty;
  else state.woPartsUsed.push({ part_id: part.id, name: part.name, qty: qty, unit_cost: part.unit_cost });
  
  renderWorkOrderParts();
  calculateWorkOrderCost();
}

function renderWorkOrderParts() {
  const tbody = document.getElementById('wo_parts_table');
  if (!tbody) return;
  tbody.innerHTML = state.woPartsUsed.map((p, i) => `
    <tr>
      <td>${p.name}</td>
      <td>${p.qty}</td>
      <td>Rs. ${p.unit_cost}</td>
      <td>Rs. ${(p.qty * p.unit_cost).toFixed(2)}</td>
      <td><button onclick="state.woPartsUsed.splice(${i},1); window.renderWorkOrderParts(); window.calculateWorkOrderCost();" class="modal-close" style="font-size:14px;">&times;</button></td>
    </tr>
  `).join('');
}

function calculateWorkOrderCost() {
  const labor = parseFloat(document.getElementById('wo_labor_cost')?.value || 0);
  const parts = state.woPartsUsed.reduce((s, p) => s + (p.qty * p.unit_cost), 0);
  const elParts = document.getElementById('wo_parts_cost');
  const elTotal = document.getElementById('wo_total_cost');
  if (elParts) elParts.innerText = `Rs. ${parts.toFixed(2)}`;
  if (elTotal) elTotal.innerText = `Rs. ${(labor + parts).toFixed(2)}`;
}

async function createWorkOrder() {
  const laborCost = parseFloat(document.getElementById('wo_labor_cost').value) || 0;
  const partsCost = state.woPartsUsed.reduce((s, p) => s + (p.qty * p.unit_cost), 0);
  const woNumber = document.querySelector('#appModal input[readonly]').value; // Grab generated WO number
  
  const payload = {
    equipment_id: document.getElementById('wo_eq_id').value,
    work_order_number: woNumber,
    type: document.getElementById('wo_type').value,
    technician: document.getElementById('wo_tech').value,
    due_date: document.getElementById('wo_due').value || new Date().toISOString().split('T')[0],
    status: 'PENDING',
    failure_reason: document.getElementById('wo_failure_reason').value,
    labor_cost: laborCost,
    parts_cost: partsCost,
    cost: laborCost + partsCost,
    parts_used: JSON.stringify(state.woPartsUsed)
  };
  
  const { error } = await dbClient.from('maintenance_orders').insert([payload]);
  if (error) return handleError("Database", error);

  for (const p of state.woPartsUsed) {
    const invItem = state.globalData.inventory.find(i => i.id === p.part_id);
    if (invItem) {
      const newQty = Math.max(0, invItem.stock_quantity - p.qty);
      const newStatus = newQty === 0 ? 'OUT OF STOCK' : newQty <= 5 ? 'LOW STOCK' : 'AVAILABLE';
      await dbClient.from('parts_inventory').update({ stock_quantity: newQty, status: newStatus }).eq('id', p.part_id);
    }
  }

  if (!navigator.onLine && state.globalData) {
    payload.id = 'temp-' + Date.now();
    payload.created_at = new Date().toISOString();
    const eq = state.globalData.equip.find(e => e.id === payload.equipment_id);
    payload.equipment = { name: eq ? eq.name : 'Unknown' };
    state.globalData.maint.push(payload);
  }

  logAudit('WORK_ORDER_CREATE', `Created WO: ${payload.work_order_number} (Cost: Rs.${payload.cost})`);
  notify("Work Order created and inventory updated.");
  UI.closeModal();
  await window.initializeAppData(true);
}

export function openEditWorkOrderModal(id) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const m = state.globalData.maint.find(x => x.id === id);
  if (!m) return;
  
  const partsOptions = state.globalData ? state.globalData.inventory.map(p => `<option value="${p.id}">${p.name} (Stock: ${p.stock_quantity})</option>`).join('') : '';
  UI.openModal("Manage Work Order", `
    <div class="modal-input-group"><label class="modal-label">WO Number</label><input type="text" class="modal-input" value="${m.work_order_number}" disabled></div>
    <div class="modal-input-group"><label class="modal-label">Technician</label><input type="text" id="edit_wo_tech" class="modal-input" value="${m.technician || ''}"></div>
    <div class="modal-input-group"><label class="modal-label">Status</label><select id="edit_wo_status" class="modal-input" onchange="window.handleStatusChange('${m.id}')"><option value="PENDING" ${m.status==='PENDING'?'selected':''}>PENDING</option><option value="IN PROGRESS" ${m.status==='IN PROGRESS'?'selected':''}>IN PROGRESS</option><option value="COMPLETED" ${m.status==='COMPLETED'?'selected':''}>COMPLETED</option></select></div>
    <div class="modal-input-group"><label class="modal-label">MTTR (Hours) <span id="mttr-auto-label" style="font-size:9px; color:var(--green);">${m.status === 'COMPLETED' ? '(Auto-calculated)' : ''}</span></label><input type="number" id="edit_wo_mttr" class="modal-input" value="${m.mttr_hours || 0}" ${m.status === 'COMPLETED' ? 'readonly' : ''}></div>
    <div class="modal-input-group"><label class="modal-label">Failure Reason</label><input type="text" id="edit_wo_failure_reason" class="modal-input" value="${m.failure_reason || ''}"></div>
    
    <h4 style="font-family:'Sora',sans-serif; margin:15px 0 10px; font-size:12px;">Parts & Costing</h4>
    <div style="display:flex; gap:10px; align-items:end; margin-bottom:10px;">
      <div class="modal-input-group" style="flex:2; margin:0;">
        <label class="modal-label">Add Part</label>
        <select id="wo_part_select" class="modal-input"><option value="">Select Part...</option>${partsOptions}</select>
      </div>
      <div class="modal-input-group" style="flex:1; margin:0;">
        <label class="modal-label">Qty</label>
        <input type="number" id="wo_part_qty" class="modal-input" value="1" min="1">
      </div>
      <button class="btn btn-primary" onclick="window.addPartToWorkOrder()">Add</button>
    </div>
    <table class="table" style="font-size:10px; margin-bottom:10px;">
      <thead><tr><th>PART</th><th>QTY</th><th>UNIT</th><th>TOTAL</th><th></th></tr></thead>
      <tbody id="wo_parts_table"></tbody>
    </table>
    
    <div class="modal-input-group"><label class="modal-label">Labor Cost (Rs)</label><input type="number" id="wo_labor_cost" class="modal-input" value="${m.labor_cost || 0}" oninput="window.calculateWorkOrderCost()"></div>
    <div class="cost-row"><span>Parts Cost</span><strong id="wo_parts_cost">Rs. 0.00</strong></div>
    <div class="cost-row" style="border-bottom:none; font-size:13px;"><strong>Total Cost</strong><strong id="wo_total_cost">Rs. 0.00</strong></div>
    
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.updateWorkOrder('${id}')">Save Changes</button><button class="btn btn-ghost" style="border-color:var(--red); color:var(--red);" onclick="window.deleteRecord('maintenance_orders', '${id}')">Delete</button></div>
  `);
  
  try {
    state.woPartsUsed = typeof m.parts_used === 'string' ? JSON.parse(m.parts_used || '[]') : (m.parts_used || []);
  } catch (e) {
    state.woPartsUsed = [];
  }
  
  window.addPartToWorkOrder = addPartToWorkOrder;
  window.renderWorkOrderParts = renderWorkOrderParts;
  window.calculateWorkOrderCost = calculateWorkOrderCost;
  window.handleStatusChange = handleStatusChange;
  window.updateWorkOrder = updateWorkOrder;
  
  renderWorkOrderParts();
  calculateWorkOrderCost();
}

function handleStatusChange(woId) {
  const statusSelect = document.getElementById('edit_wo_status');
  const mttrInput = document.getElementById('edit_wo_mttr');
  const mttrLabel = document.getElementById('mttr-auto-label');
  if (!statusSelect || !mttrInput) return;
  
  if (statusSelect.value === 'COMPLETED') {
    const m = state.globalData.maint.find(x => x.id === woId);
    const createdAtStr = m.created_at || m.inserted_at || new Date().toISOString();
    const createdAt = new Date(createdAtStr).getTime();
    const diffHours = Math.max(0, (Date.now() - createdAt) / (1000 * 60 * 60));
    
    mttrInput.value = diffHours.toFixed(2);
    mttrInput.readOnly = true;
    if (mttrLabel) mttrLabel.innerText = '(Auto-calculated)';
    notify('MTTR automatically calculated based on creation date.', 'info', 2000);
  } else {
    mttrInput.readOnly = false;
    if (mttrLabel) mttrLabel.innerText = '';
  }
}

async function updateWorkOrder(id) {
  const m = state.globalData.maint.find(x => x.id === id);
  const laborCost = parseFloat(document.getElementById('wo_labor_cost').value) || 0;
  const partsCost = state.woPartsUsed.reduce((s, p) => s + (p.qty * p.unit_cost), 0);
  
  const newStatus = document.getElementById('edit_wo_status').value;
  const payload = {
    technician: document.getElementById('edit_wo_tech').value,
    status: newStatus,
    mttr_hours: parseFloat(document.getElementById('edit_wo_mttr').value) || 0,
    failure_reason: document.getElementById('edit_wo_failure_reason').value,
    labor_cost: laborCost,
    parts_cost: partsCost,
    cost: laborCost + partsCost,
    parts_used: JSON.stringify(state.woPartsUsed)
  };

  // Automatic MTTR Detector & Completed At Tracking
  if (newStatus === 'COMPLETED' && m.status !== 'COMPLETED') {
    payload.completed_at = new Date().toISOString();
    const createdAtStr = m.created_at || payload.completed_at;
    const createdAt = new Date(createdAtStr).getTime();
    const completedTime = new Date(payload.completed_at).getTime();
    if (completedTime > createdAt) {
      const diffHours = Math.max(0, (completedTime - createdAt) / (1000 * 60 * 60));
      payload.mttr_hours = parseFloat(diffHours.toFixed(2));
    }
  }
  
  const { error } = await dbClient.from('maintenance_orders').update(payload).eq('id', id);
  if (error) return handleError("Database", error);

  let oldParts = [];
  try {
    oldParts = typeof m.parts_used === 'string' ? JSON.parse(m.parts_used || '[]') : (m.parts_used || []);
  } catch (e) { oldParts = []; }
  const newParts = state.woPartsUsed;

  const partMap = {};
  oldParts.forEach(p => { partMap[p.part_id] = (partMap[p.part_id] || 0) - p.qty; });
  newParts.forEach(p => { partMap[p.part_id] = (partMap[p.part_id] || 0) + p.qty; });

  for (const partId in partMap) {
    const delta = partMap[partId]; 
    if (delta !== 0) {
      const invItem = state.globalData.inventory.find(i => i.id === partId);
      if (invItem) {
        const change = -delta;
        const updatedQty = Math.max(0, invItem.stock_quantity + change);
        const newInvStatus = updatedQty === 0 ? 'OUT OF STOCK' : updatedQty <= 5 ? 'LOW STOCK' : 'AVAILABLE';
        await dbClient.from('parts_inventory').update({ stock_quantity: updatedQty, status: newInvStatus }).eq('id', partId);
      }
    }
  }

  if (!navigator.onLine && state.globalData) {
    const idx = state.globalData.maint.findIndex(e => e.id === id);
    if (idx !== -1) Object.assign(state.globalData.maint[idx], payload);
  }

  logAudit('WORK_ORDER_UPDATE', `Updated WO ID: ${id} | Status: ${newStatus}`);
  notify("Work Order updated and inventory reconciled.");
  UI.closeModal();
  await window.initializeAppData(true);
}

// --- Warranty CRUD ---
export function openNewWarrantyModal() {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const options = state.globalData ? state.globalData.equip.map(e => `<option value="${e.id}">${e.name}</option>`).join('') : '';
  UI.openModal("Add Warranty", `
    <div class="modal-input-group"><label class="modal-label">Equipment</label><select id="war_eq_id" class="modal-input">${options}</select></div>
    <div class="modal-input-group"><label class="modal-label">Supplier</label><input type="text" id="war_supplier" class="modal-input" placeholder="Supplier Name"></div>
    <div class="modal-input-group"><label class="modal-label">Start Date</label><input type="date" id="war_start" class="modal-input"></div>
    <div class="modal-input-group"><label class="modal-label">Expiry Date</label><input type="date" id="war_expiry" class="modal-input"></div>
    <div class="modal-input-group"><label class="modal-label">Claim Value (Rs)</label><input type="number" id="war_claim" class="modal-input" value="0"></div>
    <div class="modal-input-group"><label class="modal-label">Terms & Conditions</label><textarea id="war_terms" class="modal-input" rows="3" placeholder="Coverage details, exclusions, etc."></textarea></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.createWarranty()">Save Warranty</button></div>
  `);
  window.createWarranty = createWarranty;
}

async function createWarranty() {
  const expiryDate = document.getElementById('war_expiry').value;
  const payload = {
    equipment_id: document.getElementById('war_eq_id').value,
    supplier: document.getElementById('war_supplier').value,
    start_date: document.getElementById('war_start').value || new Date().toISOString().split('T')[0],
    expiry_date: expiryDate,
    claim_value: parseFloat(document.getElementById('war_claim').value) || 0,
    terms: document.getElementById('war_terms').value,
    status: calculateWarrantyStatus(expiryDate) // AUTO-CALCULATED
  };
  const { error } = await dbClient.from('warranties').insert([payload]);
  if (error) return handleError("Database", error);

  if (!navigator.onLine && state.globalData) {
    payload.id = 'temp-' + Date.now();
    const eq = state.globalData.equip.find(e => e.id === payload.equipment_id);
    payload.equipment = { name: eq ? eq.name : 'Unknown' };
    state.globalData.warranties.push(payload);
  }

  logAudit('WARRANTY_CREATE', `Created warranty for equipment: ${payload.equipment_id}`);
  notify("Warranty logged.");
  UI.closeModal();
  await window.initializeAppData(true);
}

export function openEditWarrantyModal(id) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const w = state.globalData.warranties.find(x => x.id === id);
  if (!w) return;
  
  const formattedExpiry = w.expiry_date ? new Date(w.expiry_date).toISOString().split('T')[0] : '';
  
  UI.openModal("Edit Warranty", `
    <div class="modal-input-group"><label class="modal-label">Supplier</label><input type="text" id="edit_war_supplier" class="modal-input" value="${w.supplier || ''}"></div>
    <div class="modal-input-group"><label class="modal-label">Expiry Date</label><input type="date" id="edit_war_expiry" class="modal-input" value="${formattedExpiry}"></div>
    <div class="modal-input-group"><label class="modal-label">Status (Auto-calculated)</label><input type="text" class="modal-input" value="${calculateWarrantyStatus(w.expiry_date)}" disabled></div>
    <div class="modal-input-group"><label class="modal-label">Claim Value (Rs)</label><input type="number" id="edit_war_claim" class="modal-input" value="${w.claim_value || 0}"></div>
    <div class="modal-input-group"><label class="modal-label">Terms & Conditions</label><textarea id="edit_war_terms" class="modal-input" rows="3">${w.terms || ''}</textarea></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.updateWarranty('${id}')">Save Changes</button><button class="btn btn-ghost" style="border-color:var(--red); color:var(--red);" onclick="window.deleteRecord('warranties', '${id}')">Delete</button></div>
  `);
  window.updateWarranty = updateWarranty;
}

async function updateWarranty(id) {
  const expiryDate = document.getElementById('edit_war_expiry').value;
  const payload = {
    supplier: document.getElementById('edit_war_supplier').value,
    expiry_date: expiryDate,
    status: calculateWarrantyStatus(expiryDate), // AUTO-CALCULATED
    claim_value: parseFloat(document.getElementById('edit_war_claim').value) || 0,
    terms: document.getElementById('edit_war_terms').value
  };
  const { error } = await dbClient.from('warranties').update(payload).eq('id', id);
  if (error) return handleError("Database", error);

  if (!navigator.onLine && state.globalData) {
    const idx = state.globalData.warranties.findIndex(e => e.id === id);
    if (idx !== -1) Object.assign(state.globalData.warranties[idx], payload);
  }

  logAudit('WARRANTY_UPDATE', `Updated warranty ID: ${id}`);
  notify("Warranty updated.");
  UI.closeModal();
  await window.initializeAppData(true);
}

// --- Inventory CRUD ---
export function openNewInventoryModal() {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const options = state.globalData ? state.globalData.equip.map(e => `<option value="${e.id}">${e.name}</option>`).join('') : '';
  UI.openModal("Add Inventory Part", `
    <div class="modal-input-group"><label class="modal-label">Part Name *</label><input type="text" id="inv_name" class="modal-input" placeholder="e.g. Servo Motor MG90S"></div>
    <div class="modal-input-group"><label class="modal-label">Part Number</label><input type="text" id="inv_number" class="modal-input" placeholder="SKU-882"></div>
    <div class="modal-input-group"><label class="modal-label">For Equipment</label><select id="inv_eq_id" class="modal-input"><option value="">Generic / All Assets</option>${options}</select></div>
    <div class="modal-input-group"><label class="modal-label">Quantity</label><input type="number" id="inv_qty" class="modal-input" value="10"></div>
    <div class="modal-input-group"><label class="modal-label">Unit Cost (Rs)</label><input type="number" id="inv_cost" class="modal-input" value="0"></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.createInventory()">Save Part</button></div>
  `);
  window.createInventory = createInventory;
}

async function createInventory() {
  const payload = {
    name: document.getElementById('inv_name').value,
    part_number: document.getElementById('inv_number').value,
    equipment_id: document.getElementById('inv_eq_id').value || null,
    stock_quantity: parseInt(document.getElementById('inv_qty').value) || 0,
    unit_cost: parseFloat(document.getElementById('inv_cost').value) || 0,
    status: parseInt(document.getElementById('inv_qty').value) > 5 ? 'AVAILABLE' : 'LOW STOCK'
  };
  if (!payload.name) return notify("Part name is required.");
  const { error } = await dbClient.from('parts_inventory').insert([payload]);
  if (error) return handleError("Database", error);

  if (!navigator.onLine && state.globalData) {
    payload.id = 'temp-' + Date.now();
    const eq = state.globalData.equip.find(e => e.id === payload.equipment_id);
    payload.equipment = { name: eq ? eq.name : 'Generic' };
    state.globalData.inventory.push(payload);
  }

  logAudit('INVENTORY_CREATE', `Created part: ${payload.name}`);
  notify("Part added to inventory.");
  UI.closeModal();
  await window.initializeAppData(true);
}

export function openEditInventoryModal(id) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied.");
  const item = state.globalData.inventory.find(x => x.id === id);
  if (!item) return;
  UI.openModal("Edit Part", `
    <div class="modal-input-group"><label class="modal-label">Part Name</label><input type="text" id="edit_inv_name" class="modal-input" value="${item.name}"></div>
    <div class="modal-input-group"><label class="modal-label">Stock Quantity</label><input type="number" id="edit_inv_qty" class="modal-input" value="${item.stock_quantity}"></div>
    <div class="modal-input-group"><label class="modal-label">Unit Cost (Rs)</label><input type="number" id="edit_inv_cost" class="modal-input" value="${item.unit_cost}"></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.updateInventory('${id}')">Save Changes</button><button class="btn btn-ghost" style="border-color:var(--red); color:var(--red);" onclick="window.deleteRecord('parts_inventory', '${id}')">Delete</button></div>
  `);
  window.updateInventory = updateInventory;
}

async function updateInventory(id) {
  const qty = parseInt(document.getElementById('edit_inv_qty').value) || 0;
  const payload = {
    name: document.getElementById('edit_inv_name').value,
    stock_quantity: qty,
    unit_cost: parseFloat(document.getElementById('edit_inv_cost').value) || 0,
    status: qty === 0 ? 'OUT OF STOCK' : qty <= 5 ? 'LOW STOCK' : 'AVAILABLE'
  };
  const { error } = await dbClient.from('parts_inventory').update(payload).eq('id', id);
  if (error) return handleError("Database", error);

  if (!navigator.onLine && state.globalData) {
    const idx = state.globalData.inventory.findIndex(e => e.id === id);
    if (idx !== -1) Object.assign(state.globalData.inventory[idx], payload);
  }

  logAudit('INVENTORY_UPDATE', `Updated item ID: ${id}`);
  notify("Inventory updated.");
  UI.closeModal();
  await window.initializeAppData(true);
}

// --- AI Approval Functions ---
export async function approveAgentTask(taskPayload) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied: Admin authorization required.");
  notify("Committing AI task...");
  const { error } = await dbClient.from('maintenance_orders').insert([taskPayload]);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine && state.globalData) {
    taskPayload.id = 'temp-' + Date.now();
    taskPayload.created_at = new Date().toISOString();
    const eq = state.globalData.equip.find(e => e.id === taskPayload.equipment_id);
    taskPayload.equipment = { name: eq ? eq.name : 'Unknown' };
    state.globalData.maint.push(taskPayload);
  }

  logAudit('AI_TASK_APPROVED', `Admin approved task: ${taskPayload.work_order_number}`);
  notify("Work order authorized and saved!");
  document.getElementById("aiResponse").innerHTML = `<h4 style="color:var(--green)">✓ TASK AUTHORIZED</h4><p>The work order has been added to the system.</p>`;
  await window.initializeAppData(true);
}

export async function approveDeletion(payload) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied: Admin authorization required.");
  notify("Deleting record...");
  const { error } = await dbClient.from(payload.table).delete().eq('id', payload.id);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine && state.globalData) state.globalData.equip = state.globalData.equip.filter(e => e.id !== payload.id);

  logAudit('AI_DELETION_APPROVED', `Admin approved deletion of: ${payload.name}`);
  notify("Record deleted successfully.");
  document.getElementById("aiResponse").innerHTML = `<h4 style="color:var(--green)">✓ DELETION AUTHORIZED</h4><p>${payload.name} has been deleted from the system.</p>`;
  await window.initializeAppData(true);
}

export async function approveUpdate(payload) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied: Admin authorization required.");
  notify("Updating record...");
  
  let updateData = { ...payload };
  const tableName = updateData.table;
  delete updateData.table;
  delete updateData.name;
  if (updateData.work_order_number) delete updateData.work_order_number; 

  // If AI is closing a work order, trigger MTTR calculation
  if (tableName === 'maintenance_orders' && updateData.status === 'COMPLETED') {
    const m = state.globalData.maint.find(x => x.id === payload.id);
    if (m && m.status !== 'COMPLETED') {
      updateData.completed_at = new Date().toISOString();
      const createdAtStr = m.created_at || updateData.completed_at;
      const createdAt = new Date(createdAtStr).getTime();
      const diffHours = Math.max(0, (new Date(updateData.completed_at).getTime() - createdAt) / (1000 * 60 * 60));
      updateData.mttr_hours = parseFloat(diffHours.toFixed(2));
    }
  }

  const { error } = await dbClient.from(tableName).update(updateData).eq('id', payload.id);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine && state.globalData) {
    const arr = tableName === 'equipment' ? state.globalData.equip : tableName === 'maintenance_orders' ? state.globalData.maint : [];
    const idx = arr.findIndex(e => e.id === payload.id);
    if (idx !== -1) Object.assign(arr[idx], updateData);
  }

  logAudit('AI_UPDATE_APPROVED', `Admin approved update for ID: ${payload.id}`);
  notify("Record updated successfully.");
  document.getElementById("aiResponse").innerHTML = `<h4 style="color:var(--green)">✓ UPDATE AUTHORIZED</h4><p>The record has been updated in the system.</p>`;
  await window.initializeAppData(true);
}

export async function approveInsert(payload) {
  if (state.currentUser.role !== 'admin') return notify("Access Denied: Admin authorization required.");
  notify("Inserting record...");
  const { error } = await dbClient.from(payload.table).insert([payload.data]);
  if (error) return handleError("Database", error);
  
  if (!navigator.onLine && state.globalData) {
    payload.data.id = 'temp-' + Date.now();
    if (payload.table === 'parts_inventory') state.globalData.inventory.push(payload.data);
  }

  logAudit('AI_INSERT_APPROVED', `Admin approved insert for: ${payload.data.name}`);
  notify("Record added successfully.");
  document.getElementById("aiResponse").innerHTML = `<h4 style="color:var(--green)">✓ INSERT AUTHORIZED</h4><p>${payload.data.name} has been added to the system.</p>`;
  await window.initializeAppData(true);
}