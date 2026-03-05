// =============================================
// Import ALL data from Google Sheet CSV → PostgreSQL
// Sheets: products, orders, ppb_config
// (delivery_plans is a VIEW, auto-generated)
// =============================================
require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');

const BASE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTz7R6ZmNUpXnhMpkuVbGbZM_Ke14TFowpyvZmo2YAwpPKtFv0X4t-cKUWiEj8aaKrpkpyN7_bteh8C/pub?output=csv';

const SHEETS = {
    products: { gid: '857119667' },
    ppb_config: { gid: '632235408' },
    orders: { gid: '2118016830' },
};

const pool = new Pool({
    host: process.env.INVENTORY_DB_HOST || 'localhost',
    port: parseInt(process.env.INVENTORY_DB_PORT || '5432'),
    database: process.env.INVENTORY_DB_NAME || 'inventory_rm_tan',
    user: process.env.INVENTORY_DB_USER || 'postgres',
    password: process.env.INVENTORY_DB_PASSWORD || 'postgres123',
});

// ── Download CSV ──
function downloadCSV(url) {
    return new Promise((resolve, reject) => {
        const get = (url) => {
            https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    get(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        };
        get(url);
    });
}

// ── Parse CSV (handles quoted fields with embedded commas/newlines) ──
function parseCSV(csvText) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                currentField += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                currentField += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (ch === '\r') {
                // skip
            } else if (ch === '\n') {
                currentRow.push(currentField);
                if (currentRow.some(f => f.trim() !== '')) {
                    rows.push(currentRow);
                }
                currentRow = [];
                currentField = '';
            } else {
                currentField += ch;
            }
        }
    }
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.some(f => f.trim() !== '')) {
            rows.push(currentRow);
        }
    }

    return rows;
}

// ══════════════════════════════════════════════
//  IMPORT PRODUCTS
// ══════════════════════════════════════════════
async function importProducts(client, csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) { console.log('⚠️ No products data'); return 0; }

    const headers = rows[0];
    console.log('  Headers:', headers.join(', '));

    const productsMap = new Map();

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const id = (row[0] || '').trim();
        const name = (row[2] || '').trim();

        // Skip config rows and empty rows
        if (!id || !name || id.startsWith('__')) continue;

        let bom = [];
        try {
            const bomStr = (row[5] || '[]').trim();
            if (bomStr) bom = JSON.parse(bomStr);
        } catch (e) { }

        if (!productsMap.has(id)) {
            productsMap.set(id, {
                id,
                code: (row[1] || '').trim(),
                name,
                unit: (row[3] || '').trim(),
                baseQty: parseFloat(row[4]) || 0,
                bom: Array.isArray(bom) ? bom : [],
                createdAt: (row[6] || '').trim() || new Date().toISOString(),
            });
        }
    }

    const products = Array.from(productsMap.values());
    console.log(`  Found ${products.length} unique products`);

    for (const p of products) {
        await client.query(
            `INSERT INTO products (id, code, name, unit, base_qty, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code, name = EXCLUDED.name,
         unit = EXCLUDED.unit, base_qty = EXCLUDED.base_qty`,
            [p.id, p.code, p.name, p.unit, p.baseQty, p.createdAt]
        );

        if (p.bom && p.bom.length > 0) {
            await client.query('DELETE FROM product_bom WHERE product_id = $1', [p.id]);
            for (const mat of p.bom) {
                if (mat.name && mat.name.trim()) {
                    await client.query(
                        'INSERT INTO product_bom (product_id, material_name, qty_per_unit, unit) VALUES ($1, $2, $3, $4)',
                        [p.id, mat.name.trim(), mat.qty || 0, mat.unit || '']
                    );
                }
            }
        }
        console.log(`    ✅ ${p.code} - ${p.name} (BOM: ${p.bom.length})`);
    }

    // Also extract ppb config from products sheet (row with __piecesPerBoxConfig__)
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if ((row[0] || '').trim() === '__piecesPerBoxConfig__') {
            try {
                const bomArr = JSON.parse(row[5] || '[]');
                if (Array.isArray(bomArr)) {
                    let ppbCount = 0;
                    for (const item of bomArr) {
                        if (item.name && item.unit === 'ppb' && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(item.name)) {
                            await client.query(
                                `INSERT INTO ppb_config (product_name, pieces_per_box)
                 VALUES ($1, $2)
                 ON CONFLICT (product_name) DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box`,
                                [item.name, item.qty || 0]
                            );
                            ppbCount++;
                        }
                    }
                    console.log(`    ✅ PPB config from products sheet: ${ppbCount} entries`);
                }
            } catch (e) { }
            break;
        }
    }

    return products.length;
}

