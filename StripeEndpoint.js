/******************************
 * Stripe Webhook → Google Sheet (Apps Script)
 *
 * This script receives Stripe webhook events and performs an UPSERT (Update
 * or Insert) operation on a Google Sheet row, using the Payment Intent ID
 * (pi_...) as the unique lookup key. This correctly handles multiple events
 * (e.g., payment_intent.succeeded, charge.succeeded, checkout.session.*)
 * related to the same payment.
 *
 * Sheet columns (row 1):
 *   Client Name | Client Email | Paid At | Access Code | Plugin Name | Framer User ID | Event ID
 *
 * **CRITICAL MAPPING:**
 * - Access Code column: Stores Receipt Number or Invoice ID.
 * - Event ID column: Stores Payment Intent ID (pi_...) and is the lookup key for upserting.
 ******************************/

// ===== CONFIG =====

/**
 * Google Sheet configuration
 *
 * - SPREADSHEET_ID:
 *     Open your target Google Sheet → URL looks like:
 *     https://docs.google.com/spreadsheets/d/<THIS_IS_YOUR_ID>/edit
 *     Copy that ID string and paste it below.
 *
 * - SHEET_NAME:
 *     Name of the worksheet/tab where purchases will be stored (e.g. "Purchases").
 */
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
const SHEET_NAME     = 'Purchases';

/**
 * Mapping Stripe Product IDs (prod_...) to human-readable names.
 *
 * - You can find your product IDs in the Stripe Dashboard (Products → click a product).
 * - Add entries like:
 *     'prod_ABC123...': 'My Plugin Name',
 * - If you don’t need product mapping, you can leave this as an empty object {}.
 */
const PRODUCT_ID_TO_PLUGIN = {
  // 'prod_XXXXXXXXXXXXXX': 'Plugin One',
  // 'prod_YYYYYYYYYYYYYY': 'Plugin Two',
};

/**
 * Optional: Simple shared-secret protection.
 *
 * - In Apps Script: Project Settings → Script properties → add key "WEBHOOK_TOKEN".
 * - Value can be any long random string.
 * - In your Stripe webhook URL, append "?token=YOUR_SECRET".
 * - If you don't want token auth, leave this unset or null.
 */
const WEBHOOK_TOKEN = PropertiesService.getScriptProperties().getProperty('WEBHOOK_TOKEN') || null;


// ===== Routes =====

/**
 * Main function for handling incoming Stripe webhook requests (HTTP POST).
 * @param {Object} e The event object containing the webhook payload.
 * @returns {GoogleAppsScript.Content.TextOutput} A JSON response.
 */
function doPost(e) {
  let eventType = 'unknown_type';
  let evtId = 'unknown_id';
  
  try {
    if (!e || !e.postData) throw new Error('No POST body');

    // 1) Optional URL token auth (uncomment to use)
    /*
    if (WEBHOOK_TOKEN) {
      const okToken = e.parameter && e.parameter.token === WEBHOOK_TOKEN;
      if (!okToken) throw new Error('Invalid webhook token');
    }
    */

    // 2) Parse the incoming Stripe event (handles JSON + form-encoded)
    const incoming = parseIncoming(e);
    evtId = String(incoming.id || '');
    if (!evtId.startsWith('evt_')) {
      return json({ ok: true, skipped: 'No valid event ID' });
    }
    
    // 3) Normalize the event into a "row object" for the sheet
    eventType = String(incoming.type || 'unknown_type').trim();
    const row = normalizeStripeEventToSheetRow(incoming); 

    // If normalization fails (e.g., unhandled event type, or not succeeded), skip.
    if (!row) {
      Logger.log(JSON.stringify({
        handled_event: evtId,
        type: eventType,
        skipped: 'Normalization failed/unhandled event type or status'
      }));
      return json({ ok: true, skipped: eventType });
    }
    
    // 4) Implement concurrency lock to prevent race conditions during UPSERT
    const lock = LockService.getScriptLock();
    // Try to acquire lock for up to 10 seconds
    const lockAcquired = lock.tryLock(10000); 

    if (!lockAcquired) {
      // Another webhook execution is currently writing to the sheet.
      Logger.log(JSON.stringify({ 
        handled_event: evtId, 
        type: eventType, 
        skipped: 'Lock contention: Skipping due to concurrent sheet access.' 
      }));
      return json({ ok: true, skipped: 'Lock Contention (Processed by another event)' });
    }

    // 5) Lock acquired, proceed with UPSERT
    try {
      const result = upsertPurchase(row);
      Logger.log(JSON.stringify({ handled_event: evtId, type: eventType, write: result }));

      // Successful processing returns ok: true
      return json({ ok: true, mode: result.mode, receipt_number: result.access_code, pi_id: result.pi_id });
        
    } finally {
      // CRITICAL: Ensure the lock is always released
      lock.releaseLock();
    }

  } catch (err) {
    // Log the error for internal debugging
    Logger.log('ERROR doPost - Event ' + evtId + ' (' + eventType + '): ' + err);
    
    // Return a JSON response with status 200 (implicit) but ok: false
    // to stop Stripe retries gracefully.
    return json({ ok: false, error: String(err), event_id: evtId });
  }
}

