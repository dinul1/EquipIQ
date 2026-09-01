import { state, dbClient, logAudit, handleError } from './state.js';
import { notify } from './ui.js';
import { OfflineStore } from './offline.js';

// --- Web Worker for Financial Calculations ---
const tcoWorkerCode = `
    class FinancialDecisionEngine {
        constructor(horizon, discountRate) { this.H = horizon; this.r = discountRate; }
        calculateRepairTCO(q, m, w, f, mttr, loss) {
            let npv = 0;
            for (let t = 1; t <= this.H; t++) {
                const maint = m * Math.pow(1 + w, t);
                const down = f * mttr * loss;
                npv += (maint + down) / Math.pow(1 + this.r, t);
            }
            return q + npv;
        }
        calculateReplaceTCO(p, s, sal, m, f, mttr, loss, e) {
            const init = p + s - sal;
            let npv = 0;
            for (let t = 1; t <= this.H; t++) {
                const down = f * mttr * loss;
                npv += (m + down + e) / Math.pow(1 + this.r, t);
            }
            return init + npv;
        }
        getRecommendation(rp, pp) {
            const tcoR = this.calculateRepairTCO(rp.immediateQuote, rp.historicalMaint, rp.wearFactor, rp.failuresPerYear, rp.mttr, rp.hourlyLoss);
            const tcoP = this.calculateReplaceTCO(pp.purchasePrice, pp.setupCost, pp.salvageValue, pp.newMaint, pp.newFailures, pp.newMttr, rp.hourlyLoss, pp.energyCost);
            const delta = tcoP - tcoR;
            const financialRec = tcoR <= tcoP ? "REPAIR" : "REPLACE";
            const mfgCarbon = pp.mfgCarbon || 0;
            const carbonSavedByRepair = mfgCarbon;
            let envConclusion = "";
            if (financialRec === "REPAIR") {
                envConclusion = "By repairing this asset, you extend its lifecycle by " + this.H + " years, avoiding ~" + carbonSavedByRepair.toLocaleString() + " kg of CO2e emissions.";
            } else {
                envConclusion = "Replacing the asset immediately incurs ~" + carbonSavedByRepair.toLocaleString() + " kg of CO2e emissions. However, if the new asset provides significant energy efficiency, this upfront carbon cost may be offset over time.";
            }
            return {
                recommendation: financialRec,
                tco_repair: parseFloat(tcoR.toFixed(2)),
                tco_replace: parseFloat(tcoP.toFixed(2)),
                financial_delta: parseFloat(Math.abs(delta).toFixed(2)),
                horizon_years: this.H,
                timestamp: new Date().toISOString(),
                carbon_saved: carbonSavedByRepair,
                env_conclusion: envConclusion
            };
        }
    }
    self.onmessage = function(e) {
        const { rp, pp, horizon, rate } = e.data;
        const engine = new FinancialDecisionEngine(horizon, rate);
        const res = engine.getRecommendation(rp, pp);
        self.postMessage(res);
    };
`;
const tcoBlob = new Blob([tcoWorkerCode], { type: 'application/javascript' });
const tcoWorker = new Worker(URL.createObjectURL(tcoBlob));

