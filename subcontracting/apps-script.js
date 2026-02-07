/**
 * Google Apps Script สำหรับ Subcontracting Database
 * 
 * วิธีใช้:
 * 1. สร้าง Google Sheet ใหม่
 * 2. ไปที่ Extensions > Apps Script
 * 3. วาง code นี้ลงไป
 * 4. กด Deploy > New Deployment > Web app
 * 5. ตั้งค่า Execute as: Me, Who has access: Anyone
 * 6. Copy URL ที่ได้มาใส่ในเว็บแอป
 */

// ตั้งชื่อ Tab ใน Sheet
const PRODUCTS_SHEET = 'products';
const ORDERS_SHEET = 'orders';
const DELIVERY_PLANS_SHEET = 'delivery_plans';

function doGet(e) {
    const action = e.parameter.action;
    const callback = e.parameter.callback;

    let result;

    try {
        switch (action) {
            case 'getProducts':
                result = getProducts();
                break;
            case 'getOrders':
                result = getOrders();
                break;
            case 'getDeliveryPlans':
                result = getDeliveryPlans();
                break;
            case 'getAll':
                result = {
                    products: getProducts(),
                    orders: getOrders(),
                    deliveryPlans: getDeliveryPlans()
                };
                break;
            case 'syncAll':
                // รับ data จาก query parameter สำหรับ JSONP
                const dataParam = e.parameter.data;
                if (dataParam) {
                    const data = JSON.parse(decodeURIComponent(dataParam));
                    result = syncAll(data);
                } else {
                    result = { error: 'No data provided' };
                }
                break;
            default:
                result = { error: 'Invalid action' };
        }
    } catch (error) {
        result = { error: error.message };
    }

    const jsonOutput = JSON.stringify(result);

    if (callback) {
        return ContentService.createTextOutput(callback + '(' + jsonOutput + ')')
            .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(jsonOutput)
        .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
    const action = e.parameter.action;
    const data = JSON.parse(e.postData.contents);

    let result;

    try {
        switch (action) {
            case 'saveProduct':
                result = saveProduct(data);
                break;
            case 'saveOrder':
                result = saveOrder(data);
                break;
            case 'saveDeliveryPlan':
                result = saveDeliveryPlan(data);
                break;
            case 'deleteProduct':
                result = deleteProduct(data.id);
                break;
            case 'deleteOrder':
                result = deleteOrder(data.id);
                break;
            case 'syncAll':
                result = syncAll(data);
                break;
            default:
                result = { error: 'Invalid action' };
        }
    } catch (error) {
        result = { error: error.message };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
}

// ==================== Products ====================
function getProducts() {
    const sheet = getOrCreateSheet(PRODUCTS_SHEET, ['id', 'code', 'name', 'unit', 'baseQty', 'bom', 'createdAt', 'updatedAt']);
    return getSheetData(sheet);
}

function saveProduct(product) {
    const sheet = getOrCreateSheet(PRODUCTS_SHEET, ['id', 'code', 'name', 'unit', 'baseQty', 'bom', 'createdAt', 'updatedAt']);

    product.updatedAt = new Date().toISOString();
    if (!product.createdAt) {
        product.createdAt = product.updatedAt;
    }

    // Convert BOM to JSON string
    if (product.bom && typeof product.bom === 'object') {
        product.bom = JSON.stringify(product.bom);
    }

    return upsertRow(sheet, product, 'id');
}

function deleteProduct(id) {
    const sheet = getOrCreateSheet(PRODUCTS_SHEET, ['id', 'code', 'name', 'unit', 'baseQty', 'bom', 'createdAt', 'updatedAt']);
    return deleteRow(sheet, id, 'id');
}

// ==================== Orders ====================
function getOrders() {
    const sheet = getOrCreateSheet(ORDERS_SHEET, [
        'id', 'orderNo', 'productId', 'productName', 'productUnit', 'qty',
        'subcontractor', 'dueDate', 'status', 'receivedQty', 'outstandingQty',
        'materials', 'shipments', 'createdAt', 'updatedAt'
    ]);
    return getSheetData(sheet);
}

function saveOrder(order) {
    const sheet = getOrCreateSheet(ORDERS_SHEET, [
        'id', 'orderNo', 'productId', 'productName', 'productUnit', 'qty',
        'subcontractor', 'dueDate', 'status', 'receivedQty', 'outstandingQty',
        'materials', 'shipments', 'createdAt', 'updatedAt'
    ]);

    order.updatedAt = new Date().toISOString();
    if (!order.createdAt) {
        order.createdAt = order.updatedAt;
    }

    // Convert materials to JSON string
    if (order.materials && typeof order.materials === 'object') {
        order.materials = JSON.stringify(order.materials);
    }
    // Convert shipments to JSON string
    if (order.shipments && typeof order.shipments === 'object') {
        order.shipments = JSON.stringify(order.shipments);
    }

    return upsertRow(sheet, order, 'id');
}

function deleteOrder(id) {
    const sheet = getOrCreateSheet(ORDERS_SHEET, [
        'id', 'orderNo', 'productId', 'productName', 'productUnit', 'qty',
        'subcontractor', 'dueDate', 'status', 'receivedQty', 'outstandingQty',
        'materials', 'createdAt', 'updatedAt'
    ]);
    return deleteRow(sheet, id, 'id');
}

// ==================== Delivery Plans ====================
function getDeliveryPlans() {
    const sheet = getOrCreateSheet(DELIVERY_PLANS_SHEET, [
        'id', 'orderId', 'orderNo', 'plannedDate', 'plannedQty', 'note', 'createdAt'
    ]);
    return getSheetData(sheet);
}

function saveDeliveryPlan(plan) {
    const sheet = getOrCreateSheet(DELIVERY_PLANS_SHEET, [
        'id', 'orderId', 'orderNo', 'plannedDate', 'plannedQty', 'note', 'createdAt'
    ]);

    if (!plan.id) {
        plan.id = Utilities.getUuid();
    }
    if (!plan.createdAt) {
        plan.createdAt = new Date().toISOString();
    }

    return upsertRow(sheet, plan, 'id');
}

// ==================== Sync All ====================
function syncAll(data) {
    const results = {
        products: 0,
        orders: 0,
        deliveryPlans: 0
    };

    if (data.products && data.products.length > 0) {
        data.products.forEach(p => {
            saveProduct(p);
            results.products++;
        });
    }

    if (data.orders && data.orders.length > 0) {
        data.orders.forEach(o => {
            saveOrder(o);
            results.orders++;
        });
    }

    if (data.deliveryPlans && data.deliveryPlans.length > 0) {
        data.deliveryPlans.forEach(d => {
            saveDeliveryPlan(d);
            results.deliveryPlans++;
        });
    }

    return { success: true, synced: results };
}

// ==================== Helper Functions ====================
function getOrCreateSheet(name, headers) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(name);

    if (!sheet) {
        sheet = ss.insertSheet(name);
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    }

    return sheet;
}

function getSheetData(sheet) {
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];

    const headers = data[0];
    const rows = data.slice(1);

    return rows.map(row => {
        const obj = {};
        headers.forEach((header, idx) => {
            let value = row[idx];

            // Parse JSON fields
            if ((header === 'bom' || header === 'materials' || header === 'shipments') && value && typeof value === 'string') {
                try {
                    value = JSON.parse(value);
                } catch (e) { }
            }

            obj[header] = value;
        });
        return obj;
    }).filter(row => row.id); // Filter out empty rows
}

