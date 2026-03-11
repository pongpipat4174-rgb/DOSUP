// =============================================
// Subcontracting System — Express + PostgreSQL Server
// Dual-write: DB (primary) + Google Sheet (backup)
// =============================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════
//  GOOGLE SHEET SYNC (Background / Fire-and-forget)
//  อ่านจาก DB → เร็ว | เขียนลง DB + Sheet → backup
// ══════════════════════════════════════════════
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';

// POST to Google Apps Script (fire-and-forget)
function syncToSheet(action, data) {
  if (!APPS_SCRIPT_URL) return;
  const payload = JSON.stringify({ action, ...data });
  try {
    const url = new URL(APPS_SCRIPT_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        // Follow redirect (Apps Script returns 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirect(res.headers.location, payload);
        } else {
          console.log(`📋 Sheet sync [${action}]: ${res.statusCode}`);
        }
      });
    });
    req.on('error', (err) => console.warn(`⚠️ Sheet sync [${action}] error:`, err.message));
    req.write(payload);
    req.end();
  } catch (err) {
    console.warn(`⚠️ Sheet sync [${action}] error:`, err.message);
  }
}

// Follow redirect for Apps Script
function followRedirect(url, payload) {
  try {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirect(res.headers.location, payload);
        }
      });
    });
    req.on('error', (err) => console.warn('⚠️ Sheet redirect error:', err.message));
    req.write(payload);
    req.end();
  } catch (err) {
    console.warn('⚠️ Sheet redirect error:', err.message);
  }
}

// GET to Google Apps Script (fire-and-forget)
function syncToSheetGet(action, params = '') {
  if (!APPS_SCRIPT_URL) return;
  try {
    const url = APPS_SCRIPT_URL + '?action=' + action + (params ? '&' + params : '');
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, () => { }).on('error', () => { });
        }
        console.log(`📋 Sheet sync GET [${action}]: ${res.statusCode}`);
      });
    }).on('error', (err) => console.warn(`⚠️ Sheet sync GET [${action}] error:`, err.message));
  } catch (err) {
    console.warn(`⚠️ Sheet sync GET [${action}] error:`, err.message);
  }
}

// Helper: Build order object for Sheet sync (matches Apps Script format)
function buildOrderForSheet(o) {
  return {
    id: o.id,
    orderNo: o.orderNo || o.order_no || '',
    productId: o.productId || o.product_id || '',
    productName: o.productName || o.product_name || '',
    productUnit: o.productUnit || o.product_unit || '',
    qty: o.qty || 0,
    subcontractor: o.subcontractor || '',
    dueDate: o.dueDate || o.due_date || '',
    status: o.status || 'pending',
    receivedQty: o.receivedQty || o.received_qty || 0,
    outstandingQty: o.outstandingQty || o.outstanding_qty || 0,
    materials: o.materials || [],
    shipments: o.shipments || [],
    bpr: o.bpr || '',
    lot: o.lot || '',
    mfd: o.mfd || '',
    exp: o.exp || '',
    createdAt: o.createdAt || o.created_at || new Date().toISOString(),
  };
}

// Helper: Build product object for Sheet sync
function buildProductForSheet(p) {
  return {
    id: p.id,
    code: p.code || '',
    name: p.name || '',
    unit: p.unit || '',
    baseQty: p.baseQty || p.base_qty || 0,
    bom: p.bom || [],
    createdAt: p.createdAt || p.created_at || new Date().toISOString(),
  };
}

// ── Database Connection ──
const pool = new Pool({
  host: process.env.INVENTORY_DB_HOST || 'localhost',
  port: parseInt(process.env.INVENTORY_DB_PORT || '5432'),
  database: process.env.INVENTORY_DB_NAME || 'inventory_rm_tan',
  user: process.env.INVENTORY_DB_USER || 'postgres',
  password: process.env.INVENTORY_DB_PASSWORD || 'postgres123',
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err.message);
});

// ── Helper: run query ──
const query = async (text, params) => {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
};