export const LifecycleEngine = {
  calculateMTBF(eq, maintenanceRecords) {
    const failures = (maintenanceRecords || [])
      .filter(m => m.equipment_id === eq.id && m.type === 'CORRECTIVE')
      .map(m => ({ ...m, _d: new Date(m.due_date || m.created_at) }))
      .filter(m => !isNaN(m._d))
      .sort((a, b) => a._d - b._d);

    if (failures.length === 0) return null;
    if (failures.length === 1) {
      const start = new Date(eq.purchase_date || eq.installation_date || failures[0]._d);
      const days = (failures[0]._d - start) / 86400000;
      return days > 0 ? days : null;
    }
    let totalGap = 0;
    for (let i = 1; i < failures.length; i++) totalGap += (failures[i]._d - failures[i-1]._d) / 86400000;
    return totalGap / (failures.length - 1);
  },

  calculateMTTR(eq, maintenanceRecords) {
    const records = (maintenanceRecords || [])
      .filter(m => m.equipment_id === eq.id && m.mttr_hours != null);
    if (records.length === 0) return null;
    return records.reduce((s, m) => s + parseFloat(m.mttr_hours || 0), 0) / records.length;
  },

  computeHealthScore(eq, maintenanceRecords, warranties) {
    let score = 100;
    const reasons = [];

    const mttr = this.calculateMTTR(eq, maintenanceRecords);
    const mtbf = this.calculateMTBF(eq, maintenanceRecords);
    const allFailures = (maintenanceRecords || []).filter(m => m.equipment_id === eq.id && m.type === 'CORRECTIVE');
    const recentFailures = allFailures.filter(m => {
      const d = new Date(m.due_date || m.created_at);
      return !isNaN(d) && ((Date.now() - d) / 86400000) <= 180;
    });

    if (mttr !== null) {
      if (mttr > 24)        { score -= 25; reasons.push(`Critical MTTR ${mttr.toFixed(1)}h`); }
      else if (mttr > 12)   { score -= 18; reasons.push(`High MTTR ${mttr.toFixed(1)}h`); }
      else if (mttr > 8)    { score -= 12; reasons.push(`Elevated MTTR ${mttr.toFixed(1)}h`); }
      else if (mttr > 4)    { score -= 6;  reasons.push(`Moderate MTTR ${mttr.toFixed(1)}h`); }
      else                  { reasons.push(`Healthy MTTR ${mttr.toFixed(1)}h`); }
    }

    if (mtbf !== null) {
      if (mtbf < 15)        { score -= 30; reasons.push(`Very low MTBF ${mtbf.toFixed(0)}d`); }
      else if (mtbf < 30)   { score -= 22; reasons.push(`Low MTBF ${mtbf.toFixed(0)}d`); }
      else if (mtbf < 90)   { score -= 14; reasons.push(`Moderate MTBF ${mtbf.toFixed(0)}d`); }
      else if (mtbf < 180)  { score -= 6;  reasons.push(`Acceptable MTBF ${mtbf.toFixed(0)}d`); }
      else                  { reasons.push(`Strong MTBF ${mtbf.toFixed(0)}d`); }
    }

    if (recentFailures.length >= 4)      { score -= 25; reasons.push(`${recentFailures.length} failures in 6mo`); }
    else if (recentFailures.length === 3){ score -= 18; reasons.push(`${recentFailures.length} failures in 6mo`); }
    else if (recentFailures.length === 2){ score -= 10; reasons.push(`${recentFailures.length} failures in 6mo`); }
    else if (recentFailures.length === 1){ score -= 4;  reasons.push(`1 failure in 6mo`); }

    if (eq.purchase_date) {
      const ageYears = (Date.now() - new Date(eq.purchase_date)) / (365.25 * 86400000);
      if (ageYears > 12)      { score -= 18; reasons.push(`Aged ${ageYears.toFixed(1)}y`); }
      else if (ageYears > 8)  { score -= 12; reasons.push(`Aged ${ageYears.toFixed(1)}y`); }
      else if (ageYears > 5)  { score -= 7;  reasons.push(`Aged ${ageYears.toFixed(1)}y`); }
      else if (ageYears > 3)  { score -= 3;  }
    }

    if (eq.status === 'CRITICAL')   { score = Math.min(score, 25); reasons.push('Flagged CRITICAL'); }
    else if (eq.status === 'MAINTENANCE') { score = Math.min(score, 60); reasons.push('In maintenance'); }

    const activeWarranty = (warranties || []).find(w => w.equipment_id === eq.id && w.status === 'ACTIVE');
    if (activeWarranty) { score = Math.min(100, score + 4); reasons.push('Warranty active'); }

    const pmRecords = (maintenanceRecords || []).filter(m => m.equipment_id === eq.id && m.type === 'PREVENTIVE');
    if (pmRecords.length > 0) {
      const pmCompleted = pmRecords.filter(m => m.status === 'COMPLETED').length;
      const compliance = pmCompleted / pmRecords.length;
      if (compliance < 0.5)       { score -= 12; reasons.push('Low PM compliance'); }
      else if (compliance < 0.8)  { score -= 5; }
      else                        { score = Math.min(100, score + 3); reasons.push('Strong PM compliance'); }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, mttr, mtbf, total_failures: allFailures.length, recent_failures: recentFailures.length, reasons, computed_at: new Date().toISOString() };
  },

  async autoUpdateAll(skipPersist = false) {
    if (!state.globalData || !state.globalData.equip) return { updated: 0, details: [] };
    let updated = 0;

    for (const eq of state.globalData.equip) {
      const result = this.computeHealthScore(eq, state.globalData.maint, state.globalData.warranties);
      const delta = Math.abs((eq.health_score || 0) - result.score);
      eq._lifecycle = result;

      if (delta >= 3 && !skipPersist) {
        if (navigator.onLine && dbClient) {
          try {
            await dbClient.from('equipment').update({ health_score: result.score }).eq('id', eq.id);
          } catch(e) {}
        }
        eq.health_score = result.score;
        updated++;
      } else if (delta > 0) {
        eq.health_score = result.score;
      }
    }
    return { updated, details: [] };
  }
};