/**
 * Handles a simple GET request for testing purposes.
 * - You can visit the web app URL in a browser to see this.
 */
function doGet() {
  return json({ ok: true, message: 'Stripe webhook endpoint is live.' });
}


// ----------------------------------------------------------------------
// ===== Normalization (MAPS STRIPE DATA TO SHEET COLUMNS) =====
// ----------------------------------------------------------------------

/**
 * Converts a Stripe event object into a standardized "row object" for the sheet.
 * This function:
 *  - Filters only certain event types
 *  - Only processes successful payments
 *  - Extracts data consistently across event types
 *
 * @param {Object} evt The parsed Stripe event payload.
 * @returns {Object|null} A row object, or null if the event should be skipped.
 */
function normalizeStripeEventToSheetRow(evt) {
  const t   = String(evt.type || '');
  const obj = evt.data && evt.data.object;
  if (!obj) return null;

  const paidAt = obj.created ? new Date(Number(obj.created) * 1000) : new Date();

  // This is the internal representation we will write to the sheet.
  const row = {
    client_name:    null,
    client_email:   null,
    paid_at:        paidAt,
    access_code:    null,     // TARGET: Receipt Number / Invoice ID
    plugin_name:    null,
    framer_user_id: null,
    event_id:       null      // TARGET: Payment Intent ID (pi_...) - THE UNIQUE LOOKUP KEY
  };

  /**
   * Unified product ID extraction (used for plugin name mapping):
   * - You can send plugin/product info via metadata.PluginId or metadata.order_reference
   * - For some PaymentIntent flows, Stripe uses payment_details.order_reference
   */
  const productId =
    (obj.metadata && (obj.metadata.PluginId || obj.metadata.order_reference)) ||
    (obj.payment_details && obj.payment_details.order_reference) ||
    null;

  // ----- payment_intent.succeeded ------------------------------------
  if (t === 'payment_intent.succeeded') {
    if (obj.status !== 'succeeded') return null;
    
    row.event_id    = String(obj.id || '').trim();       // Payment Intent ID (pi_...)
    row.access_code = String(obj.invoice || '').trim();  // Invoice ID (may be empty)

    // Plugin Mapping: Prefer explicit Plugin in metadata, otherwise map productId via dictionary
    row.plugin_name = (obj.metadata && obj.metadata.Plugin) ||
                      (productId ? PRODUCT_ID_TO_PLUGIN[productId] : null);

    row.client_email   = obj.receipt_email || null;
    row.framer_user_id = (obj.metadata && obj.metadata.framer_user_id) || null;
    row.client_name    = (obj.metadata && obj.metadata.ClientName)      || null;
  }

  // ----- charge.succeeded --------------------------------------------
  else if (t === 'charge.succeeded') {
    if (obj.status !== 'succeeded') return null;

    const piId = String(obj.payment_intent || '').trim();
    if (!piId) return null;

    row.event_id = piId;
    
    // Prioritize receipt number, fall back to invoice ID
    const receipt = String(obj.receipt_number || '').trim();
    row.access_code = receipt || String(obj.invoice || '').trim();
    
    row.client_name  = (obj.billing_details && obj.billing_details.name)  || null;
    row.client_email = (obj.billing_details && obj.billing_details.email) ||
                       obj.receipt_email                                   || null;

    // Plugin Mapping: Prefer explicit Plugin in metadata, otherwise map productId via dictionary
    row.plugin_name = (obj.metadata && obj.metadata.Plugin) ||
                      (productId ? PRODUCT_ID_TO_PLUGIN[productId] : null);

    row.framer_user_id = (obj.metadata && obj.metadata.framer_user_id) || null;
  }

  // ----- checkout.session.* ------------------------------------------
  else if (t === 'checkout.session.completed' ||
           t === 'checkout.session.async_payment_succeeded') {

    if (obj.payment_status !== 'paid') return null;

    const piId = String(obj.payment_intent || '').trim();
    if (!piId) return null;

    row.event_id = piId;

    // Access code: invoice if present, otherwise the Checkout Session ID
    row.access_code = String(obj.invoice || obj.id || '').trim();

    row.client_name  = (obj.customer_details && obj.customer_details.name)  || null;
    row.client_email = (obj.customer_details && obj.customer_details.email) || null;

    // Plugin Mapping: Prefer explicit Plugin in metadata, otherwise map productId via dictionary
    row.plugin_name = (obj.metadata && obj.metadata.Plugin) ||
                      (productId ? PRODUCT_ID_TO_PLUGIN[productId] : null);

    row.framer_user_id = (obj.metadata && obj.metadata.framer_user_id) || null;
  }
  
  // If we couldn’t determine a PaymentIntent ID, we can’t upsert reliably.
  if (!row.event_id) return null;

  return row;
}


