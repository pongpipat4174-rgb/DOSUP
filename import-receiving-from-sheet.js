// =============================================
// Import Receiving Records from Google Sheet → PostgreSQL
// ดึงข้อมูลรับเข้าจาก Google Sheet มาเก็บใน DB
// Sheet: 1PTXUxu_vJW7EXEp5k11W-bgogDAYY5tSGl2YhYRvuv4 (GID=0)
// =============================================
require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');

// Google Sheet (receiving data)
const SHEET_ID = '1PTXUxu_vJW7EXEp5k11W-bgogDAYY5tSGl2YhYRvuv4';
const SHEET_GID = '0';

const pool = new Pool({
    host: process.env.INVENTORY_DB_HOST || 'localhost',
    port: parseInt(process.env.INVENTORY_DB_PORT || '5432'),
    database: process.env.INVENTORY_DB_NAME || 'inventory_rm_tan',
    user: process.env.INVENTORY_DB_USER || 'postgres',
    password: process.env.INVENTORY_DB_PASSWORD || 'postgres123',
});

// ── Download CSV from Google Sheet ──
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

// ── Detect Vendor from Remark ──
function detectVendor(remark) {
    if (!remark) return null;
    const lower = remark.toLowerCase();
    if (lower.includes('จูน') || lower.includes('jun')) return 'จูน';
    if (lower.includes('cmi') || lower.includes('ซีเอ็มไอ')) return 'CMI';
    if (lower.includes('บางปู') || lower.includes('bangpu')) return 'บางปู';
    return null;
}

