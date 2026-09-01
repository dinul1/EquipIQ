import { state, dbClient, logAudit, handleError } from './state.js';
import { UI, notify } from './ui.js';

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
    document.getElementById('ocr-result').classList.remove('hidden');
    progressBar.classList.add('hidden');
    notify('OCR Extraction Complete!');
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
  notify("Document verified and linked successfully.");
  document.getElementById('ocr-result').classList.add('hidden');
  document.getElementById('file-upload').value = '';
}

export async function openQRScanner() {
  const qrModal = document.getElementById('qrModal');
  qrModal.classList.add('active');
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      state.qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = document.getElementById('qr-video');
      video.srcObject = state.qrStream;
    }
  } catch (err) {
    notify("Camera access disabled or unavailable.");
  }
}

export function closeQRModal() {
  if (state.qrStream) {
    state.qrStream.getTracks().forEach(track => track.stop());
    state.qrStream = null;
  }
  document.getElementById('qrModal').classList.remove('active');
}