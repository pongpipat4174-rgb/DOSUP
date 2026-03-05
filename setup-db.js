// สคริปต์สร้างตารางใน PostgreSQL
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    host: process.env.INVENTORY_DB_HOST || 'localhost',
    port: parseInt(process.env.INVENTORY_DB_PORT || '5432'),
    database: process.env.INVENTORY_DB_NAME || 'inventory_rm_tan',
    user: process.env.INVENTORY_DB_USER || 'postgres',
    password: process.env.INVENTORY_DB_PASSWORD || 'postgres123',
});

async function run() {
    const sqlFile = path.join(__dirname, 'subcontracting', 'database', 'init.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('📦 Connecting to database...');
    console.log(`   Host: ${process.env.INVENTORY_DB_HOST}:${process.env.INVENTORY_DB_PORT}`);
    console.log(`   Database: ${process.env.INVENTORY_DB_NAME}`);

    const client = await pool.connect();
    try {
        console.log('✅ Connected! Running init.sql...\n');
        await client.query(sql);
        console.log('✅ All tables created successfully!');

        // Verify tables
        const result = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
        console.log('\n📋 Tables in database:');
        result.rows.forEach(r => console.log('   - ' + r.table_name));
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