// ── Parse Thai date string (dd/mm/yyyy, d/m/yy, Thai month names) ──
function parseThaiDate(dateStr) {
    if (!dateStr || !dateStr.trim()) return null;
    const s = dateStr.trim();

    // Case 1: d/m/yyyy or d/m/yy
    const slashMatch = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (slashMatch) {
        let d = parseInt(slashMatch[1]);
        let m = parseInt(slashMatch[2]) - 1;
        let y = parseInt(slashMatch[3]);
        if (y > 2400) y -= 543; // Buddhist Era
        else if (y < 100) y += 2000;
        const date = new Date(y, m, d);
        if (!isNaN(date.getTime())) return date;
    }

    // Case 2: Thai short month names
    const thaiShort = {
        'ม.ค.': 0, 'ก.พ.': 1, 'มี.ค.': 2, 'เม.ย.': 3, 'พ.ค.': 4, 'มิ.ย.': 5,
        'ก.ค.': 6, 'ส.ค.': 7, 'ก.ย.': 8, 'ต.ค.': 9, 'พ.ย.': 10, 'ธ.ค.': 11,
    };
    const thaiLong = {
        'มกราคม': 0, 'กุมภาพันธ์': 1, 'มีนาคม': 2, 'เมษายน': 3, 'พฤษภาคม': 4,
        'มิถุนายน': 5, 'กรกฎาคม': 6, 'สิงหาคม': 7, 'กันยายน': 8, 'ตุลาคม': 9,
        'พฤศจิกายน': 10, 'ธันวาคม': 11,
    };
    const allMonths = { ...thaiShort, ...thaiLong };

    for (const [thName, thMonth] of Object.entries(allMonths)) {
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

    // Case 3: Standard JS parse
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return parsed;

    return null;
}

// ══════════════════════════════════════════════
//  IMPORT RECEIVING RECORDS
// ══════════════════════════════════════════════
async function importReceiving(client, csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) { console.log('⚠️ No receiving data'); return 0; }

    const headers = rows[0];
    console.log('  Headers:', headers.join(', '));

    // Map header name → index
    const h = {};
    headers.forEach((name, idx) => { h[name.trim()] = idx; });

    // Find column indices
    const dateIdx = 0; // First column is always date
    const productIdx = h['ชื่อสินค้า'];
    const boxesIdx = h['ผลรวม(ลัง)'];
    const fractionsIdx = h['ผลรวม(เศษ)'];
    const remarkIdx = h['หมายเหตุ'];

    if (productIdx === undefined) {
        console.log('⚠️ Column "ชื่อสินค้า" not found! Available:', headers.join(', '));
        return 0;
    }

    console.log(`  Column mapping: date=${dateIdx}, product=${productIdx}, boxes=${boxesIdx}, fractions=${fractionsIdx}, remark=${remarkIdx}`);

    // Clear existing records
    await client.query('DELETE FROM receiving_records');
    console.log('  🗑️ Cleared existing receiving_records');

    let count = 0;
    let skipped = 0;

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const productName = (row[productIdx] || '').trim();
        if (!productName) { skipped++; continue; }

        const dateStr = (row[dateIdx] || '').trim();
        const recordDate = parseThaiDate(dateStr);
        const totalBoxes = parseInt(row[boxesIdx]) || 0;
        const totalFractions = parseInt(row[fractionsIdx]) || 0;
        const remark = (row[remarkIdx !== undefined ? remarkIdx : -1] || '').trim();
        const vendor = detectVendor(remark);

        await client.query(
            `INSERT INTO receiving_records (record_date, product_name, total_boxes, total_fractions, remark, vendor)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                recordDate ? recordDate.toISOString().split('T')[0] : null,
                productName,
                totalBoxes,
                totalFractions,
                remark,
                vendor,
            ]
        );
        count++;

        if (count <= 5 || count % 100 === 0) {
            console.log(`    ✅ [${count}] ${dateStr} | ${productName} | boxes=${totalBoxes} | fractions=${totalFractions} | vendor=${vendor || '-'} | remark=${remark.substring(0, 40)}...`);
        }
    }

    console.log(`  📊 Imported: ${count} records, Skipped: ${skipped} empty rows`);
    return count;
}

// ══════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════
async function main() {
    console.log('🚀 Starting RECEIVING data import from Google Sheet...');
    console.log(`📊 Sheet: ${SHEET_ID} (GID: ${SHEET_GID})`);
    console.log(`📊 Database: ${process.env.INVENTORY_DB_NAME} @ ${process.env.INVENTORY_DB_HOST}:${process.env.INVENTORY_DB_PORT}\n`);

    const client = await pool.connect();

    try {
        // Step 1: Ensure table exists
        console.log('📋 Ensuring receiving_records table exists...');
        await client.query(`
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
        await client.query('CREATE INDEX IF NOT EXISTS idx_receiving_date ON receiving_records(record_date)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_receiving_vendor ON receiving_records(vendor)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_receiving_product ON receiving_records(product_name)');
        console.log('  ✅ Table ready\n');

        // Step 2: Download CSV
        console.log('⬇️  Downloading receiving sheet...');
        const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
        const csvText = await downloadCSV(csvUrl);
        console.log(`  ✅ Downloaded ${csvText.length} bytes\n`);

        // Step 3: Import
        await client.query('BEGIN');
        console.log('═══════════════════════════════════════');
        console.log('📥 IMPORTING RECEIVING RECORDS...');
        console.log('═══════════════════════════════════════');
        const count = await importReceiving(client, csvText);
        await client.query('COMMIT');

        // Step 4: Verify
        console.log('\n═══════════════════════════════════════');
        console.log('🔍 VERIFYING IMPORT...');
        console.log('═══════════════════════════════════════');

        const totalResult = await client.query('SELECT COUNT(*) as cnt FROM receiving_records');
        const vendorResult = await client.query(`
            SELECT vendor, COUNT(*) as cnt, SUM(total_boxes) as boxes
            FROM receiving_records
            WHERE vendor IS NOT NULL
            GROUP BY vendor
            ORDER BY vendor
        `);
        const dateRange = await client.query(`
            SELECT MIN(record_date) as min_date, MAX(record_date) as max_date
            FROM receiving_records
            WHERE record_date IS NOT NULL
        `);

        console.log(`  📊 Total records:  ${totalResult.rows[0].cnt}`);
        console.log(`  📅 Date range:     ${dateRange.rows[0]?.min_date || '-'} → ${dateRange.rows[0]?.max_date || '-'}`);
        console.log('  🏭 By vendor:');
        vendorResult.rows.forEach(r => {
            console.log(`     ${r.vendor}: ${r.cnt} records, ${r.boxes} boxes`);
        });

        console.log('\n🎉 RECEIVING IMPORT COMPLETED SUCCESSFULLY!');

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
