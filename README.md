# ◈ EquipIQ | Sustainable CapEx & Lifecycle Intelligence

![JavaScript](https://img.shields.io/badge/JavaScript-ES6%20Modules-F7DF1E?logo=javascript&logoColor=black)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-Offline%20First-5A0FC8?logo=pwa&logoColor=white)
![AI](https://img.shields.io/badge/AI-Agentic%20Execution-8B5CF6?logo=openai&logoColor=white)

> **Sustainable CapEx & Lifecycle Intelligence Platform.** EquipIQ merges financial TCO analysis with Scope 3 carbon tracking to optimize industrial asset lifecycles. It empowers industries to protect the planet while maximizing CapEx efficiency through sustainable maintenance, offline-first architecture, and AI-driven ESG insights.

---

## 🌟 Core Features

### 📊 Financial & ESG Intelligence
* **Holistic TCO Engine:** Runs NPV projections in a background Web Worker to compare "Repair Status Quo" vs. "Replacement Scenario" without blocking the UI.
* **Scope 3 Carbon Tracking:** Calculates embodied carbon avoided by repairing assets instead of replacing them.
* **Executive Report Generation:** Generates printable, AI-narrated CapEx & ESG executive summaries with human-in-the-loop sign-offs.

### 🤖 Agentic AI & Automation
* **Predictive Maintenance (Next-Gen):** The Lifecycle Engine uses linear regression on historical MTBF trends to project the exact number of days until the next failure (e.g., "Predicted: 25d").
* **Automated AI Explanations:** If an asset's health score drops significantly (>20 points), a background AI request triggers to generate a narrative explaining the cause, displayed directly in the UI.
* **Zero-Touch AI OCR:** Drag & drop receipts into the Document hub. Tesseract WASM extracts raw text, and the AI parses it into strict JSON (Supplier, Date, Price) to auto-populate the database link.
* **Sandboxed AI Agent:** Can prepare maintenance tasks, close work orders, adjust health scores, and delete assets. Destructive actions require explicit admin approval via a Human-in-the-Loop UI.
* **Resilient AI:** Falls back to local heuristic algorithms when offline or if the Edge Function times out.
* **AI Email Stats:** Admins can request the AI to generate and draft system stat reports directly into their email client.
* **Automatic MTTR Detector:** Automatically calculates Mean Time To Repair (MTTR) based on the work order creation date vs. completion date.
* **Auto-Lifecycle Health:** Equipment health scores and operational states (`OPERATIONAL`, `MAINTENANCE`, `CRITICAL`) are auto-generated read-only fields based on MTBF, MTTR, age, and PM compliance.

### 📱 Offline-First PWA & Enterprise UX
* **Role-Based Access Control (RBAC):** Granular permissions for `Admin`, `Technician`, and `Viewer` roles. Technicians are restricted from seeing financial data or deletion buttons.
* **Universal Data Export:** One-click CSV exports for Maintenance, Equipment, Inventory, and Audit Logs (flattened to handle nested DB relations), plus jsPDF generation for individual Work Orders.
* **QuaggaJS Barcode Scanner:** Technicians can use their device camera to scan 1D barcodes on parts. If the part exists, it opens the edit modal; if not, it opens the "Add Part" modal with the barcode pre-filled.
* **Web Push Notifications:** Admins receive native OS notifications for overdue work orders, even if the app tab is in the background.
* **Event Delegation Architecture:** Strictly scoped ES6 modules using `data-action` HTML attributes—eliminating the insecure `window.*` global function anti-pattern.
* **Updatable Service Worker (v3.0):** Aggressively caches core assets, CDN scripts (Chart.js, Tesseract), and Supabase API responses. When offline, graphs and tables render seamlessly from cached DB data.
* **Background Sync:** Offline database mutations (POST/PATCH/DELETE) are queued in IndexedDB and automatically synced when the network is restored, with conflict-reversion handling.
* **QR Code Generation:** Auto-generates printable QR codes for assets. Scanning a code opens a read-only "Master Properties" modal.
* **Drag & Drop OCR Ingestion:** Uses Tesseract.js WASM workers to extract text from dragged receipts and invoices, linking them directly to equipment assets.

---

## 🏗️ Tech Stack

| Category | Technology |
| :--- | :--- |
| **Frontend** | Vanilla JavaScript (ES6 Modules), HTML5, CSS3 (Grid/Flexbox) |
| **Backend/DB** | Supabase (PostgreSQL, Auth, Realtime Subscriptions) |
| **AI** | OpenAI via Supabase Edge Functions |
| **PWA** | Service Workers, IndexedDB, Background Sync API |
| **Libraries** | Chart.js (Analytics), Tesseract.js (OCR), QuaggaJS (Barcodes), jsPDF (Reports) |

---

## 📂 Project Architecture

The application is fully modularized to eliminate monolithic file fatigue.

```text
├── index.html              # Main application shell
├── styles.css              # Global UI and responsive styles
├── sw.js                   # Service Worker (Caching, Offline DB, Sync)
├── manifest.json           # PWA configuration
└── js/
    ├── app.js              # Entry point, Routing, Auth, Charts, Bootstrap
    ├── router.js           # Global Event Delegation & CSV/PDF Export Logic
    ├── state.js            # Global state management & Supabase init
    ├── ui.js               # DOM helpers, Toasts, Modals
    ├── offline.js          # IndexedDB persistence layer
    ├── analytics.js        # Lifecycle Engine, TCO Web Worker, AI Tools, ESG logic
    ├── crud.js             # Equipment, Work Order, Warranty, Inventory modal logic
    └── ocr.js              # Tesseract WASM, Drag & Drop, QuaggaJS Barcode Scanner
```

---

## 🚀 Getting Started

### 1. Prerequisites
* A modern web browser.
* A [Supabase](https://supabase.com/) account (free tier works).

### 2. Database Setup
Run the following SQL in your Supabase SQL Editor to create the required schema:

```sql
CREATE TABLE public.equipment (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  asset_tag text NOT NULL UNIQUE,
  model text,
  serial_number text,
  status text DEFAULT 'OPERATIONAL'::text,
  health_score integer DEFAULT 100,
  purchase_date date,
  purchase_price numeric DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  category text DEFAULT 'General'::text,
  annual_emissions numeric DEFAULT 0,
  annual_waste numeric DEFAULT 0,
  CONSTRAINT equipment_pkey PRIMARY KEY (id)
);
CREATE TABLE public.maintenance_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  equipment_id uuid,
  work_order_number text NOT NULL UNIQUE,
  type text,
  technician text,
  due_date date,
  status text DEFAULT 'PENDING'::text,
  cost numeric DEFAULT 0,
  mttr_hours numeric DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  labor_cost numeric DEFAULT 0,
  parts_cost numeric DEFAULT 0,
  parts_used jsonb DEFAULT '[]'::jsonb,
  failure_reason text,
  completed_at timestamp with time zone,
  CONSTRAINT maintenance_orders_pkey PRIMARY KEY (id),
  CONSTRAINT maintenance_orders_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id)
);
CREATE TABLE public.warranties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  equipment_id uuid,
  supplier text,
  start_date date,
  expiry_date date,
  status text DEFAULT 'ACTIVE'::text,
  claim_value numeric DEFAULT 0,
  terms text,
  CONSTRAINT warranties_pkey PRIMARY KEY (id),
  CONSTRAINT warranties_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id)
);
CREATE TABLE public.parts_inventory (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  part_number text,
  equipment_id uuid,
  stock_quantity integer DEFAULT 0,
  unit_cost numeric DEFAULT 0,
  status text DEFAULT 'AVAILABLE'::text,
  CONSTRAINT parts_inventory_pkey PRIMARY KEY (id),
  CONSTRAINT parts_inventory_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id)
);
CREATE TABLE public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  equipment_id uuid,
  file_url text,
  extracted_text text,
  extracted_data jsonb,
  is_verified boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT documents_pkey PRIMARY KEY (id),
  CONSTRAINT documents_equipment_id_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(id)
);
CREATE TABLE public.audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_email text DEFAULT 'guest'::text,
  action text NOT NULL,
  details text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  email text,
  role text DEFAULT 'viewer'::text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);
```

### 3. Installation
1. Clone the repo:
   ```bash
   git clone https://github.com/your-username/equipiq.git
   cd equipiq
   ```
2. Update `js/state.js` with your Supabase URL and Anon Key:
   ```javascript
   export const SUPABASE_URL = 'https://your-project.supabase.co';
   export const SUPABASE_KEY = 'your-anon-key';
   ```
3. Serve the files using any local server (Live Server extension in VS Code works great) or host on GitHub Pages/Netlify.

---

## 🧠 How It Works

### The Lifecycle Engine
The `LifecycleEngine` in `analytics.js` dynamically calculates the health score for every asset. It takes into account:
* **MTTR (Mean Time To Repair):** How long repairs take.
* **MTBF (Mean Time Between Failures):** Frequency of corrective maintenance.
* **Age:** Depreciation of the asset over time.
* **PM Compliance:** Percentage of completed Preventive Maintenance tasks.
* **Predictive Failure Projection:** Uses linear regression on MTBF intervals to estimate the exact date of the next failure.

Based on the score, it automatically forces the equipment state:
* `< 40` = `CRITICAL`
* `< 75` = `MAINTENANCE`
* `>= 75` = `OPERATIONAL`

### Offline Synchronization
When a user makes a change while offline, the `sw.js` service worker intercepts the failed `POST`/`PATCH` request, stores it in an IndexedDB queue (`mutations`), and synthesizes a `201 Created` response. The UI updates instantly. When connectivity is restored, the Background Sync API flushes the queue to Supabase.

---

## 📄 License
This project is licensed under the MIT License.

---

## 👨‍💻 About the Designer

**Dinul Vithanage**
*EquipIQ is an Intelligent Lifecycle Management Platform integrating IoT, AI, and ESG metrics to optimize industrial asset performance. Dinul specializes in building resilient, full-stack enterprise applications with a focus on offline-first architectures, AI integration, and sustainable engineering practices.*

🌐 **Portfolio:** [dinulvithanage.infinityfree.me](https://dinulvithanage.infinityfree.me)
```
