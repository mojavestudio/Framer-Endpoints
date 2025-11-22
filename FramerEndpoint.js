/****************************************************
 * Purchases Verifier API (read-only)
 *
 * This script exposes a GET endpoint to validate purchases
 * stored in a Google Sheet, and optionally "bind" them to a
 * per-user identifier (e.g., Framer user ID, account ID, etc.).
 *
 * Expected sheet headers (Row 1):
 *   Client Name | Client Email | Paid At | Access Code | Plugin Name | Framer User ID
 *
 * Minimum required for verifier logic:
 *   Client Email | Access Code | Plugin Name | Framer User ID
 *
 * Plugin names are arbitrary strings (e.g., "Grid", "Globe", etc.)
 ****************************************************/

// === CONFIG (edit these) ===

/**
 * Google Sheet configuration
 *
 * - SPREADSHEET_ID:
 *     Open your target Google Sheet → URL looks like:
 *     https://docs.google.com/spreadsheets/d/<THIS_IS_YOUR_ID>/edit
 *     Copy that ID string and paste it below.
 *
 * - SHEET_NAME:
 *     Name of the worksheet/tab that contains your purchase records.
 */
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
const SHEET_NAME     = 'Purchases';

/**
 * Caching configuration
 *
 * - CACHE_SECONDS:
 *     Number of seconds to cache successful verification responses
 *     (when no bind/write is requested). This reduces read-load on
 *     your sheet and speeds up repeated checks.
 */
const CACHE_SECONDS  = 300; // 5 minutes

/************** Utilities **************/

/**
 * Normalizes a string for comparison:
 * - Lowercases
 * - Strips non-alphanumeric characters
 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Builds a header map for the provided sheet:
 *   { map: { normalizedHeaderName: columnIndex }, header: [rawHeaderValues...] }
 */
function getHeaderMap_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) throw new Error('Sheet has no columns');
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  header.forEach((h, i) => (map[norm(h)] = i + 1));
  return { map, header };
}

/**
 * Helper for sending JSON or JSONP responses.
 *
 * - obj:      JavaScript object to serialize.
 * - callback: optional JSONP callback name.
 */
