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
    } else if (action === 'syncConfig') {
      return syncConfig(ss, data.config)
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
    } else if (action === 'getConfig') {
      return getConfig(ss)
    } else if (action === 'getPiecesPerBox') {
      return getPiecesPerBoxAction(ss)
    } else if (action === 'savePiecesPerBox') {
      // Save piecesPerBoxMap via GET (avoids CORS issues with POST)
      var data = JSON.parse(decodeURIComponent(e.parameter.data || '{}'))
      return savePiecesPerBoxAction(ss, data)
    }

    return jsonResponse({ success: false, error: 'Unknown action' })
  } catch (err) {
    return jsonResponse({ success: false, error: err.message })
  }
}

function syncOrders(ss, orders) {
  let sheet = ss.getSheetByName('orders')
  const headers = ['id', 'orderNo', 'productId', 'productName', 'productUnit', 'qty', 'subcontractor', 'dueDate', 'status', 'receivedQty', 'outstandingQty', 'materials', 'shipments', 'bpr', 'lot', 'mfd', 'exp', 'createdAt', 'updatedAt']
  
  if (!sheet) {
    sheet = ss.insertSheet('orders')
    sheet.appendRow(headers)
  }

  // ⚡ SAFE UPSERT: ไม่ลบข้อมูลทั้ง sheet แต่อัปเดตทีละแถว
  // อ่านข้อมูลปัจจุบันจาก sheet
  const existingData = sheet.getDataRange().getValues()
  const existingHeaders = existingData[0] || headers
  const idIdx = existingHeaders.indexOf('id')
  const shipmentsIdx = existingHeaders.indexOf('shipments')
  
  // สร้าง map ของ order ที่มีอยู่ใน sheet (เก็บ row index)
  const existingMap = new Map()
  for (let i = 1; i < existingData.length; i++) {
    const id = String(existingData[i][idIdx] || '')
    if (id) {
      existingMap.set(id, {
        rowIndex: i + 1, // 1-indexed
        shipments: existingData[i][shipmentsIdx] || '[]'
      })
    }
  }

  let updated = 0, inserted = 0, skipped = 0

  orders.forEach(order => {
    if (!order.id) return
    
    const existing = existingMap.get(String(order.id))
    const incomingShipments = order.shipments || []
    const incomingShipCount = Array.isArray(incomingShipments) ? incomingShipments.length : 0
    
    // ป้องกันข้อมูลหาย: ถ้า cloud มี shipments มากกว่า incoming → ไม่ทับ
    if (existing) {
      let cloudShipCount = 0
      try {
        const cloudShips = JSON.parse(existing.shipments || '[]')
        cloudShipCount = Array.isArray(cloudShips) ? cloudShips.length : 0
      } catch(e) {}
      
      // ถ้า incoming มี shipments น้อยกว่า cloud → ใช้ shipments จาก cloud
      let shipmentsToSave = JSON.stringify(incomingShipments)
      if (incomingShipCount < cloudShipCount) {
        shipmentsToSave = existing.shipments // เก็บ shipments จาก cloud
        skipped++
      }
      
      // อัปเดตแถวที่มีอยู่
      const rowData = [
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
        shipmentsToSave,
        order.bpr || '',
        order.lot || '',
        order.mfd || '',
        order.exp || '',
        order.createdAt || new Date().toISOString(),
        new Date().toISOString()
      ]
      sheet.getRange(existing.rowIndex, 1, 1, headers.length).setValues([rowData])
      existingMap.delete(String(order.id)) // ลบออกจาก map (ที่เหลือคือ order ที่ไม่ได้ส่งมา)
      updated++
    } else {
      // เพิ่มแถวใหม่
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
        order.bpr || '',
        order.lot || '',
        order.mfd || '',
        order.exp || '',
        order.createdAt || new Date().toISOString(),
        new Date().toISOString()
      ])
      inserted++
    }
  })
  
  // หมายเหตุ: order ที่เหลืออยู่ใน existingMap คือ order ที่ไม่ได้ส่งมา
  // ❌ ไม่ลบ! เก็บไว้ใน sheet เพื่อป้องกันข้อมูลหาย

  return jsonResponse({ success: true, message: 'Orders synced: updated=' + updated + ', inserted=' + inserted + ', shipments_preserved=' + skipped })
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
  const headers = ['id', 'code', 'name', 'unit', 'baseQty', 'bom', 'createdAt']
  let sheet = ss.getSheetByName('products')
  if (!sheet) {
    sheet = ss.insertSheet('products')
    sheet.appendRow(headers)
  }

  // ⚡ SAFE UPSERT: อ่านข้อมูลปัจจุบันจาก sheet
  const existingData = sheet.getDataRange().getValues()
  const existingHeaders = existingData[0] || headers
  const idIdx = existingHeaders.indexOf('id')
  
  const existingMap = new Map()
  for (let i = 1; i < existingData.length; i++) {
    const id = String(existingData[i][idIdx] || '')
    if (id) existingMap.set(id, i + 1) // 1-indexed row
  }

  let updated = 0, inserted = 0

  products.forEach(product => {
    if (!product.id) return
    
    const rowData = [
      product.id || '',
      product.code || '',
      product.name || '',
      product.unit || '',
      product.baseQty || 0,
      JSON.stringify(product.bom || []),
      product.createdAt || new Date().toISOString()
    ]
    
    const existingRow = existingMap.get(String(product.id))
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, headers.length).setValues([rowData])
      existingMap.delete(String(product.id))
      updated++
    } else {
      sheet.appendRow(rowData)
      inserted++
    }
  })

  return jsonResponse({ success: true, message: 'Products synced: updated=' + updated + ', inserted=' + inserted })
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
        try { order[h] = JSON.parse(row[idx] || '[]') } catch(e) { order[h] = [] }
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
        try { product[h] = JSON.parse(row[idx] || '[]') } catch(e) { product[h] = [] }
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

function syncConfig(ss, config) {
  let sheet = ss.getSheetByName('config')
  if (!sheet) {
    sheet = ss.insertSheet('config')
  }
  sheet.clear()
  sheet.appendRow(['key', 'value'])
  // config is an object like { piecesPerBoxMap: {...} }
  for (const key in config) {
    sheet.appendRow([key, JSON.stringify(config[key])])
  }
  return jsonResponse({ success: true, message: 'Config synced' })
}

function getConfig(ss) {
  const sheet = ss.getSheetByName('config')
  if (!sheet) return jsonResponse({ success: true, config: {} })
  const data = sheet.getDataRange().getValues()
  if (data.length <= 1) return jsonResponse({ success: true, config: {} })
  const config = {}
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0]
    const val = data[i][1]
    if (key) {
      try { config[key] = JSON.parse(val) } catch(e) { config[key] = val }
    }
  }
  return jsonResponse({ success: true, config })
}

function savePiecesPerBoxAction(ss, data) {
  var sheet = ss.getSheetByName('ppb_config')
  if (!sheet) {
    sheet = ss.insertSheet('ppb_config')
  }
  sheet.clear()
  sheet.appendRow(['productName', 'piecesPerBox'])
  for (var key in data) {
    sheet.appendRow([key, data[key]])
  }
  return jsonResponse({ success: true, message: 'Saved ' + Object.keys(data).length + ' items' })
}

function getPiecesPerBoxAction(ss) {
  var sheet = ss.getSheetByName('ppb_config')
  if (!sheet) return jsonResponse({ success: true, data: {} })
  var values = sheet.getDataRange().getValues()
  var result = {}
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) {
      result[values[i][0]] = Number(values[i][1]) || 0
    }
  }
  return jsonResponse({ success: true, data: result })
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)
}
