'use strict';
const { Op } = require('sequelize');
const { Proforma, Invoice, Client, Quotation } = require('../models');
const {
  applyCompanyScope,
  applySellerCompanySnapshot,
  assertScopedRelation,
  findScopedByPk,
  getActorCompanyId,
  resolveScopedCompany,
  syncAccountsCompanyIds,
} = require('./accountsCompanyScope');
const {
  M, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, buildPdfFilename, buildTaxSummaryLabels, createDoc, addFooters,
  roundMoney, normalizeAccountItems, deriveItemTotals,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim();
  return code && code.toLowerCase() !== 'auto-generated' ? code : prefix + '-' + genCode();
}
function normalizeRoundOffMode(mode, amount) {
  if (mode === 'plus' || mode === 'minus' || mode === 'none') return mode;
  const value = Number(amount || 0);
  if (value > 0.004) return 'plus';
  if (value < -0.004) return 'minus';
  return 'none';
}
function fmtSignedINR(amount, mode) {
  const normalized = normalizeRoundOffMode(mode, amount);
  const prefix = normalized === 'plus' ? '+ ' : normalized === 'minus' ? '- ' : '';
  return prefix + fmtINR(Math.abs(Number(amount || 0)));
}
function shouldShowTaxPercentColumn(record) {
  if (!record) return true;
  if (record.showTaxPercentInPdf === false) return false;
  if (record.showTaxPercentInPdf === true) return true;
  return record.showTaxInPdf !== false;
}
function normalizedStateCode(code, gstin) {
  const raw = String(code || '').trim();
  if (raw) return raw.length === 1 ? '0' + raw : raw;
  const match = String(gstin || '').trim().match(/^(\d{2})/);
  return match ? match[1] : '';
}
function taxModeFromRecord(record, buyerStateCodeField, buyerGstinField) {
  const totalIgst = Number(record && record.totalIgst || 0);
  const totalCgst = Number(record && record.totalCgst || 0);
  const totalSgst = Number(record && record.totalSgst || 0);
  if (totalIgst > 0.004 && totalCgst <= 0.004 && totalSgst <= 0.004) return 'igst';
  if (totalCgst > 0.004 || totalSgst > 0.004) return 'split';
  const items = Array.isArray(record && record.items) ? record.items : [];
  if (items.some(it => Number(it && it.igst || 0) > 0.004)) return 'igst';
  if (items.some(it => Number(it && it.cgst || 0) > 0.004 || Number(it && it.sgst || 0) > 0.004)) return 'split';
  const sellerStateCode = normalizedStateCode(record && record.sellerStateCode, record && record.sellerGstin);
  const buyerStateCode = normalizedStateCode(record && record[buyerStateCodeField], record && record[buyerGstinField]);
  if (sellerStateCode && buyerStateCode && sellerStateCode !== buyerStateCode) return 'igst';
  return 'split';
}
function providedNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
function preferStoredMoney(value, derivedValue) {
  const stored = providedNumber(value);
  if (stored === null) return roundMoney(derivedValue);
  if (Math.abs(stored) <= 0.004 && Math.abs(derivedValue) > 0.004) return roundMoney(derivedValue);
  return roundMoney(stored);
}
function normalizeProformaRecord(record) {
  const plain = Object.assign({}, record || {});
  const rawMode = taxModeFromRecord(plain, 'customerStateCode', 'customerGstin');
  const items = normalizeAccountItems(plain.items, rawMode);
  const derived = deriveItemTotals(items);
  const roundOffMode = normalizeRoundOffMode(plain.roundOffMode, plain.roundOff);
  const roundOff = roundMoney(providedNumber(plain.roundOff) || 0);
  const derivedTotalTax = roundMoney(derived.totalCgst + derived.totalSgst + derived.totalIgst);
  plain.items = items;
  plain.subtotal = preferStoredMoney(plain.subtotal, derived.subtotal);
  plain.totalCgst = preferStoredMoney(plain.totalCgst, derived.totalCgst);
  plain.totalSgst = preferStoredMoney(plain.totalSgst, derived.totalSgst);
  plain.totalIgst = preferStoredMoney(plain.totalIgst, derived.totalIgst);
  plain.totalTax = preferStoredMoney(plain.totalTax, derivedTotalTax);
  plain.roundOffMode = roundOffMode;
  plain.roundOff = roundOff;
  plain.totalAmount = preferStoredMoney(plain.totalAmount, plain.subtotal + plain.totalTax + roundOff);
  return plain;
}