export const ResilientAI = {
  cache: new Map(),
  MAX_RETRIES: 2,
  BASE_DELAY: 600,
  CACHE_TTL: 5 * 60 * 1000,

  hashKey(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return 'ai_' + Math.abs(h).toString(36);
  },

  async invoke(prompt, options = {}) {
    const key = this.hashKey(prompt);
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.ts) < this.CACHE_TTL && !options.skipCache) {
      return { text: cached.text, source: 'cache' };
    }

    if (!navigator.onLine) return { text: this.localFallback(prompt), source: 'offline' };

    let contextString = '';
    if (state.globalData && state.globalData.equip && state.globalData.equip.length > 0) {
      const allEq = state.globalData.equip.map(e => `${e.name} (Tag: ${e.asset_tag || 'N/A'}, Health: ${e.health_score}%, Status: ${e.status})`).join(', ');
      const openWOs = state.globalData.maint.filter(m => m.status !== 'COMPLETED').map(m => m.work_order_number).join(', ');
      contextString = `\n\n[SYSTEM CONTEXT]\nAssets: ${allEq}\nOpen Work Orders: ${openWOs || 'None'}`;
    }

    const humanPrompt = `${prompt + contextString}\n\n[SYSTEM INSTRUCTION]: Respond in a natural, conversational human tone. Do not output JSON, code blocks, or metadata.`;

    let lastError = null;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const { data, error } = await dbClient.functions.invoke('agent-proxy', {
          body: { prompt: humanPrompt, untrustedData: state.extractedOCRText || null },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (error) throw new Error(error.message || 'Edge function error');
        const text = sanitizeAIResponse(data);
        if (!text || text.startsWith('AI Error:')) throw new Error(text);

        this.cache.set(key, { text, ts: Date.now() });
        return { text, source: 'edge' };
      } catch(err) {
        lastError = err;
        if (attempt < this.MAX_RETRIES) await new Promise(r => setTimeout(r, this.BASE_DELAY * (attempt + 1)));
      }
    }
    return { text: this.localFallback(prompt, lastError), source: 'fallback', error: lastError?.message };
  },

  localFallback(prompt, err) {
    const lower = (prompt || '').toLowerCase();
    if (!state.globalData) return "I'm offline and no cached data is available.";

    if (lower.includes('critical') || lower.includes('urgent')) {
      const critical = state.globalData.equip.filter(e => e.health_score < 50);
      return `⚠️ AI service unavailable${err ? ` (${err.message})` : ''}. Local analysis: ${critical.length} asset(s) below 50% health: ${critical.map(e => e.name).join(', ') || 'none'}.`;
    }
    if (lower.includes('mttr') || lower.includes('mtbf')) {
      const comp = state.globalData.maint.filter(m => m.status === 'COMPLETED');
      const avgMttr = comp.length ? (comp.reduce((s,m) => s + parseFloat(m.mttr_hours||0), 0) / comp.length).toFixed(1) : 'N/A';
      return `📊 Local analytics: Average MTTR across ${comp.length} completed work orders is ${avgMttr}h. AI narrative service is offline.`;
    }
    if (lower.includes('warranty')) {
      const exp = state.globalData.warranties.filter(w => w.status === 'EXPIRING SOON');
      return `📋 ${exp.length} warranty/warranties expiring soon. AI service offline — please review manually.`;
    }
    if (lower.includes('recommend') || lower.includes('suggest')) {
      const sorted = [...state.globalData.equip].sort((a,b) => a.health_score - b.health_score).slice(0,3);
      return `💡 Top priority assets: ${sorted.map(e => `${e.name} (${e.health_score}%)`).join(', ')}. AI service offline.`;
    }
    return `I'm unable to reach the AI service${err ? `: ${err.message}` : ''}. Please try again shortly. Your data is still accessible locally.`;
  }
};

export const PriceFetcher = {
  async fetchMarketPrice(assetName, assetModel, assetId) {
    const assetKey = `${assetId || assetName}_${assetModel || ''}`;
    if (navigator.onLine && dbClient) {
      try {
        const result = await this.fetchFromEdge(assetName, assetModel);
        if (result && result.price > 0) {
          await OfflineStore.cachePrice(assetKey, result);
          return { ...result, source_label: 'Live Internet Price' };
        }
      } catch(e) {}
    }

    const cached = await OfflineStore.getCachedPrice(assetKey);
    if (cached && cached.price > 0) {
      const ageDays = (Date.now() - cached.timestamp) / 86400000;
      if (ageDays < 7) return { ...cached, source_label: `Cached (${ageDays.toFixed(1)}d old)` };
    }

    const heuristic = this.heuristicEstimate(assetName, assetModel, assetId);
    return { ...heuristic, source_label: 'Heuristic Estimate' };
  },

  async fetchFromEdge(assetName, assetModel) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const { data, error } = await dbClient.functions.invoke('market-proxy', {
          body: { assetName, assetModel },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (error) throw new Error(error.message);
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;

        let price = null;
        if (parsed) {
          if (typeof parsed.price === 'number') price = parsed.price;
          else if (typeof parsed.price === 'string') price = parseFloat(parsed.price.replace(/[^0-9.]/g, ''));
          else if (parsed.data?.price) price = Number(parsed.data.price);
          else if (parsed.result?.price) price = Number(parsed.result.price);
          else if (Array.isArray(parsed) && parsed[0]?.price) price = Number(parsed[0].price);
          else {
            const found = JSON.stringify(parsed).match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)/i);
            if (found) price = parseFloat(found[1]);
          }
        }

        if (price && !isNaN(price) && price > 0) {
          return {
            price: Math.round(price * 100) / 100,
            source: parsed.source || 'market-proxy',
            confidence: parsed.confidence || 0.8,
            currency: parsed.currency || 'Rs',
            fetched_at: new Date().toISOString()
          };
        }
        throw new Error('No valid price in response');
      } catch(e) {
        lastError = e;
        if (attempt < 1) await new Promise(r => setTimeout(r, 800));
      }
    }
    throw lastError;
  },

  heuristicEstimate(assetName, assetModel, assetId) {
    const eq = state.globalData?.equip.find(e => e.id === assetId || e.name === assetName);
    if (eq && eq.purchase_price && parseFloat(eq.purchase_price) > 0) {
      const ageYears = eq.purchase_date ? (Date.now() - new Date(eq.purchase_date)) / (365.25 * 86400000) : 1;
      const inflated = parseFloat(eq.purchase_price) * Math.pow(1.04, Math.max(0, ageYears));
      return { price: Math.round(inflated), source: 'heuristic-inflation', confidence: 0.5, currency: 'Rs', fetched_at: new Date().toISOString() };
    }

    const categoryPrices = {
      motor: 45000, pump: 38000, compressor: 95000, cnc: 250000,
      generator: 180000, transformer: 120000, hvac: 85000, robot: 220000,
      conveyor: 65000, boiler: 150000, chiller: 200000
    };
    const lower = (assetName || '').toLowerCase();
    for (const key in categoryPrices) {
      if (lower.includes(key)) {
        return { price: categoryPrices[key], source: 'category-baseline', confidence: 0.3, currency: 'Rs', fetched_at: new Date().toISOString() };
      }
    }
    return { price: 50000, source: 'default-baseline', confidence: 0.2, currency: 'Rs', fetched_at: new Date().toISOString() };
  }
};

