-- =============================================
-- ระบบจัดจ้างการผลิต (Subcontracting System)
-- PostgreSQL Database Schema
-- Database: inventory_rm_tan
-- =============================================

-- สร้าง extension สำหรับ UUID (ถ้ายังไม่มี)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- 1. ตาราง products (สินค้า)
-- =============================================
CREATE TABLE IF NOT EXISTS products (
    id              VARCHAR(100) PRIMARY KEY,
    code            VARCHAR(100),
    name            VARCHAR(255) NOT NULL,
    unit            VARCHAR(50),
    base_qty        NUMERIC(15, 4) DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE products IS 'ตารางสินค้า - เก็บข้อมูลสินค้าทั้งหมด';
COMMENT ON COLUMN products.id IS 'รหัสสินค้า (Primary Key)';
COMMENT ON COLUMN products.code IS 'รหัสสินค้า (Product Code)';
COMMENT ON COLUMN products.name IS 'ชื่อสินค้า';
COMMENT ON COLUMN products.unit IS 'หน่วยนับ';
COMMENT ON COLUMN products.base_qty IS 'จำนวนฐาน (Base Quantity)';

-- =============================================
-- 2. ตาราง product_bom (Bill of Materials)
--    แยกจาก JSON array ใน products.bom
-- =============================================
CREATE TABLE IF NOT EXISTS product_bom (
    id              SERIAL PRIMARY KEY,
    product_id      VARCHAR(100) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    material_name   VARCHAR(255) NOT NULL,
    qty_per_unit    NUMERIC(15, 4) DEFAULT 0,
    unit            VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_product_bom_product_id ON product_bom(product_id);

COMMENT ON TABLE product_bom IS 'ตาราง BOM - สูตรการผลิต (วัตถุดิบที่ใช้ต่อสินค้า)';
COMMENT ON COLUMN product_bom.product_id IS 'FK → products.id';
COMMENT ON COLUMN product_bom.material_name IS 'ชื่อวัตถุดิบ';
COMMENT ON COLUMN product_bom.qty_per_unit IS 'จำนวนวัตถุดิบที่ใช้ต่อหน่วย';

-- =============================================
-- 3. ตาราง orders (ใบสั่งผลิต)
-- =============================================
CREATE TABLE IF NOT EXISTS orders (
    id                  VARCHAR(100) PRIMARY KEY,
    order_no            VARCHAR(100),
    product_id          VARCHAR(100) REFERENCES products(id) ON DELETE SET NULL,
    product_name        VARCHAR(255),
    product_unit        VARCHAR(50),
    qty                 NUMERIC(15, 4) DEFAULT 0,
    subcontractor       VARCHAR(255),
    due_date            VARCHAR(50),
    status              VARCHAR(50) DEFAULT 'pending',
    received_qty        NUMERIC(15, 4) DEFAULT 0,
    outstanding_qty     NUMERIC(15, 4) DEFAULT 0,
    bpr                 VARCHAR(255) DEFAULT '',
    lot                 VARCHAR(255) DEFAULT '',
    mfd                 VARCHAR(100) DEFAULT '',
    exp                 VARCHAR(100) DEFAULT '',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_order_no ON orders(order_no);
CREATE INDEX idx_orders_product_id ON orders(product_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_subcontractor ON orders(subcontractor);

COMMENT ON TABLE orders IS 'ตารางใบสั่งผลิต - เก็บข้อมูลคำสั่งผลิตทั้งหมด';
COMMENT ON COLUMN orders.order_no IS 'เลขที่ใบสั่งผลิต';
COMMENT ON COLUMN orders.subcontractor IS 'ผู้รับจ้าง';
COMMENT ON COLUMN orders.due_date IS 'กำหนดส่ง';
COMMENT ON COLUMN orders.status IS 'สถานะ (pending, in_progress, completed, etc.)';
COMMENT ON COLUMN orders.received_qty IS 'จำนวนที่รับแล้ว';
COMMENT ON COLUMN orders.outstanding_qty IS 'จำนวนคงค้าง';
COMMENT ON COLUMN orders.bpr IS 'Batch Production Record';
COMMENT ON COLUMN orders.lot IS 'เลข Lot';
COMMENT ON COLUMN orders.mfd IS 'วันผลิต';
COMMENT ON COLUMN orders.exp IS 'วันหมดอายุ';

-- =============================================
-- 4. ตาราง order_materials (วัตถุดิบในใบสั่งผลิต)
--    แยกจาก JSON array ใน orders.materials
-- =============================================
CREATE TABLE IF NOT EXISTS order_materials (
    id              SERIAL PRIMARY KEY,
    order_id        VARCHAR(100) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    material_name   VARCHAR(255) NOT NULL,
    required_qty    NUMERIC(15, 4) DEFAULT 0,
    unit            VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_order_materials_order_id ON order_materials(order_id);

COMMENT ON TABLE order_materials IS 'ตารางวัตถุดิบที่ต้องจัดส่งตามใบสั่งผลิต';
COMMENT ON COLUMN order_materials.order_id IS 'FK → orders.id';
COMMENT ON COLUMN order_materials.material_name IS 'ชื่อวัตถุดิบ';
COMMENT ON COLUMN order_materials.required_qty IS 'จำนวนที่ต้องใช้';

-- =============================================
-- 5. ตาราง shipments (การจัดส่งวัตถุดิบ)
--    แยกจาก JSON array ใน orders.shipments
-- =============================================
CREATE TABLE IF NOT EXISTS shipments (
    id              SERIAL PRIMARY KEY,
    order_id        VARCHAR(100) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    round           INTEGER NOT NULL DEFAULT 1,
    ship_date       VARCHAR(50),
    received_qty    NUMERIC(15, 4) DEFAULT 0,
    notes           TEXT DEFAULT '',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shipments_order_id ON shipments(order_id);

COMMENT ON TABLE shipments IS 'ตารางการจัดส่งวัตถุดิบ (แต่ละรอบการส่ง)';
COMMENT ON COLUMN shipments.order_id IS 'FK → orders.id';
COMMENT ON COLUMN shipments.round IS 'รอบการส่ง';
COMMENT ON COLUMN shipments.ship_date IS 'วันที่ส่ง';
COMMENT ON COLUMN shipments.received_qty IS 'จำนวนที่รับ';

-- =============================================
-- 6. ตาราง shipment_materials (วัตถุดิบในแต่ละรอบส่ง)
--    แยกจาก JSON ใน shipments → materials
-- =============================================
CREATE TABLE IF NOT EXISTS shipment_materials (
    id              SERIAL PRIMARY KEY,
    shipment_id     INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    material_name   VARCHAR(255) NOT NULL,
    send_qty        NUMERIC(15, 4) DEFAULT 0,
    unit            VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shipment_materials_shipment_id ON shipment_materials(shipment_id);

COMMENT ON TABLE shipment_materials IS 'ตารางวัตถุดิบที่ส่งในแต่ละรอบ';
COMMENT ON COLUMN shipment_materials.shipment_id IS 'FK → shipments.id';
COMMENT ON COLUMN shipment_materials.material_name IS 'ชื่อวัตถุดิบ';
COMMENT ON COLUMN shipment_materials.send_qty IS 'จำนวนที่ส่ง';

-- =============================================
-- 7. ตาราง delivery_plans (แผนจัดส่ง - View/Flatten)
--    สร้างเป็น VIEW จาก orders + shipments + shipment_materials
-- =============================================
CREATE OR REPLACE VIEW delivery_plans_view AS
SELECT
    o.order_no,
    o.product_name,
    s.round,
    s.ship_date AS date,
    sm.material_name,
    sm.send_qty,
    sm.unit
FROM orders o
JOIN shipments s ON s.order_id = o.id
LEFT JOIN shipment_materials sm ON sm.shipment_id = s.id
ORDER BY o.order_no, s.round;

COMMENT ON VIEW delivery_plans_view IS 'View แผนจัดส่ง - สร้างจาก orders + shipments + shipment_materials';

-- =============================================
-- 8. ตาราง config (ค่า config ทั่วไป)
-- =============================================
CREATE TABLE IF NOT EXISTS config (
    key             VARCHAR(255) PRIMARY KEY,
    value           JSONB,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE config IS 'ตารางค่า config ทั่วไปของระบบ';

-- =============================================
-- 9. ตาราง ppb_config (จำนวนชิ้นต่อกล่อง)
-- =============================================
CREATE TABLE IF NOT EXISTS ppb_config (
    product_name    VARCHAR(255) PRIMARY KEY,
    pieces_per_box  INTEGER DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ppb_config IS 'ตารางจำนวนชิ้นต่อกล่อง (Pieces Per Box)';

-- =============================================
-- Trigger: auto-update updated_at
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables with updated_at
CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_config_updated_at
    BEFORE UPDATE ON config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_ppb_config_updated_at
    BEFORE UPDATE ON ppb_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- สรุปตาราง
-- =============================================
-- products           → สินค้า
-- product_bom        → สูตรการผลิต (BOM) ของสินค้า
-- orders             → ใบสั่งผลิต
-- order_materials    → วัตถุดิบที่ต้องใช้ในใบสั่งผลิต
-- shipments          → การจัดส่งวัตถุดิบ (แต่ละรอบ)
-- shipment_materials → วัตถุดิบที่ส่งในแต่ละรอบ
-- delivery_plans_view → VIEW แผนจัดส่ง (Flatten)
-- config             → ค่า config ทั่วไป
-- ppb_config         → จำนวนชิ้นต่อกล่อง