function respond_(obj, callback) {
  if (callback) {
    return ContentService.createTextOutput(
      `${callback}(${JSON.stringify(obj)});`
    ).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Simple in-memory + Apps Script cache wrapper.
 *
 * - MEMO: local in-memory cache for a single execution.
 * - CacheService: cross-execution cache (for CACHE_SECONDS).
 */
const MEMO = {};

function getCache_(key) {
  if (MEMO[key]) return MEMO[key];
  const cache = CacheService.getScriptCache();
  const raw = cache.get(key);
  if (!raw) return null;
  const val = JSON.parse(raw);
  MEMO[key] = val;
  return val;
}

function putCache_(key, value, seconds) {
  MEMO[key] = value;
  CacheService.getScriptCache().put(key, JSON.stringify(value), seconds);
}

/************** Verifier + (Auto)Binder (GET only) **************/

/**
 * Verifier / Binder endpoint (GET)
 *
 * Query params:
 *   email=...          (required) - purchaser email
 *   access_code=...    (required) - receipt / invoice / access code string
 *   plugin=...         (optional) - plugin/product name (recommended)
 *   plugin_name=...    (optional) - alias for plugin
 *   framer_user_id=... (optional) - ID to "bind" this purchase to
 *   bind=1             (optional) - explicitly request binding to framer_user_id
 *   nocache=1          (optional) - bypass cached responses
 *   callback=...       (optional) - JSONP callback name
 *
 * Sheet layout example:
 *   Client Name | Client Email | Paid At | Access Code | Plugin Name | Framer User ID
 */
function doGet(e) {
  const p   = e && e.parameter ? e.parameter : {};
  const cb  = (p.callback || '').trim();

  // Normalize input params
  const email = String(p.email || '').trim().toLowerCase();
  const code  = String(p.access_code || '').trim();
  const fid   = String(p.framer_user_id || '').trim();
  const bind  = p.bind == '1';
  const noCache = p.nocache == '1';

  // Optional plugin hint (recommended): plugin or plugin_name
  const pluginReqRaw = String(p.plugin || p.plugin_name || '').trim();
  const pluginReq = pluginReqRaw ? norm(pluginReqRaw) : '';

  if (!email || !code) {
    return respond_({ ok: false, error: 'missing email or access_code' }, cb);
  }

  let cacheKey = null;
  let lock = null;

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sh = ss.getSheetByName(SHEET_NAME);
    if (!sh) {
      return respond_(
        { ok: false, error: 'Sheet "' + SHEET_NAME + '" not found' },
        cb
      );
    }

    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      // Sheet has only header row, no data
      return respond_({ ok: true, valid: false, bound: false, reason: 'not_found' }, cb);
    }

    // Build header map (case-insensitive, flexible naming)
    const { map } = getHeaderMap_(sh);
    const col = (name) => map[norm(name)] || 0;

    // NOTE:
    //   Use your actual header text here. This code assumes:
    //   "Client Email", "Access Code", "Plugin Name", "Framer User ID", "Client Name"
    const cEmail   = col('Client Email');
    const cCode    = col('Access Code');
    const cPlugin  = col('Plugin Name');
    const cFuid    = col('Framer User ID');
    const cClient  = col('Client Name'); // used as "project_name" in responses

    if (!cEmail || !cCode) {
      return respond_(
        { ok: false, error: 'Expected "Client Email" and "Access Code" columns' },
        cb
      );
    }
    if (!cPlugin) {
      return respond_(
        { ok: false, error: 'Expected "Plugin Name" column' },
        cb
      );
    }
    if (!cFuid) {
      return respond_(
        { ok: false, error: 'Expected "Framer User ID" column' },
        cb
      );
    }

    const num = lastRow - 1;

    // Read column values into arrays (one element per row)
    const emailVals   = sh.getRange(2, cEmail,  num, 1).getValues().flat();
    const codeVals    = sh.getRange(2, cCode,   num, 1).getValues().flat();
    const pluginVals  = sh.getRange(2, cPlugin, num, 1).getValues().flat();
    const fuidVals    = sh.getRange(2, cFuid,   num, 1).getValues().flat();
    const clientVals  = cClient ? sh.getRange(2, cClient, num, 1).getValues().flat() : null;

    // 1) Find all rows that match email + access_code
    const emailCodeMatches = [];
    for (let i = 0; i < num; i++) {
      const rowEmail = String(emailVals[i] || '').trim().toLowerCase();
      const rowCode  = String(codeVals[i]  || '').trim();
      if (rowEmail === email && rowCode === code) {
        emailCodeMatches.push(i);
      }
    }

    if (emailCodeMatches.length === 0) {
      return respond_({ ok: true, valid: false, bound: false, reason: 'not_found' }, cb);
    }

    // 2) If a plugin name was given, narrow the matches by plugin
    let candidates = emailCodeMatches;
    if (pluginReq) {
      candidates = candidates.filter(i => norm(pluginVals[i]) === pluginReq);
      if (candidates.length === 0) {
        const firstIdx = emailCodeMatches[0];
        return respond_({
          ok: true,
          valid: false,
          bound: !!String(fuidVals[firstIdx] || '').trim(),
          reason: 'wrong_plugin',
          plugin_name_found: String(pluginVals[firstIdx] || '')
        }, cb);
      }
    }

    // 3) Among candidates, prefer:
    //    (1) unbound row, (2) already bound to this fid, (3) first candidate
    let idx = candidates.find(i => !String(fuidVals[i] || '').trim());
    if (idx === undefined) idx = candidates.find(i => String(fuidVals[i] || '').trim() === fid);
    if (idx === undefined) idx = candidates[0];

    const rowNumber      = idx + 2; // +2 because data starts at row 2
    const projectName    = clientVals ? clientVals[idx] : undefined; // mapped from "Client Name"
    const pluginNameNow  = String(pluginVals[idx] || '');
    const fuidNow        = String(fuidVals[idx] || '').trim();

    // 4) Per-plugin cache (only for read-only verification, no bind)
    if (!noCache && !bind) {
      const fidTag    = fid || 'noid';
      const pluginTag = pluginReq || norm(pluginNameNow) || 'any';
      cacheKey = `verify:${email}:${code}:${fidTag}:${pluginTag}`;
      const cached = getCache_(cacheKey);
      if (cached) return respond_(cached, cb);
    }

    const shouldAutoBind = !!fid && !fuidNow;

    // 5) Auto-bind path: if caller passed framer_user_id but no bind=1,
    //    we still bind if there is no existing ID.
    if (shouldAutoBind) {
      lock = LockService.getScriptLock();
      lock.waitLock(5000);

      const fuidCell = sh.getRange(rowNumber, cFuid, 1, 1);
      const freshFuid = String(fuidCell.getValue() || '').trim();

      if (!freshFuid) {
        fuidCell.setValue(fid);
        return respond_({
          ok: true,
          valid: true,
          bound: true,
          project_name: projectName,
          action: 'auto_bound'
        }, cb);
      } else if (freshFuid === fid) {
        return respond_({
          ok: true,
          valid: true,
          bound: true,
          project_name: projectName,
          action: 'already_bound'
        }, cb);
      } else {
        return respond_({
          ok: true,
          valid: false,
          bound: true,
          reason: 'bound_to_other'
        }, cb);
      }
    }

    // 6) Explicit bind path (bind=1)
    if (bind) {
      if (!fid) {
        return respond_(
          { ok: false, error: 'bind requested but framer_user_id missing' },
          cb
        );
      }

      lock = LockService.getScriptLock();
      lock.waitLock(5000);

      const fuidCell = sh.getRange(rowNumber, cFuid, 1, 1);
      const freshFuid = String(fuidCell.getValue() || '').trim();

      if (!freshFuid) {
        fuidCell.setValue(fid);
        return respond_({
          ok: true,
          valid: true,
          bound: true,
          project_name: projectName,
          action: 'bound'
        }, cb);
      } else if (freshFuid === fid) {
        return respond_({
          ok: true,
          valid: true,
          bound: true,
          project_name: projectName,
          action: 'already_bound'
        }, cb);
      } else {
        return respond_({
          ok: true,
          valid: false,
          bound: true,
          reason: 'bound_to_other'
        }, cb);
      }
    }

    // 7) No bind requested — just verification (+ optional caching)

    // Case: not yet bound to any ID
    if (!fuidNow) {
      const res = {
        ok: true,
        valid: true,
        bound: false,
        project_name: projectName
      };
      if (cacheKey) putCache_(cacheKey, res, CACHE_SECONDS);
      return respond_(res, cb);
    }

    // Case: record is bound, but caller did not provide an ID
    if (!fid) {
      const res = {
        ok: true,
        valid: false,
        bound: true,
        reason: 'bound_requires_user_id'
      };
      if (cacheKey) putCache_(cacheKey, res, CACHE_SECONDS);
      return respond_(res, cb);
    }

    // Case: record is bound to this same ID
    if (fuidNow === fid) {
      const res = {
        ok: true,
        valid: true,
        bound: true,
        project_name: projectName,
        action: 'already_bound'
      };
      if (cacheKey) putCache_(cacheKey, res, CACHE_SECONDS);
      return respond_(res, cb);
    } else {
      // Case: record is bound, but to a different ID
      const res = {
        ok: true,
        valid: false,
        bound: true,
        reason: 'bound_to_other'
      };
      if (cacheKey) putCache_(cacheKey, res, CACHE_SECONDS);
      return respond_(res, cb);
    }

  } catch (err) {
    // On error, always respond with a JSON error object
    return respond_(
      { ok: false, error: String(err) },
      (e && e.parameter && e.parameter.callback) || ''
    );
  } finally {
    try { if (lock) lock.releaseLock(); } catch (_) {}
  }
}