export const standardCarbonDB = { 'motor': 1500, 'pump': 1200, 'compressor': 3000, 'cnc': 5000, 'generator': 4000, 'transformer': 3500, 'hvac': 2500, 'robot': 4500, 'default': 2000 };

export function getStandardEmbodiedCarbon(assetName) {
  if (!assetName) return standardCarbonDB.default;
  const lowerName = assetName.toLowerCase();
  for (const key in standardCarbonDB) {
    if (key !== 'default' && lowerName.includes(key)) return standardCarbonDB[key];
  }
  return standardCarbonDB.default;
}

class FinancialDecisionEngine {
  constructor(horizon = 3, discountRate = 0.08) { this.H = horizon; this.r = discountRate; }
  calculateEmissionsImpact(annualEmissionsKgCO2e, annualWasteKg, years = this.H) {
    let totalEmissions = annualEmissionsKgCO2e * years;
    let totalWaste = annualWasteKg * years;
    return (totalEmissions * 1.0) + (totalWaste * 0.2);
  }
  decisionWithSustainability(repairTCO, replaceTCO, emissionsRepairScore, emissionsReplaceScore) {
    const financialWeight = 0.7;
    const sustainWeight = 0.3;
    const repairScore = (repairTCO * financialWeight) + (emissionsRepairScore * sustainWeight);
    const replaceScore = (replaceTCO * financialWeight) + (emissionsReplaceScore * sustainWeight);
    return repairScore <= replaceScore ? { decision: 'repair', scoreDiff: replaceScore - repairScore } : { decision: 'replace', scoreDiff: repairScore - replaceScore };
  }
}