// ══════════════════════════════════════════════
//  PRODUCTS API
// ══════════════════════════════════════════════

// GET /api/products — ดึงสินค้าทั้งหมดพร้อม BOM
app.get('/api/products', async (req, res) => {
  try {
    const productsResult = await query('SELECT * FROM products ORDER BY created_at DESC');
    const bomResult = await query('SELECT * FROM product_bom ORDER BY id');

    const products = productsResult.rows.map(p => {
      const bom = bomResult.rows
        .filter(b => b.product_id === p.id)
        .map(b => ({ name: b.material_name, qty: parseFloat(b.qty_per_unit), unit: b.unit }));
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        unit: p.unit,
        baseQty: parseFloat(p.base_qty) || 0,
        bom,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      };
    });

    res.json({ success: true, products });
  } catch (err) {
    console.error('GET /api/products error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products — เพิ่ม/อัปเดตสินค้า
app.post('/api/products', async (req, res) => {
  const { id, code, name, unit, baseQty, bom } = req.body;
  if (!id || !name) return res.status(400).json({ success: false, error: 'id and name required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO products (id, code, name, unit, base_qty)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code,
         name = EXCLUDED.name,
         unit = EXCLUDED.unit,
         base_qty = EXCLUDED.base_qty`,
      [id, code || '', name, unit || '', baseQty || 0]
    );

    // Replace BOM
    if (bom && Array.isArray(bom)) {
      await client.query('DELETE FROM product_bom WHERE product_id = $1', [id]);
      for (const mat of bom) {
        if (mat.name && mat.name.trim()) {
          await client.query(
            'INSERT INTO product_bom (product_id, material_name, qty_per_unit, unit) VALUES ($1, $2, $3, $4)',
            [id, mat.name.trim(), mat.qty || 0, mat.unit || '']
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });

    // 📋 Background sync to Sheet
    syncToSheet('syncProducts', { products: [buildProductForSheet(req.body)] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/products error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/products/:id
app.delete('/api/products/:id', async (req, res) => {
  try {
    await query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });

    // 📋 Background sync to Sheet
    syncToSheet('deleteProducts', { ids: [req.params.id] });
  } catch (err) {
    console.error('DELETE /api/products error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
//  ORDERS API
// ══════════════════════════════════════════════

// GET /api/orders — ดึงใบสั่งผลิตทั้งหมดพร้อม materials + shipments
app.get('/api/orders', async (req, res) => {
  try {
    const ordersResult = await query('SELECT * FROM orders ORDER BY created_at DESC');
    const materialsResult = await query('SELECT * FROM order_materials ORDER BY id');
    const shipmentsResult = await query('SELECT * FROM shipments ORDER BY "round"');
    const shipMatResult = await query('SELECT * FROM shipment_materials ORDER BY id');

    const orders = ordersResult.rows.map(o => {
      const materials = materialsResult.rows
        .filter(m => m.order_id === o.id)
        .map(m => ({ name: m.material_name, totalQty: parseFloat(m.required_qty), unit: m.unit }));

      const shipments = shipmentsResult.rows
        .filter(s => s.order_id === o.id)
        .map(s => {
          const mats = shipMatResult.rows
            .filter(sm => sm.shipment_id === s.id)
            .map(sm => ({
              name: sm.material_name,
              sendQty: parseFloat(sm.send_qty),
              unit: sm.unit,
              remark: sm.remark || '',
            }));
          return {
            round: s.round,
            date: s.ship_date,
            qty: parseFloat(s.received_qty) || 0,
            materials: mats,
            notes: s.notes || '',
          };
        });

      return {
        id: o.id,
        orderNo: o.order_no,
        productId: o.product_id,
        productName: o.product_name,
        productUnit: o.product_unit,
        qty: parseFloat(o.qty) || 0,
        subcontractor: o.subcontractor || '',
        dueDate: o.due_date || '',
        status: o.status || 'pending',
        receivedQty: parseFloat(o.received_qty) || 0,
        outstandingQty: parseFloat(o.outstanding_qty) || 0,
        bpr: o.bpr || '',
        lot: o.lot || '',
        mfd: o.mfd || '',
        exp: o.exp || '',
        materials,
        shipments,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      };
    });

    res.json({ success: true, orders });
  } catch (err) {
    console.error('GET /api/orders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders — สร้างใบสั่งผลิตใหม่
app.post('/api/orders', async (req, res) => {
  const o = req.body;
  if (!o.id || !o.orderNo) return res.status(400).json({ success: false, error: 'id and orderNo required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO orders (id, order_no, product_id, product_name, product_unit, qty, subcontractor, due_date, status, received_qty, outstanding_qty, bpr, lot, mfd, exp, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         order_no = EXCLUDED.order_no,
         product_id = EXCLUDED.product_id,
         product_name = EXCLUDED.product_name,
         product_unit = EXCLUDED.product_unit,
         qty = EXCLUDED.qty,
         subcontractor = EXCLUDED.subcontractor,
         due_date = EXCLUDED.due_date,
         status = EXCLUDED.status,
         received_qty = EXCLUDED.received_qty,
         outstanding_qty = EXCLUDED.outstanding_qty,
         bpr = EXCLUDED.bpr,
         lot = EXCLUDED.lot,
         mfd = EXCLUDED.mfd,
         exp = EXCLUDED.exp`,
      [
        o.id, o.orderNo, o.productId || null, o.productName || '', o.productUnit || '',
        o.qty || 0, o.subcontractor || '', o.dueDate || '', o.status || 'pending',
        o.receivedQty || 0, o.outstandingQty || 0,
        o.bpr || '', o.lot || '', o.mfd || '', o.exp || '',
        o.createdAt || new Date().toISOString(),
      ]
    );

    // Save materials
    if (o.materials && Array.isArray(o.materials)) {
      await client.query('DELETE FROM order_materials WHERE order_id = $1', [o.id]);
      for (const m of o.materials) {
        await client.query(
          'INSERT INTO order_materials (order_id, material_name, required_qty, unit) VALUES ($1,$2,$3,$4)',
          [o.id, m.name, m.totalQty || 0, m.unit || '']
        );
      }
    }

    // Save shipments
    if (o.shipments && Array.isArray(o.shipments)) {
      // Delete old shipments (cascade deletes shipment_materials)
      await client.query('DELETE FROM shipments WHERE order_id = $1', [o.id]);
      for (const s of o.shipments) {
        const shipRes = await client.query(
          'INSERT INTO shipments (order_id, round, ship_date, received_qty, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [o.id, s.round || 1, s.date || '', s.qty || 0, s.notes || '']
        );
        const shipmentId = shipRes.rows[0].id;
        if (s.materials && Array.isArray(s.materials)) {
          for (const sm of s.materials) {
            await client.query(
              'INSERT INTO shipment_materials (shipment_id, material_name, send_qty, unit) VALUES ($1,$2,$3,$4)',
              [shipmentId, sm.name, sm.sendQty || 0, sm.unit || '']
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });

    // 📋 Background sync to Sheet
    syncToSheet('syncOrders', { orders: [buildOrderForSheet(o)] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/orders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/orders/:id — อัปเดตใบสั่งผลิต
app.put('/api/orders/:id', async (req, res) => {
  const o = req.body;
  o.id = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE orders SET
         order_no = $2, product_id = $3, product_name = $4, product_unit = $5,
         qty = $6, subcontractor = $7, due_date = $8, status = $9,
         received_qty = $10, outstanding_qty = $11,
         bpr = $12, lot = $13, mfd = $14, exp = $15
       WHERE id = $1`,
      [
        o.id, o.orderNo || '', o.productId || null, o.productName || '', o.productUnit || '',
        o.qty || 0, o.subcontractor || '', o.dueDate || '', o.status || 'pending',
        o.receivedQty || 0, o.outstandingQty || 0,
        o.bpr || '', o.lot || '', o.mfd || '', o.exp || '',
      ]
    );

    // Re-save materials
    if (o.materials && Array.isArray(o.materials)) {
      await client.query('DELETE FROM order_materials WHERE order_id = $1', [o.id]);
      for (const m of o.materials) {
        await client.query(
          'INSERT INTO order_materials (order_id, material_name, required_qty, unit) VALUES ($1,$2,$3,$4)',
          [o.id, m.name, m.totalQty || 0, m.unit || '']
        );
      }
    }

    // Re-save shipments
    if (o.shipments && Array.isArray(o.shipments)) {
      await client.query('DELETE FROM shipments WHERE order_id = $1', [o.id]);
      for (const s of o.shipments) {
        const shipRes = await client.query(
          'INSERT INTO shipments (order_id, round, ship_date, received_qty, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [o.id, s.round || 1, s.date || '', s.qty || 0, s.notes || '']
        );
        const shipmentId = shipRes.rows[0].id;
        if (s.materials && Array.isArray(s.materials)) {
          for (const sm of s.materials) {
            await client.query(
              'INSERT INTO shipment_materials (shipment_id, material_name, send_qty, unit) VALUES ($1,$2,$3,$4)',
              [shipmentId, sm.name, sm.sendQty || 0, sm.unit || '']
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });

    // 📋 Background sync to Sheet
    syncToSheet('syncOrders', { orders: [buildOrderForSheet(o)] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/orders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/orders/:id
app.delete('/api/orders/:id', async (req, res) => {
  try {
    await query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    res.json({ success: true });

    // 📋 Background sync to Sheet
    syncToSheet('deleteOrders', { ids: [req.params.id] });
  } catch (err) {
    console.error('DELETE /api/orders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
//  CONFIG API (piecesPerBox, etc.)
// ══════════════════════════════════════════════

// GET /api/config/:key
app.get('/api/config/:key', async (req, res) => {
  try {
    const result = await query('SELECT value FROM config WHERE key = $1', [req.params.key]);
    if (result.rows.length === 0) return res.json({ success: true, data: null });
    res.json({ success: true, data: result.rows[0].value });
  } catch (err) {
    console.error('GET /api/config error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/config/:key
app.put('/api/config/:key', async (req, res) => {
  try {
    await query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [req.params.key, JSON.stringify(req.body.value)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/config error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ppb — ดึง piecesPerBox ทั้งหมด
app.get('/api/ppb', async (req, res) => {
  try {
    const result = await query('SELECT product_name, pieces_per_box FROM ppb_config');
    const data = {};
    result.rows.forEach(r => { data[r.product_name] = r.pieces_per_box; });
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/ppb error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/ppb — อัปเดต piecesPerBox
app.put('/api/ppb', async (req, res) => {
  const data = req.body; // { "productName": piecesPerBox, ... }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [productName, ppb] of Object.entries(data)) {
      await client.query(
        `INSERT INTO ppb_config (product_name, pieces_per_box) VALUES ($1, $2)
         ON CONFLICT (product_name) DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box`,
        [productName, ppb || 0]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });

    // 📋 Background sync to Sheet
    const dataStr = encodeURIComponent(JSON.stringify(data));
    syncToSheetGet('savePiecesPerBox', 'data=' + dataStr);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/ppb error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════
//  RECEIVING RECORDS API + AUTO-SYNC
//  ข้อมูลรับเข้า: User บันทึกผ่าน Apps Script → Sheet
//  Server ดึง Sheet → DB อัตโนมัติ ทุก 5 นาที
//  Frontend อ่านจาก DB เท่านั้น (เร็วมาก)
// ══════════════════════════════════════════════

const RECEIVING_SHEET_ID = process.env.RECEIVING_SHEET_ID || '1PTXUxu_vJW7EXEp5k11W-bgogDAYY5tSGl2YhYRvuv4';
const RECEIVING_SHEET_GID = process.env.RECEIVING_SHEET_GID || '0';
const RECEIVING_SYNC_INTERVAL = parseInt(process.env.RECEIVING_SYNC_INTERVAL || '300000'); // 5 min default
let lastReceivingSyncTime = null;
let receivingSyncInProgress = false;

// ── Helper: Detect vendor from remark ──
function detectVendor(remark) {
  if (!remark) return null;
  const lower = remark.toLowerCase();
  if (lower.includes('จูน') || lower.includes('jun')) return 'จูน';
  if (lower.includes('cmi') || lower.includes('ซีเอ็มไอ')) return 'CMI';
  if (lower.includes('บางปู') || lower.includes('bangpu')) return 'บางปู';
  return null;
}

// ── Helper: Parse Thai date ──
function parseThaiDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;
  const s = dateStr.trim();

  // d/m/yyyy or d/m/yy
  const slashMatch = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (slashMatch) {
    let d = parseInt(slashMatch[1]);
    let m = parseInt(slashMatch[2]) - 1;
    let y = parseInt(slashMatch[3]);
    if (y > 2400) y -= 543;
    else if (y < 100) y += 2000;
    const date = new Date(y, m, d);
    if (!isNaN(date.getTime())) return date;
  }

  // Thai month names
  const thaiMonths = {
    'ม.ค.': 0, 'ก.พ.': 1, 'มี.ค.': 2, 'เม.ย.': 3, 'พ.ค.': 4, 'มิ.ย.': 5,
    'ก.ค.': 6, 'ส.ค.': 7, 'ก.ย.': 8, 'ต.ค.': 9, 'พ.ย.': 10, 'ธ.ค.': 11,
    'มกราคม': 0, 'กุมภาพันธ์': 1, 'มีนาคม': 2, 'เมษายน': 3, 'พฤษภาคม': 4,
    'มิถุนายน': 5, 'กรกฎาคม': 6, 'สิงหาคม': 7, 'กันยายน': 8, 'ตุลาคม': 9,
    'พฤศจิกายน': 10, 'ธันวาคม': 11,
  };
  for (const [thName, thMonth] of Object.entries(thaiMonths)) {
    if (s.includes(thName)) {
      const nums = s.match(/\d+/g);
      if (nums && nums.length >= 2) {
        let day = parseInt(nums[0]);
        let year = parseInt(nums[nums.length - 1]);
        if (year > 2400) year -= 543;
        else if (year < 100) year += 2000;
        const date = new Date(year, thMonth, day);
        if (!isNaN(date.getTime())) return date;
      }
      break;
    }
  }

  // Standard Date parse
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

// ── Download Google Sheet data (server-side) ──
// ลองหลายวิธี: gviz CSV → pub CSV → export CSV
function downloadSheetData() {
  const urls = [
    `https://docs.google.com/spreadsheets/d/${RECEIVING_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${RECEIVING_SHEET_GID}`,
    `https://docs.google.com/spreadsheets/d/e/${RECEIVING_SHEET_ID}/pub?output=csv&gid=${RECEIVING_SHEET_GID}`,
    `https://docs.google.com/spreadsheets/d/${RECEIVING_SHEET_ID}/export?format=csv&gid=${RECEIVING_SHEET_GID}`,
  ];

  function tryUrl(url) {
    return new Promise((resolve, reject) => {
      let redirects = 0;
      const maxRedirects = 5;
      const timeout = setTimeout(() => reject(new Error('Timeout 15s')), 15000);

      const get = (reqUrl) => {
        https.get(reqUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            redirects++;
            if (redirects > maxRedirects) { clearTimeout(timeout); reject(new Error('Too many redirects')); return; }
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            clearTimeout(timeout);
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', chunk => data += chunk);
          res.on('end', () => { clearTimeout(timeout); resolve(data); });
          res.on('error', (err) => { clearTimeout(timeout); reject(err); });
        }).on('error', (err) => { clearTimeout(timeout); reject(err); });
      };
      get(url);
    });
  }

  // ลองทีละ URL จนกว่าจะสำเร็จ
  return (async () => {
    for (let i = 0; i < urls.length; i++) {
      try {
        console.log(`  📥 Trying URL format ${i + 1}/${urls.length}...`);
        const data = await tryUrl(urls[i]);
        if (data && data.length > 50) {
          console.log(`  ✅ Got ${data.length} bytes from format ${i + 1}`);
          return data;
        }
      } catch (err) {
        console.log(`  ⚠️ Format ${i + 1} failed: ${err.message}`);
      }
    }
    throw new Error('All Google Sheet download methods failed');
  })();
}

// ── Parse CSV ──
function parseCSV(csvText) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { currentField += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { currentField += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { currentRow.push(currentField); currentField = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') {
        currentRow.push(currentField);
        if (currentRow.some(f => f.trim() !== '')) rows.push(currentRow);
        currentRow = []; currentField = '';
      } else { currentField += ch; }
    }
  }
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some(f => f.trim() !== '')) rows.push(currentRow);
  }
  return rows;
}

// ══════════════════════════════════════════════
//  SYNC: Google Sheet → DB (receiving_records)
// ══════════════════════════════════════════════
async function syncReceivingFromSheet() {
  if (receivingSyncInProgress) {
    console.log('⏳ Receiving sync already in progress, skipping...');
    return { success: false, reason: 'in_progress' };
  }
  receivingSyncInProgress = true;
  const startTime = Date.now();

  try {
    console.log('🔄 Syncing receiving data from Google Sheet...');
    const csvText = await downloadSheetData();
    const rows = parseCSV(csvText);

    if (rows.length < 2) {
      console.log('⚠️ No receiving data found in sheet');
      return { success: true, count: 0 };
    }

    const headers = rows[0];
    const h = {};
    headers.forEach((name, idx) => { h[name.trim()] = idx; });

    const dateIdx = 0;
    const productIdx = h['ชื่อสินค้า'];
    const boxesIdx = h['ผลรวม(ลัง)'];
    const fractionsIdx = h['ผลรวม(เศษ)'];
    const remarkIdx = h['หมายเหตุ'];

    if (productIdx === undefined) {
      console.warn('⚠️ Column "ชื่อสินค้า" not found in sheet');
      return { success: false, reason: 'missing_column' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM receiving_records');

      // Prepare all records first
      const records = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const productName = (row[productIdx] || '').trim();
        if (!productName) continue;

        const dateStr = (row[dateIdx] || '').trim();
        const recordDate = parseThaiDate(dateStr);
        const totalBoxes = parseInt(row[boxesIdx]) || 0;
        const totalFractions = parseInt(row[fractionsIdx]) || 0;
        const remark = (remarkIdx !== undefined ? (row[remarkIdx] || '') : '').trim();
        const vendor = detectVendor(remark);

        records.push([
          recordDate ? `${recordDate.getFullYear()}-${String(recordDate.getMonth()+1).padStart(2,'0')}-${String(recordDate.getDate()).padStart(2,'0')}` : null,
          productName, totalBoxes, totalFractions, remark, vendor
        ]);
      }

      // Batch insert (200 rows per batch for speed)
      const BATCH_SIZE = 200;
      for (let b = 0; b < records.length; b += BATCH_SIZE) {
        const batch = records.slice(b, b + BATCH_SIZE);
        const values = [];
        const params = [];
        batch.forEach((rec, idx) => {
          const offset = idx * 6;
          values.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`);
          params.push(...rec);
        });
        await client.query(
          `INSERT INTO receiving_records (record_date, product_name, total_boxes, total_fractions, remark, vendor) VALUES ${values.join(',')}`,
          params
        );
        if (b % 1000 === 0 && b > 0) console.log(`  📊 Inserted ${b}/${records.length}...`);
      }

      await client.query('COMMIT');
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      lastReceivingSyncTime = new Date().toISOString();
      console.log(`✅ Receiving sync done: ${records.length} records in ${elapsed}s`);
      return { success: true, count: records.length, elapsed, syncTime: lastReceivingSyncTime };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Receiving sync error:', err.message);
    return { success: false, error: err.message };
  } finally {
    receivingSyncInProgress = false;
  }
}

// GET /api/receiving — ดึงรายการรับเข้าทั้งหมด
app.get('/api/receiving', async (req, res) => {
  try {
    const result = await query('SELECT * FROM receiving_records ORDER BY record_date DESC, id DESC');
    res.json({ success: true, records: result.rows, lastSync: lastReceivingSyncTime });
  } catch (err) {
    console.error('GET /api/receiving error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/receiving/summary — สรุปยอดตาม vendor/product (สำหรับ Sheet Modal)
app.get('/api/receiving/summary', async (req, res) => {
  try {
    const { dateFrom, dateTo, vendor } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (dateFrom) {
      params.push(dateFrom);
      whereClause += ` AND record_date >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      whereClause += ` AND record_date <= $${params.length}`;
    }
    if (vendor && vendor !== 'all') {
      params.push(vendor);
      whereClause += ` AND vendor = $${params.length}`;
    }

    const result = await query(
      `SELECT product_name, COALESCE(vendor, 'อื่นๆ') as vendor,
              SUM(total_boxes) as total_boxes,
              SUM(total_fractions) as total_fractions,
              COUNT(*) as count
       FROM receiving_records
       ${whereClause}
       GROUP BY product_name, COALESCE(vendor, 'อื่นๆ')
       ORDER BY vendor, total_boxes DESC`,
      params
    );

    // Also get summary totals by vendor
    const vendorTotals = await query(
      `SELECT COALESCE(vendor, 'อื่นๆ') as vendor,
              SUM(total_boxes) as total,
              COUNT(*) as count
       FROM receiving_records
       ${whereClause}
       GROUP BY COALESCE(vendor, 'อื่นๆ')`,
      params
    );

    const summary = { jun: { total: 0, count: 0 }, cmi: { total: 0, count: 0 }, bangpu: { total: 0, count: 0 }, other: { total: 0, count: 0 }, all: { total: 0, count: 0 } };
    vendorTotals.rows.forEach(r => {
      const total = parseInt(r.total) || 0;
      const count = parseInt(r.count) || 0;
      summary.all.total += total;
      summary.all.count += count;
      if (r.vendor === 'จูน') { summary.jun = { total, count }; }
      else if (r.vendor === 'CMI') { summary.cmi = { total, count }; }
      else if (r.vendor === 'บางปู') { summary.bangpu = { total, count }; }
      else { summary.other.total += total; summary.other.count += count; }
    });

    res.json({
      success: true,
      data: result.rows.map(r => ({
        productName: r.product_name,
        vendor: r.vendor,
        totalBoxes: parseInt(r.total_boxes) || 0,
        totalFractions: parseInt(r.total_fractions) || 0,
        count: parseInt(r.count) || 0,
      })),
      summary,
      lastSync: lastReceivingSyncTime,
    });
  } catch (err) {
    console.error('GET /api/receiving/summary error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/receiving/by-order/:orderNo — ยอดรับเข้าตามเลข JO
app.get('/api/receiving/by-order/:orderNo', async (req, res) => {
  try {
    const orderNo = req.params.orderNo;
    const result = await query(
      `SELECT product_name, total_boxes, total_fractions, remark
       FROM receiving_records
       WHERE remark LIKE $1`,
      [`%${orderNo}%`]
    );
    res.json({ success: true, records: result.rows });
  } catch (err) {
    console.error('GET /api/receiving/by-order error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/receiving/by-orders — ยอดรับเข้าหลาย JO ทีเดียว (batch)
app.post('/api/receiving/by-orders', async (req, res) => {
  try {
    const { orderNos } = req.body; // ["JO-xxx", "JO-yyy"]
    if (!orderNos || !Array.isArray(orderNos) || orderNos.length === 0) {
      return res.json({ success: true, data: {} });
    }

    const result = await query('SELECT product_name, total_boxes, total_fractions, remark FROM receiving_records');
    const receivedMap = {};
    for (const orderNo of orderNos) {
      receivedMap[orderNo] = { rows: [] };
    }
    for (const row of result.rows) {
      const remark = row.remark || '';
      for (const orderNo of orderNos) {
        if (remark.includes(orderNo)) {
          if (!receivedMap[orderNo]) receivedMap[orderNo] = { rows: [] };
          receivedMap[orderNo].rows.push(row);
        }
      }
    }
    res.json({ success: true, data: receivedMap });
  } catch (err) {
    console.error('POST /api/receiving/by-orders error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/receiving/product-names — รายชื่อสินค้าจากข้อมูลรับเข้า
app.get('/api/receiving/product-names', async (req, res) => {
  try {
    const result = await query(
      `SELECT DISTINCT product_name FROM receiving_records
       WHERE product_name IS NOT NULL AND product_name != ''
       ORDER BY product_name`
    );
    res.json({ success: true, names: result.rows.map(r => r.product_name) });
  } catch (err) {
    console.error('GET /api/receiving/product-names error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/receiving/sync — trigger manual sync from Sheet → DB
app.post('/api/receiving/sync', async (req, res) => {
  try {
    const result = await syncReceivingFromSheet();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/receiving/sync-status — ดูสถานะ sync
app.get('/api/receiving/sync-status', async (req, res) => {
  res.json({
    success: true,
    lastSync: lastReceivingSyncTime,
    inProgress: receivingSyncInProgress,
    interval: RECEIVING_SYNC_INTERVAL,
  });
});

// ══════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  try {
    const result = await query('SELECT NOW() AS now');
    res.json({ success: true, time: result.rows[0].now, db: 'connected', lastReceivingSync: lastReceivingSyncTime });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, db: 'disconnected' });
  }
});

// ── SPA Fallback ──
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 Subcontracting Server running at http://localhost:${PORT}`);
  console.log(`📦 Database: ${process.env.INVENTORY_DB_NAME || 'inventory_rm_tan'} @ ${process.env.INVENTORY_DB_HOST || 'localhost'}:${process.env.INVENTORY_DB_PORT || '5432'}`);
  console.log(`📋 Sheet sync: ${APPS_SCRIPT_URL ? '✅ Enabled' : '⚠️ Disabled (set APPS_SCRIPT_URL in .env)'}`);
  console.log(`📥 Receiving Sheet: ${RECEIVING_SHEET_ID} (auto-sync every ${RECEIVING_SYNC_INTERVAL / 1000}s)`);
  console.log(`🌐 Frontend: http://localhost:${PORT}\n`);

  // ── Ensure receiving_records table exists ──
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS receiving_records (
        id              SERIAL PRIMARY KEY,
        record_date     DATE,
        product_name    VARCHAR(255) NOT NULL,
        total_boxes     INTEGER DEFAULT 0,
        total_fractions INTEGER DEFAULT 0,
        remark          TEXT DEFAULT '',
        vendor          VARCHAR(100),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query('CREATE INDEX IF NOT EXISTS idx_receiving_date ON receiving_records(record_date)');
    await query('CREATE INDEX IF NOT EXISTS idx_receiving_vendor ON receiving_records(vendor)');
    await query('CREATE INDEX IF NOT EXISTS idx_receiving_product ON receiving_records(product_name)');
  } catch (err) {
    console.warn('⚠️ Could not ensure receiving_records table:', err.message);
  }

  // ── Initial sync on startup ──
  console.log('📥 Running initial receiving sync from Google Sheet...');
  syncReceivingFromSheet().catch(err => console.warn('⚠️ Initial receiving sync failed:', err.message));

  // ── Auto-sync every 5 minutes ──
  setInterval(() => {
    syncReceivingFromSheet().catch(err => console.warn('⚠️ Auto receiving sync failed:', err.message));
  }, RECEIVING_SYNC_INTERVAL);
});

