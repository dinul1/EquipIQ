// js/router.js
import * as CRUD from './crud.js';
import * as analytics from './analytics.js';
import * as ocr from './ocr.js';
import { UI, notify } from './ui.js';
import { state } from './state.js';

// Flattens nested objects for clean CSV export
function flattenObject(obj, prefix = '') {
  return Object.keys(obj).reduce((acc, k) => {
    const pre = prefix.length ? prefix + '_' : '';
    if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
      Object.assign(acc, flattenObject(obj[k], pre + k));
    } else {
      acc[pre + k] = obj[k];
    }
    return acc;
  }, {});
}

export function exportToCSV(data, filename) {
  if (!data || data.length === 0) return notify('No data to export');
  
  // Flatten data to handle nested objects like equipment.name
  const flatData = data.map(item => flattenObject(item));
  const headers = Object.keys(flatData[0]);
  
  const csv = [
    headers.join(','),
    ...flatData.map(row => headers.map(h => JSON.stringify(row[h] || '')).join(','))
  ].join('\n');
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  notify(`Exported ${filename} successfully`, 'success');
}

export function exportMaintenancePDF(woData) {
  if (!window.jspdf) return notify('PDF library not loaded yet.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  doc.setFontSize(16);
  doc.text(`Work Order: ${woData.work_order_number}`, 10, 20);
  doc.setFontSize(12);
  doc.text(`Equipment: ${woData.equipment?.name || 'N/A'}`, 10, 30);
  doc.text(`Technician: ${woData.technician || 'Unassigned'}`, 10, 40);
  doc.text(`Status: ${woData.status}`, 10, 50);
  doc.text(`Cost: Rs. ${woData.cost || 0}`, 10, 60);
  doc.text(`Failure Reason: ${woData.failure_reason || 'N/A'}`, 10, 70);
  doc.text(`MTTR (Hours): ${woData.mttr_hours || 0}`, 10, 80);
  doc.save(`WO-${woData.work_order_number}.pdf`);
  notify('PDF generated', 'success');
}

export function initRouter(app) {
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    
    const action = target.dataset.action;
    const id = target.dataset.id;
    const page = target.dataset.page;
    const table = target.dataset.table;
    
    switch(action) {
      case 'login': app.handleLogin(); break;
      case 'guest': app.continueAsGuest(); break;
      case 'toggle-sidebar': 
        document.getElementById("sidebar").classList.toggle("open"); 
        document.getElementById("sidebarOverlay").classList.toggle("show"); 
        break;
      case 'toggle-fullscreen': 
        if (!document.fullscreenElement) document.documentElement.requestFullscreen(); 
        else document.exitFullscreen(); 
        break;
      case 'navigate': UI.navigate(page); break;
      case 'close-modal': UI.closeModal(); break;
      
      // Modals
      case 'open-register-eq': CRUD.openRegisterEquipmentModal(); break;
      case 'open-new-wo': CRUD.openNewWorkOrderModal(); break;
      case 'open-new-warr': CRUD.openNewWarrantyModal(); break;
      case 'open-new-inv': CRUD.openNewInventoryModal(); break;
      case 'open-new-sust': analytics.openNewSustainabilityModal(); break;
      
      // Edit/Delete
      case 'edit-eq': CRUD.openEditEquipmentModal(id); break;
      case 'edit-wo': CRUD.openEditWorkOrderModal(id); break;
      case 'edit-warr': CRUD.openEditWarrantyModal(id); break;
      case 'edit-inv': CRUD.openEditInventoryModal(id); break;
      case 'view-master': analytics.openMasterPropertiesModal(id); break;
      case 'delete-record': CRUD.deleteRecord(table, id); break;
      
      // QR & Barcode
      case 'view-qr': CRUD.openQrModal(id); break;
      case 'print-qr': CRUD.printQR(id); break;
      case 'start-barcode': ocr.startBarcodeScanner(); break;
      
      // OCR
      case 'process-ocr': ocr.processRealOCR(); break;
      case 'confirm-ocr': ocr.confirmOCR(); break;
      
      // TCO & Analytics
      case 'load-tco': analytics.loadComponentForTCO(id); break;
      case 'fetch-market-price': analytics.fetchCurrentMarketPrice(); break;
      case 'calculate-rvr': analytics.calculateRvR(); break;
      case 'generate-report': analytics.generateExecutiveReport(); break;
      
      // AI
      case 'ask-ai': app.askAI(); break;
      case 'approve-task': CRUD.approveAgentTask(state.pendingTask); break;
      case 'approve-update': CRUD.approveUpdate(state.pendingUpdate); break;
      case 'approve-insert': CRUD.approveInsert(state.pendingInsert); break;
      case 'approve-delete': CRUD.approveDeletion(state.pendingDelete); break;
      case 'approve-email': app.approveEmailStats(); break;
      
      // Exports
      case 'export-wo-pdf': 
        const wo = state.globalData.maint.find(m => m.id === id);
        if (wo) exportMaintenancePDF(wo);
        break;
      case 'export-maint-csv': exportToCSV(state.globalData.maint, 'maintenance_export.csv'); break;
      case 'export-equip-csv': exportToCSV(state.globalData.equip, 'equipment_export.csv'); break;
      case 'export-inv-csv': exportToCSV(state.globalData.inventory, 'inventory_export.csv'); break;
      case 'export-audit-csv': exportToCSV(state.globalData.logs, 'audit_logs.csv'); break;
      
      // System
      case 'filter-audit': app.filterAudit(); break;
      case 'handle-logout': app.handleLogout(); break;
      case 'save-sust': window.saveSustainabilityData(); break;
      case 'load-more-maint': app.loadMoreMaint(); break;
    }
  });
}