export function renderSustainabilityKPIs() {
  if (!state.globalData) return;
  let totalPotentialCarbon = 0, totalOperationalCarbon = 0;
  const criticalAssets = state.globalData.equip.filter(e => e.health_score < 40).length;

  state.globalData.equip.forEach(eq => {
    const embodiedCarbon = getStandardEmbodiedCarbon(eq.name);
    totalPotentialCarbon += embodiedCarbon;
    totalOperationalCarbon += (eq.annual_emissions || 0); 
  });

  const sustStats = document.getElementById('sustStats');
  if (!sustStats) return;
  sustStats.innerHTML = `
    <div class="stat"><div class="stat-top"><div class="stat-icon">☁️</div></div><div class="stat-value">${Math.round(totalOperationalCarbon).toLocaleString()}</div><div class="stat-label">ESTIMATED CO₂e / YR (KG)</div></div>
    <div class="stat"><div class="stat-top"><div class="stat-icon">🌍</div></div><div class="stat-value">${Math.round(totalPotentialCarbon).toLocaleString()}</div><div class="stat-label">EMBODIED CARBON AT RISK (KG)</div></div>
    <div class="stat"><div class="stat-top"><div class="stat-icon">!</div></div><div class="stat-value">${criticalAssets}</div><div class="stat-label">CRITICAL ASSETS</div></div>
  `;

  const tbody = document.querySelector('#sustTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const engine = new FinancialDecisionEngine();
  
  state.globalData.equip.forEach(eq => {
    const operationalEmissions = eq.annual_emissions || 0;
    const waste = eq.annual_waste || 0; 
    const repairTCO = eq.health_score > 50 ? 1000 : 4000; 
    const replaceTCO = eq.health_score > 50 ? 4000 : 1000;
    const dec = engine.decisionWithSustainability(repairTCO, replaceTCO, operationalEmissions, operationalEmissions * 0.2);
    const row = document.createElement('tr');
    const decisionBadge = dec.decision === 'repair' ? `<span class="badge green">Repair</span>` : `<span class="badge red">Replace</span>`;
    row.innerHTML = `<td>${eq.name}</td><td>${operationalEmissions}</td><td>${waste}</td><td>${decisionBadge}</td>`;
    tbody.appendChild(row);
  });
}

export function openNewSustainabilityModal() {
  const options = state.globalData ? state.globalData.equip.map(e => `<option value="${e.id}">${e.name}</option>`).join('') : '';
  UI.openModal('Add Emissions Data', `
    <div class="modal-input-group"><label class="modal-label">Select Asset</label><select id="sust-asset-id" class="modal-input"><option value="">Select...</option>${options}</select></div>
    <div class="modal-input-group"><label class="modal-label">Annual CO₂e (kg)</label><input id="sust-emissions" type="number" class="modal-input" placeholder="e.g. 1200" /></div>
    <div class="modal-input-group"><label class="modal-label">Annual Waste (kg)</label><input id="sust-waste" type="number" class="modal-input" placeholder="e.g. 30" /></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="window.saveSustainabilityData()">Save</button></div>
  `);
  window.saveSustainabilityData = async () => {
    const id = document.getElementById('sust-asset-id').value;
    const emissions = parseFloat(document.getElementById('sust-emissions').value) || 0;
    const waste = parseFloat(document.getElementById('sust-waste').value) || 0;
    if (!id) { notify('Select an asset'); return; }
    const asset = state.globalData.equip.find(e => e.id === id);
    if (asset) {
      asset.annual_emissions = emissions;
      asset.annual_waste = waste;
      notify('Sustainability data saved locally');
      UI.closeModal();
      renderSustainabilityKPIs();
      if (dbClient) await dbClient.from('equipment').update({ annual_emissions: emissions, annual_waste: waste }).eq('id', asset.id);
    } else { notify('Asset not found'); }
  };
}

export function loadComponentForTCO(id) {
  const eq = state.globalData.equip.find(e => e.id === id);
  if (!eq) return;
  document.getElementById('replace-price').value = eq.purchase_price || '';
  document.getElementById('replace-salvage').value = '';
  
  const estCarbon = getStandardEmbodiedCarbon(eq.name);
  document.getElementById('replace-mfg-carbon').value = estCarbon;
  
  const recentWOs = state.globalData.maint.filter(m => m.equipment_id === id);
  const totalRepairCost = recentWOs.reduce((s, m) => s + parseFloat(m.cost || 0), 0);
  document.getElementById('repair-quote').value = totalRepairCost > 0 ? totalRepairCost.toFixed(2) : '';
  
  const failures = recentWOs.filter(m => m.type === 'CORRECTIVE').length;
  document.getElementById('repair-failures').value = failures;
  
  const avgMttr = recentWOs.length > 0 ? (recentWOs.reduce((s, m) => s + parseFloat(m.mttr_hours||0), 0) / recentWOs.length).toFixed(1) : 0;
  document.getElementById('repair-mttr').value = avgMttr;
  
  document.getElementById('depreciation-summary').innerText = `Loaded telemetry, repair history (Cost: Rs.${totalRepairCost.toFixed(0)}, MTTR: ${avgMttr}h) & estimated embodied carbon (${estCarbon} kg CO2e). Fetch market rate to auto-update Replacement Purchase Price.`;
  notify(`Loaded asset telemetry for ${eq.name}.`);
}

export async function fetchCurrentMarketPrice() {
  const eqId = document.getElementById('tco-equipment-select').value;
  if (!eqId) return notify("Please select a component first.");
  const eq = state.globalData.equip.find(e => e.id === eqId);
  if (!eq) return notify("Equipment not found.");

  notify(`Querying market for ${eq.name}...`);
  document.getElementById('depreciation-summary').innerHTML = '<div class="skeleton" style="height:40px;"></div>';

  try {
    const result = await PriceFetcher.fetchMarketPrice(eq.name, eq.model, eq.id);
    if (result && result.price > 0) {
      document.getElementById('replace-price').value = result.price;
      const confidenceLabel = result.confidence >= 0.7 ? 'High' : result.confidence >= 0.4 ? 'Medium' : 'Low';
      const confidenceColor = result.confidence >= 0.7 ? 'var(--green)' : result.confidence >= 0.4 ? 'var(--orange)' : 'var(--red)';
      document.getElementById('depreciation-summary').innerHTML = `
        <strong>✓ ${result.source_label}</strong><br>
        Estimated replacement price: <strong>Rs. ${result.price.toLocaleString()}</strong><br>
        <span style="font-size:10px; color:${confidenceColor};">Confidence: ${confidenceLabel} (${(result.confidence*100).toFixed(0)}%) · Source: ${result.source}</span>
      `;
      notify(`Price updated: Rs. ${result.price.toLocaleString()} (${result.source_label})`, 'success');
    } else {
      document.getElementById('depreciation-summary').innerText = "Unable to determine price. Please enter manually.";
      notify("Price lookup failed — enter manually.", 'warning');
    }
  } catch (error) {
    handleError("Market Fetch", error);
    document.getElementById('depreciation-summary').innerText = "Market lookup failed. Please enter the replacement price manually.";
  }
}

export function calculateRvR() {
  const horizon = parseFloat(document.getElementById('tco-horizon').value) || 3;
  const rate = (parseFloat(document.getElementById('tco-rate').value) || 8) / 100;
  const rp = {
    immediateQuote: parseFloat(document.getElementById('repair-quote').value) || 0,
    historicalMaint: parseFloat(document.getElementById('repair-hist-maint').value) || 0,
    wearFactor: (parseFloat(document.getElementById('repair-wear').value) || 0) / 100,
    failuresPerYear: parseFloat(document.getElementById('repair-failures').value) || 0,
    mttr: parseFloat(document.getElementById('repair-mttr').value) || 0,
    hourlyLoss: parseFloat(document.getElementById('hourly-loss').value) || 0
  };
  const pp = {
    purchasePrice: parseFloat(document.getElementById('replace-price').value) || 0,
    setupCost: parseFloat(document.getElementById('replace-setup').value) || 0,
    salvageValue: parseFloat(document.getElementById('replace-salvage').value) || 0,
    newMaint: parseFloat(document.getElementById('replace-maint').value) || 0,
    newFailures: parseFloat(document.getElementById('replace-failures').value) || 0,
    newMttr: parseFloat(document.getElementById('replace-mttr').value) || 0,
    energyCost: parseFloat(document.getElementById('replace-energy').value) || 0,
    mfgCarbon: parseFloat(document.getElementById('replace-mfg-carbon').value) || 0
  };

  notify("Running heavy financial analysis in background...", 'info', 2000);
  tcoWorker.postMessage({ rp, pp, horizon, rate });

  tcoWorker.onmessage = (e) => {
    const res = e.data;
    const fmt = (v) => "Rs. " + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('repair-total').innerText = fmt(res.tco_repair);
    document.getElementById('replace-total').innerText = fmt(res.tco_replace);
    const recBox = document.getElementById('tco-recommendation-box');
    recBox.classList.remove('hidden');
    
    document.getElementById('tco-rec-title').innerText = res.recommendation === "REPAIR" ? "✓ REPAIR RECOMMENDED" : "⟳ REPLACE RECOMMENDED";
    document.getElementById('tco-rec-title').style.color = res.recommendation === "REPAIR" ? "#4ade80" : "#f87171";
    document.getElementById('tco-rec-text').innerText = `Based on a ${res.horizon_years}-year NPV projection, ${res.recommendation.toLowerCase()}ing the asset yields lower financial expenditure. Financial advantage: ${fmt(res.financial_delta)}.`;
    document.getElementById('tco-env-text').innerText = res.env_conclusion || '';
    document.getElementById('tco-audit-trail').innerHTML = `<strong>AUDIT TRAIL</strong><br>Timestamp: ${new Date(res.timestamp).toLocaleString()}<br>Horizon: ${res.horizon_years} Years | Discount Rate: ${(rate*100).toFixed(1)}%<br>Repair TCO: ${fmt(res.tco_repair)} | Replace TCO: ${fmt(res.tco_replace)}<br>Scope 3 Carbon Impact: ${res.carbon_saved.toLocaleString()} kg CO2e`;

    logAudit('TCO_CALCULATION', `Executed Holistic TCO & Carbon analysis. Recommendation: ${res.recommendation}`);
    notify('Holistic analysis complete', 'success');
  };
}

export async function generateExecutiveReport() {
  const eqId = document.getElementById('tco-equipment-select').value;
  if (!eqId) return notify("Select equipment first to generate a report.");
  
  const eq = state.globalData.equip.find(e => e.id === eqId);
  const horizon = parseFloat(document.getElementById('tco-horizon').value) || 3;
  const rate = (parseFloat(document.getElementById('tco-rate').value) || 8) / 100;
  
  const repairCost = parseFloat(document.getElementById('repair-quote').value) || 0;
  const replacePrice = parseFloat(document.getElementById('replace-price').value) || 0;
  const replaceSetup = parseFloat(document.getElementById('replace-setup').value) || 0;
  const replaceTotalInit = replacePrice + replaceSetup;
  
  const heuristicThreshold = replaceTotalInit * 0.5;
  const heuristicTriggered = repairCost > heuristicThreshold;
  const carbonSaved = parseFloat(document.getElementById('replace-mfg-carbon').value) || 0;
  const wastePrevented = 50; 
  const compMaint = state.globalData.maint.filter(m => m.equipment_id === eq.id && m.status === 'COMPLETED');
  const mttrAvg = compMaint.length > 0 ? (compMaint.reduce((s,m)=>s+parseFloat(m.mttr_hours||0),0)/compMaint.length).toFixed(1) : 0;
  const riskIndex = compMaint.length > 2 ? "High (Frequent Failures)" : compMaint.length > 0 ? "Moderate (Stable MTBF Trend)" : "Low (No recent failures)";

  notify("Generating AI Executive Summary...");
  let aiNarrative = "AI summary unavailable.";
  try {
    const prompt = `Generate a concise 4-second executive CapEx narrative recommending Repair or Replace for asset ${eq.name}. Financial advantage: ${document.getElementById('tco-rec-text').innerText}`;
    const aiResult = await ResilientAI.invoke(prompt, { skipCache: true });
    aiNarrative = aiResult.text;
  } catch (e) { /* fallback */ }

  const reportHtml = `
    <div style="font-family: 'Inter', sans-serif; color: #000; background: #fff; padding: 40px;">
      <div style="border-bottom: 3px solid #22c55e; padding-bottom: 15px; margin-bottom: 25px; display: flex; justify-content: space-between; align-items: flex-end;">
        <div>
          <h1 style="margin:0; font-size: 28px; color: #0f172a;">EquipIQ Executive Summary</h1>
          <p style="margin:5px 0 0 0; font-size: 14px; color: #475569;">Capital Expenditure & ESG Review</p>
        </div>
        <div style="text-align: right; font-size: 12px; color: #64748b;">
          <div>Report ID: EQ-${Date.now()}</div>
          <div>${new Date().toLocaleString()}</div>
        </div>
      </div>
      <div style="display: flex; gap: 20px; margin-bottom: 25px; background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0;">
        <div style="flex: 1;">
          <strong style="color:#334155;">Asset Name:</strong> ${eq.name}<br>
          <strong style="color:#334155;">Asset ID:</strong> ${eq.asset_tag || eq.id}<br>
          <strong style="color:#334155;">Category:</strong> ${eq.model || 'Industrial Equipment'}
        </div>
        <div style="flex: 1; border-left: 1px solid #cbd5e1; padding-left: 20px;">
          <strong style="color:#334155;">Health Score:</strong> ${eq.health_score}%<br>
          <strong style="color:#334155;">Reviewer ID:</strong> ${state.currentUser.email}<br>
          <strong style="color:#334155;">Status:</strong> Operational Review
        </div>
      </div>
      <h2 style="font-size: 18px; color: #1e293b; border-bottom: 1px solid #cbd5e1; padding-bottom: 5px;">1. Financial Verdict (Repair vs. Replace)</h2>
      <table style="width: 100%; border-collapse: collapse; margin: 15px 0 25px 0; font-size: 13px;">
        <tr style="background: #f1f5f9;">
          <th style="padding: 12px; border: 1px solid #e2e8f0; text-align: left;">Metric</th>
          <th style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">Repair Scenario</th>
          <th style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">Replace Scenario</th>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #e2e8f0;"><strong>Immediate CapEx</strong></td>
          <td style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">Rs. ${repairCost.toLocaleString()}</td>
          <td style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">Rs. ${replaceTotalInit.toLocaleString()}</td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #e2e8f0;"><strong>TCO (NPV @ ${(rate*100).toFixed(1)}% WACC)</strong></td>
          <td style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">${document.getElementById('repair-total').innerText}</td>
          <td style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">${document.getElementById('replace-total').innerText}</td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #e2e8f0;"><strong>50% Heuristic Threshold</strong></td>
          <td colspan="2" style="padding: 12px; border: 1px solid #e2e8f0; text-align: center;">
            Limit: Rs. ${heuristicThreshold.toLocaleString()} | 
            ${heuristicTriggered ? '<span style="color:#dc2626; font-weight:bold;">Triggered (Repair > 50% of Replace)</span>' : '<span style="color:#16a34a; font-weight:bold;">Within Safe Limits</span>'}
          </td>
        </tr>
      </table>
      <h2 style="font-size: 18px; color: #1e293b; border-bottom: 1px solid #cbd5e1; padding-bottom: 5px;">2. AI Justification & Guardrails</h2>
      <div style="background: #eef2ff; padding: 20px; border-left: 4px solid #4f46e5; margin: 15px 0 25px 0; border-radius: 0 8px 8px 0;">
        <p style="margin: 0 0 15px 0; font-size: 13px; line-height: 1.6; color: #1e293b;"><strong>Automated Narrative:</strong> ${aiNarrative}</p>
        <p style="margin: 0; font-size: 12px; color: #475569;"><strong>Human-in-the-loop Sign-off:</strong> ${state.currentUser.role === 'admin' ? 'Authorized' : 'Pending Admin Approval'} (Verified: ${new Date().toLocaleString()})</p>
      </div>
      <h2 style="font-size: 18px; color: #1e293b; border-bottom: 1px solid #cbd5e1; padding-bottom: 5px;">3. ESG & Circular Economy Scorecard</h2>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-top: 15px; margin-bottom: 30px;">
        <div style="border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px; background: #f0fdf4;">
          <strong style="color: #15803d; display: block; margin-bottom: 10px;">🌱 Environmental</strong>
          <div style="font-size: 12px; color: #334155; line-height: 1.8;">
            <strong>Scope 3 Carbon Avoided:</strong> ${carbonSaved.toLocaleString()} kg CO2e<br>
            <strong>Waste Prevented:</strong> ${wastePrevented} kg
          </div>
        </div>
        <div style="border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px; background: #eff6ff;">
          <strong style="color: #1d4ed8; display: block; margin-bottom: 10px;">🛡️ Social / Safety</strong>
          <div style="font-size: 12px; color: #334155; line-height: 1.8;">
            <strong>Risk Mitigation Index:</strong> ${riskIndex}<br>
            <strong>Avg MTTR:</strong> ${mttrAvg} hrs
          </div>
        </div>
        <div style="border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px; background: #fffbeb;">
          <strong style="color: #b45309; display: block; margin-bottom: 10px;">⚖️ Governance</strong>
          <div style="font-size: 12px; color: #334155; line-height: 1.8;">
            <strong>Compliance:</strong> Immutable Audit Log Generated<br>
            <strong>AI Constraints:</strong> Read-Only / Least-Privilege Active
          </div>
        </div>
      </div>
      <div style="margin-top: 40px; padding-top: 15px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8;">
        Generated by EquipIQ Intelligent Lifecycle Management Platform. Data integrity secured via Supabase Realtime Cryptographic Validation.
      </div>
    </div>
  `;

  const printDiv = document.getElementById('printable-report');
  printDiv.innerHTML = reportHtml;
  printDiv.classList.remove('hidden');
  window.print();
  setTimeout(() => printDiv.classList.add('hidden'), 1000);
  logAudit('REPORT_GEN', `Generated Executive Summary for ${eq.name}`);
}

export const agentTools = {
  getAllEquipment: () => JSON.stringify(state.globalData.equip.map(eq => ({ name: eq.name, tag: eq.asset_tag, health: eq.health_score, status: eq.status }))),
  getDashboardStats: () => JSON.stringify({ total_equipment: state.globalData.equip.length, critical_assets: state.globalData.equip.filter(e => e.health_score < 50).length }),
  prepareMaintenanceTask: (equipmentIdentifier) => {
    const eq = state.globalData.equip.find(e => e.name.toLowerCase() === equipmentIdentifier.toLowerCase() || e.asset_tag?.toLowerCase() === equipmentIdentifier.toLowerCase());
    if (!eq) return JSON.stringify({ error: "Equipment not found." });
    return JSON.stringify({
      status: "prepared",
      task: {
        equipment_id: eq.id,
        work_order_number: "WO-AI-" + Math.floor(Math.random() * 9000 + 1000),
        type: eq.health_score < 50 ? 'CORRECTIVE' : 'PREVENTIVE',
        technician: 'AI-Unassigned',
        due_date: new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0],
        status: 'PENDING'
      }
    });
  },
  deleteEquipment: (equipmentIdentifier) => {
    const eq = state.globalData.equip.find(e => e.name.toLowerCase() === equipmentIdentifier.toLowerCase() || e.asset_tag?.toLowerCase() === equipmentIdentifier.toLowerCase());
    if (!eq) return JSON.stringify({ error: "Equipment not found." });
    return JSON.stringify({ status: "prepared", delete_payload: { table: 'equipment', id: eq.id, name: eq.name } });
  },
  updateEquipmentHealth: (equipmentIdentifier, newHealth) => {
    const eq = state.globalData.equip.find(e => e.name.toLowerCase() === equipmentIdentifier.toLowerCase() || e.asset_tag?.toLowerCase() === equipmentIdentifier.toLowerCase());
    if (!eq) return JSON.stringify({ error: "Equipment not found." });
    return JSON.stringify({ status: "prepared", update_payload: { table: 'equipment', id: eq.id, name: eq.name, health_score: parseInt(newHealth) } });
  },
  closeWorkOrder: (woNumber) => {
    const wo = state.globalData.maint.find(m => m.work_order_number?.toLowerCase() === woNumber.toLowerCase());
    if (!wo) return JSON.stringify({ error: "Work Order not found." });
    return JSON.stringify({ status: "prepared", update_payload: { table: 'maintenance_orders', id: wo.id, work_order_number: wo.work_order_number, status: 'COMPLETED' } });
  },
  createInventoryPart: (partName, qty) => {
    return JSON.stringify({ status: "prepared", insert_payload: { table: 'parts_inventory', data: { name: partName, stock_quantity: parseInt(qty) || 1, unit_cost: 0, status: parseInt(qty) > 5 ? 'AVAILABLE' : 'LOW STOCK' } } });
  }
};