// ----------------------------------------------------------------------
// ===== Sheet Upsert Logic (UPDATES/INSERTS ROW) =====
// ----------------------------------------------------------------------

/**
 * UPSERT logic:
 *  - Look up an existing row by PaymentIntent ID (Event ID column).
 *  - If found → update that row with any new/filled values.
 *  - If not found → append a new row at the bottom.
 *
 * Assumes caller has already acquired a LockService lock.
 */
function upsertPurchase(rowObj) {
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Sheet "' + SHEET_NAME + '" not found');

  // These are the ONLY 7 columns the script will interact with.
  const mustHave = [
    'Client Name', 'Client Email', 'Paid At', 'Access Code', 'Plugin Name', 'Framer User ID', 'Event ID' 
  ];

  const headers   = ensureHeaders(sh, mustHave);
  const hmap      = headerIndexMap(headers);
  
  const piIdCol = hmap['event_id']; 
  if (!piIdCol) throw new Error('No "Event ID" column found for PI ID lookup');

  const piId = String(rowObj.event_id || '').trim();
  if (!piId) throw new Error('Missing Payment Intent ID for lookup');

  const rowIndex = findRowByValue(sh, piIdCol, piId);
  let mode;
  let targetRowIndex;

  if (rowIndex > 0) {
    // 1. UPDATE existing row
    targetRowIndex = rowIndex;
    mode = 'updated';
  } else {
    // 2. INSERT/APPEND new row
    targetRowIndex = sh.getLastRow() + 1;
    sh.insertRowBefore(targetRowIndex); 
    mode = 'appended';
  }

  writeRowObject(sh, targetRowIndex, hmap, rowObj);
  
  return { mode, access_code: rowObj.access_code, pi_id: piId };
}