function currentFY() {
  const now = new Date(), yr = now.getFullYear(), mo = now.getMonth() + 1;
  const start = mo >= 4 ? yr : yr - 1;
  return String(start).slice(-2) + '-' + String(start + 1).slice(-2);
}

async function nextInvoiceNumber(code) {
  const safeFY   = currentFY();
  const safeCode = ((code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV');
  const random   = Math.random().toString(36).substr(2, 6).toUpperCase();
  // Global max sequence across ALL invoices in this FY (any code),
  // so converted invoices continue the same counter as manually created ones.
  const rows = await Invoice.findAll({
    attributes: ['invoiceNumber'],
    where: { invoiceNumber: { [Op.like]: `%/${safeFY}/%` } },
    raw: true,
  });
  let maxSeq = 0;
  rows.forEach(r => {
    const m = (r.invoiceNumber || '').match(/^(\d+)\//);
    if (m) { const n = parseInt(m[1], 10); if (n > maxSeq) maxSeq = n; }
  });
  return `${String(maxSeq + 1).padStart(3, '0')}/${safeCode}/${safeFY}/${random}`;
}

// ── GET /proformas-db ─────────────────────────────────────────────────────────
exports.getProformas = async (req, res) => {
  try {
    const { q, status } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { proformaNumber: { [Op.like]: `%${q}%` } },
      { customerName:   { [Op.like]: `%${q}%` } },
    ];
    const rows = await Proforma.findAll({ where, order: [['createdAt','DESC']],
      include: [{ model: Client, as: 'client', attributes: ['id','name','clientCode'] }] });
    res.json(rows.map(row => normalizeProformaRecord(row.toJSON())));
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /proformas-db/:id ─────────────────────────────────────────────────────
exports.getProforma = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const p = await findScopedByPk(Proforma, 'proforma', req, req.params.id, {
      include: [
        { model: Client, as: 'client' },
        { model: Quotation, as: 'sourceQuotation', attributes: ['id','quotationNumber'] },
      ],
    }, 'Proforma not found');
    if (!p) return res.status(404).json({ message: 'Proforma not found' });
    res.json(normalizeProformaRecord(p.toJSON()));
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /proformas-db ────────────────────────────────────────────────────────
exports.createProforma = async (req, res) => {
  try {
    const data = normalizeProformaRecord(Object.assign({}, req.body));
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.customerName) return res.status(400).json({ message: 'Customer name required' });
    if (data.clientId) {
      await assertScopedRelation(Client, 'client', req, data.clientId, 'Client not found');
    }
    if (data.sourceQuotationId) {
      await assertScopedRelation(Quotation, 'quotation', req, data.sourceQuotationId, 'Quotation not found');
    }
    const company = await resolveScopedCompany(req, data);
    if (company) applySellerCompanySnapshot(data, company);
    if (getActorCompanyId(req) && !data.companyId) {
      return res.status(400).json({ message: 'Admin company not found' });
    }
    data.proformaNumber = cleanGeneratedCode(data.proformaNumber, 'PRO');
    data.createdBy = req.user.id;
    const p = await Proforma.create(data);
    res.status(201).json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /proformas-db/:id ─────────────────────────────────────────────────────
exports.updateProforma = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const p = await findScopedByPk(Proforma, 'proforma', req, req.params.id, null, 'Proforma not found');
    if (!p) return res.status(404).json({ message: 'Proforma not found' });
    const updates = normalizeProformaRecord(Object.assign({}, p.toJSON(), req.body));
    if (updates.clientId) {
      await assertScopedRelation(Client, 'client', req, updates.clientId, 'Client not found');
    }
    if (updates.sourceQuotationId) {
      await assertScopedRelation(Quotation, 'quotation', req, updates.sourceQuotationId, 'Quotation not found');
    }
    const company = await resolveScopedCompany(req, Object.assign({}, p.toJSON(), updates));
    if (company) applySellerCompanySnapshot(updates, company);
    if (getActorCompanyId(req)) updates.companyId = getActorCompanyId(req);
    await p.update(updates);
    res.json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /proformas-db/:id ──────────────────────────────────────────────────
exports.deleteProforma = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const p = await findScopedByPk(Proforma, 'proforma', req, req.params.id, null, 'Proforma not found');
    if (!p) return res.status(404).json({ message: 'Proforma not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('proforma', p.id, req.user, p.toJSON(), p.proformaNumber);
    await p.destroy();
    res.json({ message: 'Proforma deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /proformas-db/:id/convert-to-invoice ─────────────────────────────────
exports.convertToInvoice = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const p = await findScopedByPk(Proforma, 'proforma', req, req.params.id, null, 'Proforma not found');
    if (!p) return res.status(404).json({ message: 'Proforma not found' });
    const source = normalizeProformaRecord(p.toJSON());

    // Derive company code from seller name initials (e.g. "DHPE Pvt Ltd" → "DHPE")
    const codeMatch = (source.sellerName || '').match(/^([A-Z0-9]+)/i);
    const compCode  = codeMatch ? codeMatch[1].toUpperCase().slice(0, 6) : 'INV';
    const invNumber = await nextInvoiceNumber(compCode);

    const inv = await Invoice.create({
      invoiceNumber:  invNumber,
      companyId:      source.companyId || null,
      invoiceDate:    source.date,
      clientId:       source.clientId,
      customerName:   source.customerName,
      customerGstin:  source.customerGstin,
      customerPan:    source.customerPan,
      customerEmail:  source.customerEmail,
      customerAddress:source.customerAddress,
      customerState:  source.customerState,
      customerStateCode: source.customerStateCode,
      sellerName:     source.sellerName,
      sellerGstin:    source.sellerGstin,
      sellerAddress:  source.sellerAddress,
      sellerState:    source.sellerState,
      sellerStateCode:source.sellerStateCode,
      sellerPhone:    source.sellerPhone,
      sellerEmail:    source.sellerEmail,
      sellerPan:      source.sellerPan,
      placeOfSupply:  source.placeOfSupply,
      billMonth:      source.billMonth,
      billPeriodFrom: source.billPeriodFrom,
      billPeriodTo:   source.billPeriodTo,
      workOrder:      source.workOrder,
      projectName:    source.projectName,
      workDetails:    source.workDetails,
      items:          source.items,
      sgstRate:       source.sgstRate,
      cgstRate:       source.cgstRate,
      subtotal:       source.subtotal,
      totalCgst:      source.totalCgst,
      totalSgst:      source.totalSgst,
      totalIgst:      source.totalIgst,
      totalTax:       source.totalTax,
      roundOffMode:   normalizeRoundOffMode(source.roundOffMode, source.roundOff),
      roundOff:       source.roundOff,
      totalAmount:    source.totalAmount,
      showTaxInPdf:   source.showTaxInPdf,
      showTaxPercentInPdf: shouldShowTaxPercentColumn(source),
      bankName:       source.bankName,
      bankAcName:     source.bankAcName,
      bankAccount:    source.bankAccount,
      bankIfsc:       source.bankIfsc,
      bankBranch:     source.bankBranch,
      notes:          source.notes,
      termsConditions:source.termsConditions,
      sourceDocId:    source.id,
      sourceDocType:  'proforma',
      convertedBadge: 'From Proforma',
      status:         'Draft',
      createdBy:      req.user.id,
    });

    await p.update({ status: 'Converted', convertedToInvoiceId: inv.id });
    res.status(201).json(inv);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /proformas-db/:id/pdf ─────────────────────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const record = await findScopedByPk(Proforma, 'proforma', req, req.params.id, null, 'Proforma not found');
    if (!record) return res.status(404).json({ message: 'Proforma not found' });
    const p = normalizeProformaRecord(record.toJSON());

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename="${buildPdfFilename([
        p.sellerName || 'DHPE',
        'Proforma-Invoice',
        p.proformaNumber || p.id,
      ])}"`);

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const PW = 595;
    const HW = W / 2;
    const RX = X + HW;
    const items   = p.items || [];
    const showItemTaxColumns = shouldShowTaxPercentColumn(p);
    const showTaxPercent = showItemTaxColumns;
    const useIGST = taxModeFromRecord(p, 'customerStateCode', 'customerGstin') === 'igst';
    const roundOffMode = normalizeRoundOffMode(p.roundOffMode, p.roundOff);

    // ── 1. HEADER ──────────────────────────────────────────────────────────────
    const sellerLines = [
      p.sellerName || '',
      p.sellerAddress ? 'Address: ' + p.sellerAddress : '',
      (p.sellerPhone || p.sellerEmail)
        ? 'Phone: '+(p.sellerPhone||'')+(p.sellerEmail?' | Email: '+p.sellerEmail:'') : '',
      [p.sellerGstin?'GSTIN: '+p.sellerGstin:'',
       p.sellerPan  ?'PAN: '  +p.sellerPan:'',
       p.sellerState?'State: '+p.sellerState+(p.sellerStateCode?', Code: '+p.sellerStateCode:''):'']
        .filter(Boolean).join(' | '),
    ].filter(Boolean);

    const metaRight = [
      'PROFORMA INVOICE',
      'Ref No.: '+(p.proformaNumber||''),
      'Date: '+fmtDate(p.date)+'   Status: '+(p.status||'Draft'),
      p.billMonth ? 'Bill for Month: '+p.billMonth : '',
      (p.billPeriodFrom && p.billPeriodTo)
        ? 'Bill Period: '+fmtDate(p.billPeriodFrom)+' to '+fmtDate(p.billPeriodTo) : '',
      p.validityDate ? 'Valid Till: '+fmtDate(p.validityDate) : '',
      p.placeOfSupply ? 'Place of Supply: '+p.placeOfSupply : '',
    ].filter(Boolean);

    let hBoxH = 8;
    sellerLines.forEach((l,i) => { hBoxH += txtH(l, HW-14, i===0?12:7.5, i===0) + 1.5; });
    const hBoxHR = metaRight.reduce((s,l,i) => s+txtH(l, HW-12, i===0?8.5:7.5, i===0)+1.5, 5);
    const headerH = Math.max(hBoxH, hBoxHR) + 5;

    box(X, M, W, headerH, LBD);
    vLine(X+HW, M, M+headerH, LBD);

    let ly = M+5;
    sellerLines.forEach((line,i) => {
      if (!line) return;
      txt(line, X+5, ly, HW-10, { size:i===0?12:7.5, bold:i===0, color:BLK, lineGap:0.5 });
      ly = doc.y + (i===0?2:1);
    });
    let ry = M+5;
    metaRight.forEach((line,i) => {
      if (!line) return;
      txt(line, RX+4, ry, HW-10, { size:i===0?8.5:7.5, bold:i===0, color:BLK, align:'right', lineGap:0.5 });
      ry = doc.y+1;
    });

    let y = M + headerH;

    // ── 2. BILL TO ─────────────────────────────────────────────────────────────
    y = drawSectionLabel({ fillBox, box, txt }, 'Bill To:', y);

    const custLeft  = [p.customerName||'', p.customerAddress||''].filter(Boolean);
    const custRight = [
      p.customerGstin ? 'GSTIN: '+p.customerGstin+(p.customerPan?' | PAN: '+p.customerPan:'') : '',
      p.customerEmail ? 'Email: '+p.customerEmail : '',
      p.customerState ? 'State: '+p.customerState+(p.customerStateCode?', Code: '+p.customerStateCode:'') : '',
    ].filter(Boolean);

    let billH = 6;
    custLeft.forEach((l,i)  => { billH += txtH(l, HW-12, i===0?8.5:7.5, i===0) + 1.5; });
    const billHR = custRight.reduce((s,l) => s+txtH(l, HW-12, 7.5)+1.5, 6);
    const billBoxH = Math.max(billH, billHR) + 3;

    box(X, y, W, billBoxH, LBD);
    vLine(X+HW, y, y+billBoxH, LBD);

    let by = y+4, bry = y+4;
    custLeft.forEach((line,i) => {
      if (!line) return;
      txt(line, X+5, by, HW-10, { size:i===0?8.5:7.5, bold:i===0, color:BLK });
      by = doc.y+0.5;
    });
    custRight.forEach(line => {
      if (!line) return;
      txt(line, RX+4, bry, HW-10, { size:7.5, color:BLK });
      bry = doc.y+0.5;
    });
    y += billBoxH;

    // ── 3. WORK ORDER / PROJECT (optional) ─────────────────────────────────────
    if (p.workOrder || p.projectName || p.workDetails) {
      const woLines = [
        p.workOrder   ? 'Work Order: '+p.workOrder : '',
        p.projectName ? 'Project Name: '+p.projectName : '',
        p.workDetails ? 'Work Details: '+p.workDetails : '',
      ].filter(Boolean);
      let woH = 5;
      woLines.forEach(l => { woH += txtH(l, W-12, 7.5) + 1.5; });
      woH += 3;
      y = checkPage(y, woH);
      box(X, y, W, woH, LBD);
      let wy = y+4;
      woLines.forEach((line,i) => {
        txt(line, X+5, wy, W-10, { size:7.5, bold:i===0||line.startsWith('Project'), color:BLK });
        wy = doc.y+0.5;
      });
      y += woH;
    }

    // ── 4. ITEMS TABLE ─────────────────────────────────────────────────────────
    // Shared helpers for dynamic layout
    function textW(text, size, bold) {
      doc.fontSize(size || 7.2).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      return doc.widthOfString(String(text || ''));
    }
    function cellMoney(n) {
      return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function dynW(values, min, max, size, bold, pad) {
      const widest = values.reduce((mx, v) => Math.max(mx, textW(v, size, bold)), 0);
      return Math.max(min, Math.min(max, Math.ceil(widest + (pad || 8))));
    }
    function fitLayout(layout, minDesc, adjustable) {
      let fixed = Object.keys(layout).reduce((sum, key) => sum + layout[key], 0);
      let desc = W - fixed;
      let deficit = minDesc - desc;
      if (deficit > 0) {
        adjustable.forEach(item => {
          if (deficit <= 0) return;
          const current = layout[item.key];
          const canReduce = current - item.min;
          if (canReduce <= 0) return;
          const reduceBy = Math.min(canReduce, deficit);
          layout[item.key] = current - reduceBy;
          deficit -= reduceBy;
        });
        fixed = Object.keys(layout).reduce((sum, key) => sum + layout[key], 0);
        desc = W - fixed;
      }
      layout.desc = desc;
      return layout;
    }
    function fitTextSize(text, maxWidth, baseSize, minSize, bold) {
      let size = baseSize;
      while (size > minSize) {
        if (textW(text, size, bold) <= maxWidth) return size;
        size -= 0.2;
      }
      return minSize;
    }
    function breakToken(token, maxW, size, bold) {
      const chunks = []; let cur = '';
      doc.fontSize(size || 7.2).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      String(token || '').split('').forEach(ch => {
        const probe = cur + ch;
        if (cur && doc.widthOfString(probe) > maxW) { chunks.push(cur); cur = ch; }
        else cur = probe;
      });
      if (cur) chunks.push(cur);
      return chunks;
    }
    function wrapLines(text, maxW, size, bold) {
      const lines = [];
      doc.fontSize(size || 7.2).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      String(text || '-').replace(/\r/g, '').split('\n').forEach(raw => {
        const words = raw.trim().split(/\s+/).filter(Boolean);
        if (!words.length) { lines.push(''); return; }
        let line = '';
        words.forEach(word => {
          const frags = doc.widthOfString(word) > maxW ? breakToken(word, maxW, size, bold) : [word];
          frags.forEach(f => {
            const probe = line ? line + ' ' + f : f;
            if (line && doc.widthOfString(probe) > maxW) { lines.push(line); line = f; }
            else line = probe;
          });
        });
        if (line) lines.push(line);
      });
      return lines.length ? lines : ['-'];
    }

    // Compute per-column content widths
    const codeTexts = items.map(it => String(it.itemCode || '').trim() || '-').concat(['Code']);
    const hsnTexts = items.map(it => String(it.hsnCode || '').trim() || '-').concat(['HSN/SAC']);
    const unitTexts = items.map(it => String(it.unit || '').trim() || '-').concat(['Unit']);
    const qtyTexts = items.map(it => {
      const qty = parseFloat(it.quantity || 0);
      return qty % 1 === 0 ? String(qty) : qty.toFixed(3);
    }).concat(['Qty']);
    const priceTexts = items.map(it => cellMoney(parseFloat(it.unitPrice || 0))).concat(['Rate']);
    const amtTexts = items.map(it => {
      const qty = parseFloat(it.quantity || 0), price = parseFloat(it.unitPrice || 0);
      const disc = parseFloat(it.discount || 0);
      const taxable = parseFloat(it.taxableAmount || (qty * price * (1 - disc / 100)));
      return cellMoney(taxable);
    }).concat(['Amount']);
    const taxPctTexts = items.map(it => parseFloat(it.taxRate || 0).toFixed(0) + '%').concat(['Tax %']);
    const taxAmtTexts = items.map(it =>
      useIGST ? cellMoney(parseFloat(it.igst || 0))
              : cellMoney(parseFloat(it.cgst || 0) + parseFloat(it.sgst || 0))
    ).concat(['Tax Amt']);

    const COL = !showItemTaxColumns
      ? fitLayout({
          sl: 18,
          code: dynW(codeTexts, 28, 50, 7.1, false, 8),
          hsn: dynW(hsnTexts, 34, 58, 7.1, false, 8),
          unit: dynW(unitTexts, 26, 44, 7.1, false, 8),
          qty: dynW(qtyTexts, 22, 36, 7.1, false, 8),
          rate: dynW(priceTexts, 42, 72, 7.1, false, 10),
          amt: dynW(amtTexts, 82, 112, 7.1, true, 12),
        }, 180, [
          { key: 'amt', min: 82 },
          { key: 'rate', min: 42 },
          { key: 'hsn', min: 34 },
          { key: 'unit', min: 26 },
          { key: 'code', min: 28 },
          { key: 'qty', min: 22 },
        ])
      : fitLayout({
          sl: 18,
          code: dynW(codeTexts, 26, 48, 7.1, false, 8),
          hsn: dynW(hsnTexts, 32, 54, 7.1, false, 8),
          unit: dynW(unitTexts, 26, 42, 7.1, false, 8),
          qty: dynW(qtyTexts, 20, 34, 7.1, false, 8),
          rate: dynW(priceTexts, 40, 66, 7.1, false, 10),
          taxP: showTaxPercent ? dynW(taxPctTexts, 22, 36, 6.3, true, 8) : 0,
          taxAmt: dynW(taxAmtTexts, 48, 82, 7.1, false, 10),
          amt: dynW(amtTexts, 78, 110, 7.1, true, 12),
        }, showTaxPercent ? 145 : 165, [
          { key: 'amt', min: 78 },
          { key: 'taxAmt', min: 48 },
          { key: 'rate', min: 40 },
          { key: 'hsn', min: 32 },
          { key: 'unit', min: 26 },
          { key: 'code', min: 26 },
          { key: 'qty', min: 20 },
          ...(showTaxPercent ? [{ key: 'taxP', min: 22 }] : []),
        ]);

    const ROW_H = 14;
    const DATA_ROW_MIN = 16;
    const LINE_H = 8;
    const SEC_H = 11;

    function drawProHeader(startY, withLabel) {
      let hy = startY;
      if (withLabel) {
        fillBox(X, hy, W, SEC_H, HBG);
        box(X, hy, W, SEC_H, LBD);
        txt('Item Details', X+5, hy+2, W-10, { size:7.5, bold:true, color:BLK });
        hy += SEC_H;
      }
      fillBox(X, hy, W, ROW_H, HBG);
      box(X, hy, W, ROW_H, LBD);
      let hx = X;
      function th(label, w) {
        vLine(hx, hy, hy+ROW_H, LBD);
        txt(label, hx+2, hy+3, w-4, { size:6.3, bold:true, color:BLK, align:'center' });
        hx += w;
      }
      th('Sl.', COL.sl); th('Code', COL.code); th('Description', COL.desc);
      th('HSN/SAC', COL.hsn); th('Unit', COL.unit); th('Rate', COL.rate); th('Qty', COL.qty);
      if (showItemTaxColumns) {
        if (showTaxPercent) th('Tax %', COL.taxP);
        th(useIGST ? 'IGST Amt' : 'Tax Amt', COL.taxAmt);
      }
      th('Amount', COL.amt);
      return hy + ROW_H;
    }

    y = checkPage(y, SEC_H + ROW_H + DATA_ROW_MIN);
    y = drawProHeader(y, true);

    items.forEach((it, idx) => {
      const qty     = parseFloat(it.quantity      || 0);
      const price   = parseFloat(it.unitPrice     || 0);
      const disc    = parseFloat(it.discount      || 0);
      const taxRate = parseFloat(it.taxRate       || 0);
      const taxable = parseFloat(it.taxableAmount || (qty * price * (1 - disc / 100)));
      const igstAmt = parseFloat(it.igst  || 0);
      const cgstAmt = parseFloat(it.cgst  || 0);
      const sgstAmt = parseFloat(it.sgst  || 0);
      const itemCode  = String(it.itemCode || '').trim();
      const descText  = String(it.name || it.description || it.itemName || '').trim() || '-';
      const descLns   = wrapLines(descText, COL.desc - 10, 7.1, false);
      let lineIdx = 0, firstSeg = true;

      while (lineIdx < descLns.length) {
        let avail = PH - M - FOOTER_H - y;
        if (avail < DATA_ROW_MIN) { doc.addPage(); y = drawProHeader(M, false); avail = PH - M - FOOTER_H - y; }
        const segCount = Math.min(descLns.length - lineIdx, Math.max(1, Math.floor((avail - 6) / LINE_H)));
        if (!segCount) { doc.addPage(); y = drawProHeader(M, false); continue; }
        const rowH = Math.max(DATA_ROW_MIN, segCount * LINE_H + 6);

        if ((idx + (firstSeg ? 0 : 1)) % 2 === 0) fillBox(X, y, W, rowH, '#fafafa');
        box(X, y, W, rowH, LBD);

        let dcx = X;
        function td(text, w, opts) {
          vLine(dcx, y, y+rowH, LBD);
          const to = Object.assign({ size:7.4, align:'center', lineGap:0.5 }, opts||{});
          const raw = String(text || '');
          const size = to.fit ? fitTextSize(raw, w - 6, to.size, to.minSize || 6.2, !!to.bold) : to.size;
          txt(raw, dcx+3, y+3, w-6, Object.assign({}, to, { size }));
          dcx += w;
        }
        function tdDesc(lns, w) {
          vLine(dcx, y, y+rowH, LBD);
          lns.forEach((line, i) => {
            txt(line, dcx+3, y+3+(i*LINE_H), w-6, { size:7.1, align:'left', lineGap:0, color:DRK });
          });
          dcx += w;
        }

        const seg = descLns.slice(lineIdx, lineIdx + segCount);
        td(firstSeg ? idx + 1 : '',                                 COL.sl);
        td(firstSeg ? itemCode : '',                                COL.code, { fit:true, minSize:5.6, lineBreak:false, ellipsis:true });
        tdDesc(seg,                                                 COL.desc);
        td(firstSeg ? (it.hsnCode || '') : '',                     COL.hsn, { fit:true, minSize:5.6, lineBreak:false, ellipsis:true });
        td(firstSeg ? (it.unit || '') : '',                        COL.unit, { fit:true, minSize:5.6, lineBreak:false, ellipsis:true });
        td(firstSeg ? cellMoney(price) : '',                       COL.rate, { align:'right', fit:true, minSize:5.8, lineBreak:false });
        td(firstSeg ? (qty % 1 === 0 ? qty : qty.toFixed(3)) : '', COL.qty, { fit:true, minSize:5.8, lineBreak:false });
        if (showItemTaxColumns) {
          if (showTaxPercent) {
            td(firstSeg ? taxRate.toFixed(0) + '%' : '', COL.taxP, { fit:true, minSize:5.8, lineBreak:false });
          }
          td(firstSeg ? cellMoney(useIGST ? igstAmt : cgstAmt + sgstAmt) : '', COL.taxAmt, { align:'right', fit:true, minSize:5.8, lineBreak:false });
        }
        td(firstSeg ? cellMoney(taxable) : '', COL.amt, { align:'right', bold:true, size:7.2, fit:true, minSize:5.6, lineBreak:false });

        y += rowH;
        lineIdx += segCount;
        firstSeg = false;
        if (lineIdx < descLns.length) { doc.addPage(); y = drawProHeader(M, false); }
      }
    });

    // ── 5. AMOUNT IN WORDS + SUMMARY ───────────────────────────────────────────
    y = checkPage(y, 60);
    const igstV = parseFloat(p.totalIgst || 0);
    const cgstV = parseFloat(p.totalCgst || 0);
    const sgstV = parseFloat(p.totalSgst || 0);
    const hasSplit = cgstV > 0.004 || sgstV > 0.004;
    const splitTotal = cgstV + sgstV;
    const taxLabels = buildTaxSummaryLabels(p, useIGST ? 'igst' : 'split');

    const sumLines = [
      ['Subtotal:', fmtINR(p.subtotal)],
      ...(igstV > 0.004 ? [[taxLabels.igst + ':', fmtINR(igstV)]] : []),
      ...(cgstV > 0.004 ? [[taxLabels.cgst + ':', fmtINR(cgstV)]] : []),
      ...(sgstV > 0.004 ? [[taxLabels.sgst + ':', fmtINR(sgstV)]] : []),
      ...(hasSplit && splitTotal > 0.004 ? [['Total Tax:', fmtINR(splitTotal)]] : []),
      ...(roundOffMode !== 'none' ? [['Round Off:', fmtSignedINR(p.roundOff, roundOffMode)]] : []),
    ];
    const sumRowH   = 11;
    const sumTotalH = 14;
    const sumH      = sumLines.length * sumRowH + sumTotalH;
    const wordText  = numWords(parseFloat(p.totalAmount || 0));
    const wordH     = txtH(wordText, HW - 14, 7.5);
    const botH      = Math.max(sumH, wordH + 16);

    box(X, y, W, botH, LBD);
    vLine(X + HW, y, y + botH, LBD);

    txt('Amount in Words:', X+5, y+4, HW-10, { size:7.5, bold:true, color:BLK });
    txt(wordText, X+5, y+14, HW-10, { size:7.5, color:BLK });

    let sy = y;
    sumLines.forEach(([label, val]) => {
      sy += sumRowH;
      txt(label, X+HW+4, sy-8, HW/2-6, { size:7.5, color:BLK });
      txt(val,   X+HW+HW/2, sy-8, HW/2-6, { size:7.5, align:'right', color:BLK });
      hLine(sy, X+HW, X+W, LBD);
    });

    fillBox(X+HW, sy, HW, sumTotalH, HBG);
    box(X+HW, sy, HW, sumTotalH, LBD);
    txt('Amount After Tax:', X+HW+4, sy+3, HW/2-6, { size:8, bold:true, color:BLK });
    txt(fmtINR(p.totalAmount), X+HW+HW/2, sy+3, HW/2-6, { size:8, bold:true, color:BLK, align:'right' });
    y += botH;

    // ── 6. BANK + SIGNATURE ────────────────────────────────────────────────────
    y = checkPage(y, 70);
    const bankLines = [
      ['Bank:',     p.bankName    || 'N/A'],
      ['A/c Name:', p.bankAcName  || 'N/A'],
      ['A/c No.:',  p.bankAccount || 'N/A'],
      ['IFSC:',     p.bankIfsc    || 'N/A'],
      ['Branch:',   p.bankBranch  || 'N/A'],
    ];
    y = drawSignature({ fillBox, box, vLine, hLine, txt }, y, p.sellerName, bankLines);

    // ── 7. PAYMENT TERMS / DELIVERY / WARRANTY ─────────────────────────────────
    const extraLines = [
      p.paymentTerms    ? 'Payment Terms: '    + p.paymentTerms    : '',
      p.deliveryTimeline? 'Delivery Timeline: ' + p.deliveryTimeline: '',
      p.warranty        ? 'Warranty: '          + p.warranty        : '',
    ].filter(Boolean);

    if (extraLines.length) {
      let exH = 5;
      extraLines.forEach(l => { exH += txtH(l, W-12, 7.5) + 1.5; });
      exH += 3;
      y = checkPage(y, exH);
      box(X, y, W, exH, LBD);
      let ey = y+4;
      extraLines.forEach(line => {
        txt(line, X+5, ey, W-10, { size:7.5, color:BLK });
        ey = doc.y+0.5;
      });
      y += exH;
    }

    // ── 8. NOTES / TERMS ───────────────────────────────────────────────────────
    const noteLines = [
      String(p.notes || '').trim() ? 'Remarks: ' + String(p.notes).trim() : '',
      String(p.termsConditions || '').trim() ? 'Terms & Conditions: ' + String(p.termsConditions).trim() : '',
    ].filter(Boolean);
    if (noteLines.length) {
      const noteH = noteLines.reduce((sum, line) => sum + txtH(line, W - 10, 7, false) + 2, 5);
      y = checkPage(y, noteH);
      box(X, y, W, noteH, LBD);
      let ny = y + 4;
      noteLines.forEach(line => {
        txt(line, X + 5, ny, W - 10, { size: 7, color: GRY });
        ny = doc.y + 2;
      });
    }

    const footerInfoText = 'This is a computer-generated proforma invoice, not a tax invoice.';
    const CONF_TEXT =
      'Note: This document is the property of DHPE and is confidential. It must not be disclosed, ' +
      'shared, or transmitted to any person or firm not authorized by us. No part of this ' +
      'document may be copied, reproduced, or used in whole or in part without our prior written consent.';

    const pageRange  = doc.bufferedPageRange();
    const totalPages = pageRange.count;
    for (let pi = 0; pi < totalPages; pi++) {
      doc.switchToPage(pageRange.start + pi);
      box(X, M, W, PH - (M * 2), LBD);
    }
    if (totalPages) {
      for (let pi = 0; pi < totalPages; pi++) {
        doc.switchToPage(pageRange.start + pi);
        const footerY = PH - M - FOOTER_H + 3;
        const pageLabelW = 60;
        const sepX = X + W - pageLabelW - 8;
        const noteW = sepX - X - 6;
        const showInfo = pi === totalPages - 1;
        doc.moveTo(X, footerY).lineTo(X + W, footerY).lineWidth(0.3).strokeColor('#d7dce5').stroke();
        doc.moveTo(sepX, footerY + 2).lineTo(sepX, footerY + FOOTER_H - 8).lineWidth(0.3).strokeColor('#d7dce5').stroke();
        if (showInfo) {
          doc.fontSize(5.5).font('Helvetica-Oblique').fillColor('#8a94a3')
             .text(footerInfoText, X + 4, footerY + 1, { width: noteW, align: 'left', lineGap: 0 });
        }
        doc.fontSize(showInfo ? 4.9 : 5.2).font('Helvetica').fillColor('#7c8797')
           .text(CONF_TEXT, X + 4, showInfo ? footerY + 8 : footerY + 3, {
             width: noteW,
             align: 'center',
             lineGap: showInfo ? 0.1 : 0.15,
           });
        doc.fontSize(5.8).font('Helvetica').fillColor('#7c8797')
           .text(`Page ${pi + 1} of ${totalPages}`, sepX + 4, showInfo ? footerY + 7 : footerY + 4, {
             width: pageLabelW,
             align: 'right',
             lineGap: 0,
           });
      }
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};
