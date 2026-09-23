// js/ocr.js
import { state, dbClient, logAudit, handleError } from './state.js';
import { UI, notify } from './ui.js';
import { ResilientAI } from './analytics.js';
import { openEditInventoryModal, openNewInventoryModal } from './crud.js';

export function loadTesseractScript() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Tesseract.js'));
    document.head.appendChild(script);
  });
}

export function initDragAndDrop() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-upload');
  if(!dropZone || !fileInput) return;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { 
    e.preventDefault(); 
    dropZone.classList.add('dragover'); 
  });
  dropZone.addEventListener('dragleave', () => { 
    dropZone.classList.remove('dragover'); 
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      notify('File dropped. Ready for OCR.', 'success');
    }
  });
}

export async function processRealOCR() {
  const fileInput = document.getElementById('file-upload');
  if (!fileInput.files[0]) return notify("Please select an image file first.");
  const file = fileInput.files[0];
  
  const progressBar = document.getElementById('ocr-progress');
  const progressbarBar = document.getElementById('ocr-progress-bar');
  progressBar.classList.remove('hidden');
  progressbarBar.style.width = '0%';

  notify('Loading OCR Engine & WASM Worker...');
  try {
    await loadTesseractScript();
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: m => { 
        if (m.status === 'recognizing text') progressbarBar.style.width = Math.round(m.progress * 100) + '%'; 
      },
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5",
      langPath: "https://tessdata.projectnaptha.com/4.0.0"
    });

    notify('OCR Processing Initialized...');
    const { data: { text } } = await worker.recognize(file);
    await worker.terminate();

    state.extractedOCRText = text;
    
    notify('AI parsing document data...');
    try {
      const prompt = `Parse this OCR text and return ONLY a JSON object with keys: supplier, serial_number, total_price, date (YYYY-MM-DD). Text: ${text}`;
      const aiResult = await ResilientAI.invoke(prompt, { skipCache: true });
      const jsonStr = aiResult.text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsedData = JSON.parse(jsonStr);
      
      const options = state.globalData ? state.globalData.equip.map(e => `<option value="${e.id}">${e.name}</option>`).join('') : '';
      document.getElementById('ocr-extraction-data').innerHTML = `
        <div class="modal-input-group" style="margin-bottom:15px; border-bottom:1px solid var(--line); padding-bottom:15px;">
          <label class="modal-label">Link to Equipment</label>
          <select id="ocr-equip-link" class="modal-input"><option value="">Select Equipment...</option>${options}</select>
        </div>
        <div class="cost-row"><span>Supplier</span><strong>${parsedData.supplier || 'Not found'}</strong></div>
        <div class="cost-row"><span>Serial Number</span><strong>${parsedData.serial_number || 'Not found'}</strong></div>
        <div class="cost-row"><span>Purchase Date</span><strong>${parsedData.date || 'Not found'}</strong></div>
        <div class="cost-row"><span>Price</span><strong>Rs. ${parsedData.total_price || 'Not found'}</strong></div>
      `;
    } catch(e) {
      console.error("AI OCR Parse failed, falling back to regex", e);
      const getMatch = (re) => state.extractedOCRText.match(re) ? state.extractedOCRText.match(re)[1].trim() : "Not found";
      const supplier = getMatch(/(?:Supplier|From|Biller)[:\s]+([A-Za-z0-9\s]+)/i);
      const serial = getMatch(/(?:Serial|S\/N|SN)[:\s]+([A-Z0-9\-]+)/i);
      const price = getMatch(/(?:Total|Price|Amount)[:\s]+(?:Rs\.?\s*)?([0-9,]+\.[0-9]{2})/i);
      const date = getMatch(/(?:Date|Purchased)[:\s]+([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
      const options = state.globalData ? state.globalData.equip.map(e => `<option value="${e.id}">${e.name}</option>`).join('') : '';
      
      document.getElementById('ocr-extraction-data').innerHTML = `
        <div class="modal-input-group" style="margin-bottom:15px; border-bottom:1px solid var(--line); padding-bottom:15px;">
          <label class="modal-label">Link to Equipment</label>
          <select id="ocr-equip-link" class="modal-input"><option value="">Select Equipment...</option>${options}</select>
        </div>
        <div class="cost-row"><span>Supplier</span><strong>${supplier}</strong></div>
        <div class="cost-row"><span>Serial Number</span><strong>${serial}</strong></div>
        <div class="cost-row"><span>Purchase Date</span><strong>${date}</strong></div>
        <div class="cost-row"><span>Price</span><strong>Rs. ${price}</strong></div>
      `;
    }

    document.getElementById('ocr-result').classList.remove('hidden');
    progressBar.classList.add('hidden');
    notify('OCR Extraction Complete!', 'success');
  } catch (error) {
    handleError("OCR", error);
    progressBar.classList.add('hidden');
  }
}

export async function confirmOCR() {
  const equipId = document.getElementById('ocr-equip-link').value;
  if (!equipId) return notify("Please link the document to an equipment asset.");
  notify("Committing extracted data...");
  const dataRows = document.querySelectorAll('#ocr-extraction-data .cost-row');
  const extractedData = {};
  dataRows.forEach(row => {
    const key = row.querySelector('span').innerText.toLowerCase().replace(/ /g, '_');
    const val = row.querySelector('strong').innerText;
    extractedData[key] = val;
  });
  const payload = { 
    equipment_id: equipId, 
    raw_text: state.extractedOCRText,
    extracted_data: extractedData,
    is_verified: true 
  };
  const { error } = await dbClient.from('documents').insert([payload]);
  if (error) return handleError("Database", error);
  logAudit('OCR_SAVE', `Document linked to equipment ID: ${equipId}`);
  notify("Document verified and linked successfully.", 'success');
  document.getElementById('ocr-result').classList.add('hidden');
  document.getElementById('file-upload').value = '';
}

// Fully Integrated QuaggaJS Barcode Scanner
export async function startBarcodeScanner() {
  if (!window.Quagga) return notify("Barcode library not loaded yet.");
  
  UI.openModal('Scan Barcode', `
    <div id="barcode-reader" style="width:100%; max-width:400px; height:300px; margin:0 auto; background:#000; border-radius:8px; overflow:hidden; position:relative;"></div>
    <p style="color:var(--muted); font-size:11px; margin-top:10px; text-align:center;">Position barcode within view</p>
  `);

  // Cleanup listener if modal is closed manually
  const cleanup = () => {
    if (window.Quagga) {
      try {
        Quagga.stop();
      } catch(e) {}
    }
    document.removeEventListener('modalClosed', cleanup);
  };
  document.addEventListener('modalClosed', cleanup);

  Quagga.init({
    inputStream: { 
      name: "Live", 
      type: "LiveStream", 
      target: document.querySelector('#barcode-reader'),
      constraints: { 
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    },
    decoder: { 
      readers: ["code_128_reader", "ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader"] 
    }
  }, function(err) {
    if (err) { 
      console.error(err); 
      notify("Camera access denied or unavailable.");
      UI.closeModal(); // This will trigger the cleanup event
      return; 
    }
    Quagga.start();
  });

  Quagga.onDetected((data) => {
    const code = data.codeResult.code;
    Quagga.stop();
    document.removeEventListener('modalClosed', cleanup); // Remove listener since we stopped manually
    UI.closeModal();
    
    // Search inventory for the scanned barcode
    const foundItem = state.globalData.inventory.find(i => i.part_number === code);
    
    if (foundItem) {
      notify(`Found: ${foundItem.name}`, 'success');
      openEditInventoryModal(foundItem.id);
    } else {
      notify(`Barcode ${code} not found. Opening form to add new part.`, 'info');
      // Pre-fill the new inventory modal with the scanned barcode
      openNewInventoryModal();
      setTimeout(() => {
        const partNumberInput = document.getElementById('inv_number');
        if (partNumberInput) partNumberInput.value = code;
      }, 100);
    }
  });
}