// ----------------------------------------------------------------------
// ===== Utility Functions =====
// ----------------------------------------------------------------------

/**
 * Writes an object's properties to a specific sheet row.
 * Implements additive writing:
 *  - Always writes the Paid At timestamp and PaymentIntent ID (Event ID).
 *  - Only writes other fields if they are non-null and non-empty.
 *
 * This prevents a later, "sparser" event from wiping earlier data.
 */
function writeRowObject(sh, row, hmap, obj) {
  // Map of Header Name -> Row Object Key (ONLY these keys are considered)
  const map = {
    'Client Name':    'client_name',
    'Client Email':   'client_email',
    'Paid At':        'paid_at',
    'Access Code':    'access_code',
    'Plugin Name':    'plugin_name',
    'Framer User ID': 'framer_user_id',
    'Event ID':       'event_id'
  };

  const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  headerRow.forEach((name, i) => {
    // Check if the sheet header is one of our mapped fields
    const key = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
    if (!key) return;

    const v = obj[key];

    // 1. Always write Date objects (Paid At) and the unique identifier (Event ID)
    if (v instanceof Date || key === 'event_id') {
      sh.getRange(row, i + 1).setValue(v);
      return;
    }

    // 2. For all other fields: Only write if not null/undefined AND not an empty string ("").
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      sh.getRange(row, i + 1).setValue(v);
    }
  });
}

/**
 * Return a JSON response using ContentService.
 * This returns a proper application/json response body, which Stripe accepts
 * as long as the HTTP status is 2xx.
 *
 * @param {Object} o The object to return as JSON.
 */
function json(o) {
  return ContentService
    .createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Parses the incoming webhook payload.
 * Supports:
 *  - application/json
 *  - application/x-www-form-urlencoded (e.g., payload in a "payload" field)
 */
function parseIncoming(e) {
  const ct = String(e.postData.type || '').toLowerCase();

  if (ct.includes('application/json')) {
    return JSON.parse(e.postData.contents || '{}');
  }

  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = e.parameter || {};
    const out = {};
    Object.keys(p).forEach(k => out[k] = Array.isArray(p[k]) ? p[k][0] : p[k]);
    try { return JSON.parse(out.payload || '{}'); } catch (_) { return out; }
  }

  // Fallback: attempt to parse as JSON
  return JSON.parse(e.postData.contents || '{}');
}

/**
 * Normalizes a header name into a lowercase, underscore-separated key.
 * e.g. "Client Name" → "client_name"
 */
function normalizeKey(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Builds a map: normalized header key → column index (1-based).
 */
function headerIndexMap(headers) {
  const m = {};
  headers.forEach((h, i) => {
    const k = normalizeKey(h);
    if (k) m[k] = i + 1;
  });
  return m;
}

/**
 * Ensures that all required headers exist in the first row.
 * If missing, appends them to the right.
 *
 * Returns the full header row after ensuring all required headers exist.
 */
function ensureHeaders(sh, required) {
  const lastCol = Math.max(1, sh.getLastColumn());
  let headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const hmap = headerIndexMap(headers);

  required.forEach(name => {
    const k = normalizeKey(name);
    if (!hmap[k]) {
      headers.push(name);
      sh.getRange(1, headers.length).setValue(name);
    }
  });

  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
}

/**
 * Finds the row index (1-based) for the first row where the given column
 * equals the given value. Returns 0 if not found.
 */
function findRowByValue(sh, col, value) {
  const lastRow = sh.getLastRow();
  // Only search from row 2 downwards (row 1 is headers)
  if (!col || lastRow <= 1) return 0; 

  const vals = sh.getRange(2, col, lastRow - 1, 1).getValues().flat();
  const s    = String(value || '').trim();

  for (let i = 0; i < vals.length; i++) {
    // Row index is i + 2 because we start searching at row 2 (i=0)
    if (String(vals[i] || '').trim() === s) return i + 2; 
  }
  return 0; // Not found
}