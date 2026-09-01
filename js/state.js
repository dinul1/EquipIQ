// Centralized application state
export const state = {
    globalData: null,
    currentUser: null,
    extractedOCRText: "",
    qrStream: null,
    woPartsUsed: [],
    chartRenderStatus: { dashboard: false, analytics: false },
    myCostChart: null,
    myFailureChart: null,
    myComplianceChart: null,
    myEsgChart: null
};

export const SUPABASE_URL = 'https://rqajjdsywpvjjlptsnha.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_OGdxE3LmpXuWCa8LErCymA_NDpouldp';

export let dbClient = null;

export function initSupabase() {
    if (typeof window.supabase !== 'undefined') {
        dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    return dbClient;
}

export function logAudit(action, details) {
    if (!dbClient || !state.currentUser) return;
    try { dbClient.from('audit_logs').insert([{ user_email: state.currentUser.email, action, details }]); } catch (e) {}
}

export function handleError(module, error) {
    console.error(`[${module}] Error:`, error);
    notify(`[${module}] Error: ${error.message || "Unknown failure"}`);
}