function upsertRow(sheet, data, idField) {
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];

    // Find existing row
    const idIdx = headers.indexOf(idField);
    let rowIndex = -1;

    // Convert id to string for comparison
    const targetId = String(data[idField]);

    for (let i = 1; i < allData.length; i++) {
        // Compare as strings to handle number/string mismatch
        if (String(allData[i][idIdx]) === targetId) {
            rowIndex = i + 1; // 1-indexed
            break;
        }
    }

    // Prepare row data
    const rowData = headers.map(h => data[h] !== undefined ? data[h] : '');

    if (rowIndex > 0) {
        // Update existing row
        sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowData]);
    } else {
        // Append new row
        sheet.appendRow(rowData);
    }

    return { success: true, id: data[idField] };
}

function deleteRow(sheet, id, idField) {
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const idIdx = headers.indexOf(idField);

    for (let i = 1; i < allData.length; i++) {
        if (allData[i][idIdx] === id) {
            sheet.deleteRow(i + 1);
            return { success: true };
        }
    }

    return { success: false, error: 'Not found' };
}

// ==================== Setup ====================
function setup() {
    // Create all sheets with headers
    getOrCreateSheet(PRODUCTS_SHEET, ['id', 'code', 'name', 'unit', 'baseQty', 'bom', 'createdAt', 'updatedAt']);
    getOrCreateSheet(ORDERS_SHEET, [
        'id', 'orderNo', 'productId', 'productName', 'productUnit', 'qty',
        'subcontractor', 'dueDate', 'status', 'receivedQty', 'outstandingQty',
        'materials', 'createdAt', 'updatedAt'
    ]);
    getOrCreateSheet(DELIVERY_PLANS_SHEET, [
        'id', 'orderId', 'orderNo', 'plannedDate', 'plannedQty', 'note', 'createdAt'
    ]);

    Logger.log('Setup completed!');
}