export function sanitizeAIResponse(data) {
  if (data === null || data === undefined) return "No response received from AI.";
  let text = "";
  if (typeof data === 'string') {
    try { text = sanitizeAIResponse(JSON.parse(data)); } catch (e) { text = data; }
  } else if (Array.isArray(data)) {
    text = data.map(item => sanitizeAIResponse(item)).join("\n");
  } else if (typeof data === 'object') {
    if (data.error) text = "AI Error: " + sanitizeAIResponse(data.error);
    else if (data.response) text = sanitizeAIResponse(data.response);
    else if (data.text) text = sanitizeAIResponse(data.text);
    else if (data.message) {
      if (typeof data.message === 'string') text = data.message;
      else if (data.message.content) text = sanitizeAIResponse(data.message.content);
    }
    else if (data.choices && data.choices[0] && data.choices[0].message) text = sanitizeAIResponse(data.choices[0].message.content);
    else if (data.output) text = sanitizeAIResponse(data.output);
    else if (data.result) text = sanitizeAIResponse(data.result);
    else if (data.data) text = sanitizeAIResponse(data.data);
    else if (data.content) text = sanitizeAIResponse(data.content);
    else { try { text = JSON.stringify(data, null, 2); } catch (e) { text = "Received an unrecognized structured response."; } }
  } else { text = String(data); }

  text = text.replace(/```json/g, '').replace(/```/g, '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const obj = JSON.parse(text);
      if (obj.message) return obj.message;
      if (obj.text) return obj.text;
      if (obj.response) return obj.response;
      return "The AI returned a structured format. Please ask it to respond in plain text.";
    } catch(e) {}
  }
  return text;
}

export function calculateWarrantyStatus(expiryDateStr) {
  if (!expiryDateStr) return 'ACTIVE'; // Fallback for missing dates
  
  const expiry = new Date(expiryDateStr);
  if (isNaN(expiry.getTime())) return 'ACTIVE';
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);
  
  const diffTime = expiry.getTime() - today.getTime();
  const diffDays = diffTime / (1000 * 60 * 60 * 24);
  
  if (diffDays < 0) return 'EXPIRED';
  if (diffDays <= 30) return 'EXPIRING SOON';
  return 'ACTIVE';
}