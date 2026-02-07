// ===== Google Apps Script สำหรับ Subcontracting =====
// วิธีใช้:
// 1. เปิด Google Sheet ที่ต้องการ
// 2. ไปที่ Extensions > Apps Script
// 3. วางโค้ดนี้ทั้งหมดลงในไฟล์ Code.gs
// 4. กด Deploy > New deployment > Web app
//    - Execute as: Me
//    - Who has access: Anyone
// 5. คัดลอก URL ที่ได้ ไปวางใน APPS_SCRIPT_URL ในไฟล์ index.html

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents)
    const action = data.action
    const ss = SpreadsheetApp.getActiveSpreadsheet()

    if (action === 'syncOrders') {
      const result = syncOrders(ss, data.orders)
      syncDeliveryPlans(ss, data.orders) // Auto-sync delivery_plans too
      return result
    } else if (action === 'syncProducts') {
      return syncProducts(ss, data.products)
    }

    return jsonResponse({ success: false, error: 'Unknown action' })
  } catch (err) {
    return jsonResponse({ success: false, error: err.message })
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action
    const ss = SpreadsheetApp.getActiveSpreadsheet()

    if (action === 'getOrders') {
      return getOrders(ss)
    } else if (action === 'getProducts') {
      return getProducts(ss)
    }

    return jsonResponse({ success: false, error: 'Unknown action' })
  } catch (err) {
    return jsonResponse({ success: false, error: err.message })
  }
}

function syncOrders(ss, orders) {
  let sheet = ss.getSheetByName('orders')
  if (!sheet) {
    sheet = ss.insertSheet('orders')
  }

  // Always clear entire sheet and rewrite header
  sheet.clear()
  const headers = ['id', 'orderNo', 'productId', 'productName', 'productUnit', 'qty', 'subcontractor', 'dueDate', 'status', 'receivedQty', 'outstandingQty', 'materials', 'shipments', 'createdAt', 'updatedAt']
  sheet.appendRow(headers)

  // Write all orders
  orders.forEach(order => {
    sheet.appendRow([
      order.id || '',
      order.orderNo || '',
      order.productId || '',
      order.productName || '',
      order.productUnit || '',
      order.qty || 0,
      order.subcontractor || '',
      order.dueDate || '',
      order.status || 'pending',
      order.receivedQty || 0,
      order.outstandingQty || 0,
      JSON.stringify(order.materials || []),
      JSON.stringify(order.shipments || []),
      order.createdAt || new Date().toISOString(),
      new Date().toISOString()
    ])
  })

  return jsonResponse({ success: true, message: 'Orders synced: ' + orders.length })
}

function syncDeliveryPlans(ss, orders) {
  let sheet = ss.getSheetByName('delivery_plans')
  if (!sheet) {
    sheet = ss.insertSheet('delivery_plans')
  }
  
  // Build header and rows
  const headers = ['orderNo', 'productName', 'round', 'date', 'materialName', 'sendQty', 'unit']
  
  // Clear all
  const lastRow = sheet.getLastRow()
  if (lastRow > 0) {
    sheet.getRange(1, 1, lastRow, sheet.getMaxColumns()).clearContent()
  }
  sheet.appendRow(headers)
  
  // Flatten: one row per material per shipment
  orders.forEach(order => {
    if (!order.shipments || order.shipments.length === 0) return
    order.shipments.forEach((ship, idx) => {
      if (!ship.materials || ship.materials.length === 0) {
        // Row with no materials
        sheet.appendRow([
          order.orderNo || '',
          order.productName || '',
          idx + 1,
          ship.date || '',
          '',
          0,
          ''
        ])
      } else {
        ship.materials.forEach(m => {
          sheet.appendRow([
            order.orderNo || '',
            order.productName || '',
            idx + 1,
            ship.date || '',
            m.name || '',
            m.sendQty || 0,
            m.unit || ''
          ])
        })
      }
    })
  })
}

function syncProducts(ss, products) {
  let sheet = ss.getSheetByName('products')
  if (!sheet) {
    sheet = ss.insertSheet('products')
    sheet.appendRow(['id', 'code', 'name', 'unit', 'baseQty', 'bom', 'createdAt'])
  }

  const lastRow = sheet.getLastRow()
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent()
  }

  products.forEach(product => {
    sheet.appendRow([
      product.id || '',
      product.code || '',
      product.name || '',
      product.unit || '',
      product.baseQty || 0,
      JSON.stringify(product.bom || []),
      product.createdAt || new Date().toISOString()
    ])
  })

  return jsonResponse({ success: true, message: 'Products synced: ' + products.length })
}

function getOrders(ss) {
  const sheet = ss.getSheetByName('orders')
  if (!sheet) return jsonResponse({ success: true, orders: [] })

  const data = sheet.getDataRange().getValues()
  if (data.length <= 1) return jsonResponse({ success: true, orders: [] })

  const headers = data[0]
  const orders = []
  for (let i = 1; i < data.length; i++) {
    const row = data[i]
    if (!row[0]) continue
    const order = {}
    headers.forEach((h, idx) => {
      if (h === 'materials' || h === 'shipments') {
        try { order[h] = JSON.parse(row[idx] || '[]') } catch { order[h] = [] }
      } else if (h === 'qty' || h === 'receivedQty' || h === 'outstandingQty') {
        order[h] = Number(row[idx]) || 0
      } else {
        order[h] = row[idx] || ''
      }
    })
    orders.push(order)
  }

  return jsonResponse({ success: true, orders })
}

function getProducts(ss) {
  const sheet = ss.getSheetByName('products')
  if (!sheet) return jsonResponse({ success: true, products: [] })

  const data = sheet.getDataRange().getValues()
  if (data.length <= 1) return jsonResponse({ success: true, products: [] })

  const headers = data[0]
  const products = []
  for (let i = 1; i < data.length; i++) {
    const row = data[i]
    if (!row[0]) continue
    const product = {}
    headers.forEach((h, idx) => {
      if (h === 'bom') {
        try { product[h] = JSON.parse(row[idx] || '[]') } catch { product[h] = [] }
      } else if (h === 'baseQty') {
        product[h] = Number(row[idx]) || 0
      } else {
        product[h] = row[idx] || ''
      }
    })
    products.push(product)
  }

  return jsonResponse({ success: true, products })
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)
}