// ══════════════════════════════════════════════
//  IMPORT PPB CONFIG
// ══════════════════════════════════════════════
async function importPpbConfig(client, csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) { console.log('⚠️ No ppb_config data'); return 0; }

    const headers = rows[0];
    console.log('  Headers:', headers.join(', '));

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const productName = (row[0] || '').trim();
        const ppb = parseInt(row[1]) || 0;

        if (!productName || productName === 'productName') continue;

        await client.query(
            `INSERT INTO ppb_config (product_name, pieces_per_box)
       VALUES ($1, $2)
       ON CONFLICT (product_name) DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box`,
            [productName, ppb]
        );
        count++;
    }

    console.log(`  Imported ${count} PPB config entries`);
    return count;
}

// ══════════════════════════════════════════════
//  IMPORT ORDERS (with materials + shipments)
// ══════════════════════════════════════════════
async function importOrders(client, csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) { console.log('⚠️ No orders data'); return 0; }

    const headers = rows[0];
    console.log('  Headers:', headers.join(', '));

    // Map header name → index
    const h = {};
    headers.forEach((name, idx) => { h[name.trim()] = idx; });

    const ordersMap = new Map();

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const id = (row[h['id']] || '').trim();
        if (!id) continue;

        // Parse materials
        let materials = [];
        try {
            const matStr = (row[h['materials']] || '[]').trim();
            if (matStr) materials = JSON.parse(matStr);
        } catch (e) { }

        // Parse shipments
        let shipments = [];
        try {
            const shipStr = (row[h['shipments']] || '[]').trim();
            if (shipStr) shipments = JSON.parse(shipStr);
        } catch (e) { }

        // Deduplicate: keep latest (last occurrence wins for orders since they may update)
        ordersMap.set(id, {
            id,
            orderNo: (row[h['orderNo']] || '').trim(),
            productId: (row[h['productId']] || '').trim() || null,
            productName: (row[h['productName']] || '').trim(),
            productUnit: (row[h['productUnit']] || '').trim(),
            qty: parseFloat(row[h['qty']]) || 0,
            subcontractor: (row[h['subcontractor']] || '').trim(),
            dueDate: (row[h['dueDate']] || '').trim(),
            status: (row[h['status']] || 'pending').trim(),
            receivedQty: parseFloat(row[h['receivedQty']]) || 0,
            outstandingQty: parseFloat(row[h['outstandingQty']]) || 0,
            bpr: (row[h['bpr']] || '').trim(),
            lot: (row[h['lot']] || '').trim(),
            mfd: (row[h['mfd']] || '').trim(),
            exp: (row[h['exp']] || '').trim(),
            materials: Array.isArray(materials) ? materials : [],
            shipments: Array.isArray(shipments) ? shipments : [],
            createdAt: (row[h['createdAt']] || '').trim() || new Date().toISOString(),
        });
    }

    const orders = Array.from(ordersMap.values());
    console.log(`  Found ${orders.length} unique orders`);

    for (const o of orders) {
        // 1. Upsert order
        await client.query(
            `INSERT INTO orders (id, order_no, product_id, product_name, product_unit, qty,
         subcontractor, due_date, status, received_qty, outstanding_qty,
         bpr, lot, mfd, exp, created_at)
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
                o.id, o.orderNo, o.productId, o.productName, o.productUnit,
                o.qty, o.subcontractor, o.dueDate, o.status,
                o.receivedQty, o.outstandingQty,
                o.bpr, o.lot, o.mfd, o.exp,
                o.createdAt,
            ]
        );

        // 2. Save order_materials
        if (o.materials.length > 0) {
            await client.query('DELETE FROM order_materials WHERE order_id = $1', [o.id]);
            for (const m of o.materials) {
                if (m.name) {
                    await client.query(
                        'INSERT INTO order_materials (order_id, material_name, required_qty, unit) VALUES ($1,$2,$3,$4)',
                        [o.id, m.name, m.totalQty || 0, m.unit || '']
                    );
                }
            }
        }

        // 3. Save shipments + shipment_materials
        if (o.shipments.length > 0) {
            await client.query('DELETE FROM shipments WHERE order_id = $1', [o.id]);
            for (const s of o.shipments) {
                const shipRes = await client.query(
                    'INSERT INTO shipments (order_id, round, ship_date, received_qty, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
                    [o.id, s.round || 1, s.date || '', s.qty || 0, s.notes || '']
                );
                const shipmentId = shipRes.rows[0].id;

                if (s.materials && Array.isArray(s.materials)) {
                    for (const sm of s.materials) {
                        if (sm.name) {
                            await client.query(
                                'INSERT INTO shipment_materials (shipment_id, material_name, send_qty, unit, remark) VALUES ($1,$2,$3,$4,$5)',
                                [shipmentId, sm.name, sm.sendQty || 0, sm.unit || '', sm.remark || '']
                            );
                        }
                    }
                }
            }
        }

        console.log(`    ✅ ${o.orderNo} - ${o.productName} (materials: ${o.materials.length}, shipments: ${o.shipments.length})`);
    }

    return orders.length;
}

// ══════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════
async function main() {
    console.log('🚀 Starting FULL import from Google Sheet...');
    console.log(`📊 Database: ${process.env.INVENTORY_DB_NAME} @ ${process.env.INVENTORY_DB_HOST}:${process.env.INVENTORY_DB_PORT}\n`);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // ── 1. Download all sheets ──
        console.log('⬇️  Downloading all sheets...\n');

        const csvData = {};
        for (const [name, info] of Object.entries(SHEETS)) {
            const url = `${BASE_URL}&gid=${info.gid}`;
            console.log(`  📥 ${name} (gid=${info.gid})...`);
            csvData[name] = await downloadCSV(url);
            console.log(`     ✅ ${csvData[name].length} bytes`);
        }

        // ── 2. Import products first (orders FK → products) ──
        console.log('\n═══════════════════════════════════════');
        console.log('📦 IMPORTING PRODUCTS...');
        console.log('═══════════════════════════════════════');
        const productCount = await importProducts(client, csvData.products);

        // ── 3. Import PPB config ──
        console.log('\n═══════════════════════════════════════');
        console.log('📋 IMPORTING PPB CONFIG...');
        console.log('═══════════════════════════════════════');
        const ppbCount = await importPpbConfig(client, csvData.ppb_config);

        // ── 4. Import orders (with materials + shipments) ──
        console.log('\n═══════════════════════════════════════');
        console.log('📋 IMPORTING ORDERS...');
        console.log('═══════════════════════════════════════');
        const orderCount = await importOrders(client, csvData.orders);

        await client.query('COMMIT');

        // ── 5. Verify ──
        console.log('\n═══════════════════════════════════════');
        console.log('🔍 VERIFYING IMPORT...');
        console.log('═══════════════════════════════════════');

        const counts = await Promise.all([
            client.query('SELECT COUNT(*) as cnt FROM products'),
            client.query('SELECT COUNT(*) as cnt FROM product_bom'),
            client.query('SELECT COUNT(*) as cnt FROM orders'),
            client.query('SELECT COUNT(*) as cnt FROM order_materials'),
            client.query('SELECT COUNT(*) as cnt FROM shipments'),
            client.query('SELECT COUNT(*) as cnt FROM shipment_materials'),
            client.query('SELECT COUNT(*) as cnt FROM ppb_config'),
        ]);

        console.log(`  📦 Products:           ${counts[0].rows[0].cnt}`);
        console.log(`  🧪 Product BOM:        ${counts[1].rows[0].cnt}`);
        console.log(`  📋 Orders:             ${counts[2].rows[0].cnt}`);
        console.log(`  📦 Order Materials:    ${counts[3].rows[0].cnt}`);
        console.log(`  🚚 Shipments:          ${counts[4].rows[0].cnt}`);
        console.log(`  📦 Shipment Materials: ${counts[5].rows[0].cnt}`);
        console.log(`  📋 PPB Config:         ${counts[6].rows[0].cnt}`);

        console.log('\n🎉 FULL IMPORT COMPLETED SUCCESSFULLY!');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('\n❌ Import failed:', err.message);
        console.error(err.stack);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
