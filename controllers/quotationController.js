'use strict';
const { Op } = require('sequelize');
const { Quotation, Proforma, Invoice, Client } = require('../models');
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
  M, W, X, BLK, GRY, HBG, LBD,
  fmtDate, fmtINR, numWords, buildPdfFilename, buildTaxSummaryLabels, createDoc, addFooters,
  roundMoney, normalizeAccountItems, deriveItemTotals,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim();
  return code && code.toLowerCase() !== 'auto-generated' ? code : prefix + '-' + genCode();
}
function inferRoundOffMode(value) {
  const amount = Number(value || 0);
  if (amount > 0.004) return 'plus';
  if (amount < -0.004) return 'minus';
  return 'none';
}
function currentFY() {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() + 1 >= 4 ? year : year - 1;
  return String(start).slice(-2) + '-' + String(start + 1).slice(-2);
}
async function nextInvoiceNumber(code) {
  const safeFY = currentFY();
  const safeCode = String(code || 'INV').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV';
  const rows = await Invoice.findAll({
    attributes: ['invoiceNumber'],
    where: { invoiceNumber: { [Op.like]: `%/${safeFY}/%` } },
    raw: true,
  });
  const maxSequence = rows.reduce((max, row) => {
    const match = String(row.invoiceNumber || '').match(/^(\d+)\//);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${String(maxSequence + 1).padStart(3, '0')}/${safeCode}/${safeFY}/${random}`;
}
function normalizedStateCode(code, gstin) {
  const raw = String(code || '').trim();
  if (raw) return raw.length === 1 ? '0' + raw : raw;
  const match = String(gstin || '').trim().match(/^(\d{2})/);
  return match ? match[1] : '';
}
function taxModeFromQuotation(record) {
  const totalIgst = Number(record && record.totalIgst || 0);
  const totalCgst = Number(record && record.totalCgst || 0);
  const totalSgst = Number(record && record.totalSgst || 0);
  if (totalIgst > 0.004 && totalCgst <= 0.004 && totalSgst <= 0.004) return 'igst';
  if (totalCgst > 0.004 || totalSgst > 0.004) return 'split';
  const items = Array.isArray(record && record.items) ? record.items : [];
  if (items.some(it => Number(it && it.igst || 0) > 0.004)) return 'igst';
  if (items.some(it => Number(it && it.cgst || 0) > 0.004 || Number(it && it.sgst || 0) > 0.004)) return 'split';
  const sellerStateCode = normalizedStateCode(record && record.sellerStateCode, record && record.sellerGstin);
  const clientStateCode = normalizedStateCode(record && record.clientStateCode, record && record.clientGstin);
  if (sellerStateCode && clientStateCode && sellerStateCode !== clientStateCode) return 'igst';
  return 'split';
}
// Copy the linked client's master data onto the quotation so the PDF and the
// conversions (proforma / invoice) always carry the client's current details.
function applyClientSnapshot(target, client) {
  if (!target || !client) return target;
  target.clientId = client.id;
  target.clientName = client.name || '';
  target.clientGstin = client.gstin || '';
  target.clientPan = client.pan || '';
  target.clientEmail = client.email || '';
  target.clientAddress = client.billingAddress || '';
  target.clientState = client.state || '';
  target.clientStateCode = normalizedStateCode(client.stateCode, client.gstin);
  return target;
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
// An empty "Valid Till" used to be stored as 0000-00-00; treat that as no date.
function cleanOptionalDate(value) {
  const v = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && v !== '0000-00-00' ? v : null;
}
function normalizeQuotationRecord(record) {
  const plain = Object.assign({}, record || {});
  plain.validTill = cleanOptionalDate(plain.validTill);
  const taxMode = taxModeFromQuotation(plain);
  const items = normalizeAccountItems(plain.items, taxMode);
  const derived = deriveItemTotals(items);
  const roundOff = roundMoney(providedNumber(plain.roundOff) || 0);
  const derivedTotalTax = roundMoney(derived.totalCgst + derived.totalSgst + derived.totalIgst);
  plain.items = items;
  // Items are the source of truth. Never accept a browser-supplied summary that
  // disagrees with them, otherwise a quotation can show an incorrect total.
  const hasItems = Array.isArray(plain.items) && plain.items.length > 0;
  plain.subtotal = hasItems ? roundMoney(derived.subtotal) : preferStoredMoney(plain.subtotal, derived.subtotal);
  plain.totalCgst = hasItems ? roundMoney(derived.totalCgst) : preferStoredMoney(plain.totalCgst, derived.totalCgst);
  plain.totalSgst = hasItems ? roundMoney(derived.totalSgst) : preferStoredMoney(plain.totalSgst, derived.totalSgst);
  plain.totalIgst = hasItems ? roundMoney(derived.totalIgst) : preferStoredMoney(plain.totalIgst, derived.totalIgst);
  plain.totalTax = hasItems ? derivedTotalTax : preferStoredMoney(plain.totalTax, derivedTotalTax);
  plain.roundOff = roundOff;
  plain.totalAmount = hasItems
    ? roundMoney(plain.subtotal + plain.totalTax + roundOff)
    : preferStoredMoney(plain.totalAmount, plain.subtotal + plain.totalTax + roundOff);
  return plain;
}

// ── GET /quotations ───────────────────────────────────────────────────────────
exports.getQuotations = async (req, res) => {
  try {
    const { q, status } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { quotationNumber: { [Op.like]: `%${q}%` } },
      { clientName:      { [Op.like]: `%${q}%` } },
    ];
    const rows = await Quotation.findAll({ where, order: [['createdAt','DESC']],
      include: [{ model: Client, as: 'client', attributes: ['id','name','clientCode'] }] });
    res.json(rows.map(row => normalizeQuotationRecord(row.toJSON())));
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /quotations/:id ──────────────────────────────────────────────────────
exports.getQuotation = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const q = await findScopedByPk(Quotation, 'quotation', req, req.params.id, {
      include: [{ model: Client, as: 'client' }]
    }, 'Quotation not found');
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    res.json(normalizeQuotationRecord(q.toJSON()));
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations ─────────────────────────────────────────────────────────
exports.createQuotation = async (req, res) => {
  try {
    const data = normalizeQuotationRecord(Object.assign({}, req.body));
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.clientId) return res.status(400).json({ message: 'Please select a client from the Client list' });
    const client = await assertScopedRelation(Client, 'client', req, data.clientId, 'Client not found');
    applyClientSnapshot(data, client);
    if (data.validTill && data.validTill < data.date) {
      return res.status(400).json({ message: 'Valid Till date cannot be before the quotation date' });
    }
    const company = await resolveScopedCompany(req, data);
    if (company) applySellerCompanySnapshot(data, company);
    if (getActorCompanyId(req) && !data.companyId) {
      return res.status(400).json({ message: 'Admin company not found' });
    }
    data.quotationNumber = cleanGeneratedCode(data.quotationNumber, 'QUO');
    data.createdBy = req.user.id;
    const q = await Quotation.create(data);
    res.status(201).json(q);
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── PUT /quotations/:id ──────────────────────────────────────────────────────
exports.updateQuotation = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const q = await findScopedByPk(Quotation, 'quotation', req, req.params.id, null, 'Quotation not found');
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    const updates = normalizeQuotationRecord(Object.assign({}, q.toJSON(), req.body));
    if (!updates.clientId) return res.status(400).json({ message: 'Please select a client from the Client list' });
    const client = await assertScopedRelation(Client, 'client', req, updates.clientId, 'Client not found');
    applyClientSnapshot(updates, client);
    if (updates.validTill && updates.validTill < updates.date) {
      return res.status(400).json({ message: 'Valid Till date cannot be before the quotation date' });
    }
    if (!String(updates.quotationNumber || '').trim()) {
      return res.status(400).json({ message: 'Quotation number is required' });
    }
    const company = await resolveScopedCompany(req, Object.assign({}, q.toJSON(), updates));
    if (company) applySellerCompanySnapshot(updates, company);
    if (getActorCompanyId(req)) updates.companyId = getActorCompanyId(req);
    await q.update(updates);
    res.json(q);
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── DELETE /quotations/:id ───────────────────────────────────────────────────
exports.deleteQuotation = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const q = await findScopedByPk(Quotation, 'quotation', req, req.params.id, null, 'Quotation not found');
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('quotation', q.id, req.user, q.toJSON(), q.quotationNumber);
    await q.destroy();
    res.json({ message: 'Quotation deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations/:id/convert-to-proforma ─────────────────────────────────
exports.convertToProforma = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const q = await findScopedByPk(Quotation, 'quotation', req, req.params.id, null, 'Quotation not found');
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    if (q.status === 'Converted' || q.convertedToId) {
      return res.status(409).json({ message: 'This quotation has already been converted' });
    }
    const source = normalizeQuotationRecord(q.toJSON());

    const pro = await Proforma.create({
      proformaNumber: 'PRO-' + genCode(),
      companyId:      source.companyId || null,
      clientId:       source.clientId,
      sourceQuotationId: source.id,
      customerName:      source.clientName,
      customerGstin:     source.clientGstin,
      customerPan:       source.clientPan,
      customerEmail:     source.clientEmail,
      customerAddress:   source.clientAddress,
      customerState:     source.clientState,
      customerStateCode: source.clientStateCode,
      sellerName:        source.sellerName,
      sellerGstin:       source.sellerGstin,
      sellerAddress:     source.sellerAddress,
      sellerState:       source.sellerState,
      sellerStateCode:   source.sellerStateCode,
      sellerPhone:       source.sellerPhone,
      sellerEmail:       source.sellerEmail,
      sellerPan:         source.sellerPan,
      date:          source.date,
      validityDate:  source.validTill,
      items:         source.items,
      sgstRate:      source.sgstRate,
      cgstRate:      source.cgstRate,
      subtotal:      source.subtotal,
      totalCgst:     source.totalCgst,
      totalSgst:     source.totalSgst,
      totalIgst:     source.totalIgst,
      totalTax:      source.totalTax,
      roundOffMode:  inferRoundOffMode(source.roundOff),
      roundOff:      source.roundOff,
      totalAmount:   source.totalAmount,
      showTaxPercentInPdf: true,
      bankName:      source.bankName,
      bankAcName:    source.bankAcName,
      bankAccount:   source.bankAccount,
      bankIfsc:      source.bankIfsc,
      bankBranch:    source.bankBranch,
      notes:         source.notes,
      termsConditions: source.termsConditions,
      status:        'Draft',
      createdBy:     req.user.id,
    });

    await q.update({ status: 'Converted', convertedToId: pro.id, convertedToType: 'proforma' });
    res.status(201).json(pro);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations/:id/convert-to-invoice ──────────────────────────────────
exports.convertToInvoice = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const q = await findScopedByPk(Quotation, 'quotation', req, req.params.id, null, 'Quotation not found');
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    if (q.status === 'Converted' || q.convertedToId) {
      return res.status(409).json({ message: 'This quotation has already been converted' });
    }
    const source = normalizeQuotationRecord(q.toJSON());
    const companyCode = String(source.sellerName || 'INV').match(/[A-Z0-9]+/i);

    const inv = await Invoice.create({
      invoiceNumber:  await nextInvoiceNumber(companyCode ? companyCode[0] : 'INV'),
      companyId:      source.companyId || null,
      invoiceDate:    source.date,
      clientId:       source.clientId,
      customerName:   source.clientName,
      customerGstin:  source.clientGstin,
      customerPan:    source.clientPan,
      customerEmail:  source.clientEmail,
      customerAddress:source.clientAddress,
      customerState:  source.clientState,
      customerStateCode: source.clientStateCode,
      sellerName:     source.sellerName,
      sellerGstin:    source.sellerGstin,
      sellerAddress:  source.sellerAddress,
      sellerState:    source.sellerState,
      sellerStateCode:source.sellerStateCode,
      sellerPhone:    source.sellerPhone,
      sellerEmail:    source.sellerEmail,
      sellerPan:      source.sellerPan,
      items:          source.items,
      sgstRate:       source.sgstRate,
      cgstRate:       source.cgstRate,
      subtotal:       source.subtotal,
      totalCgst:      source.totalCgst,
      totalSgst:      source.totalSgst,
      totalIgst:      source.totalIgst,
      totalTax:       source.totalTax,
      roundOffMode:   inferRoundOffMode(source.roundOff),
      roundOff:       source.roundOff,
      totalAmount:    source.totalAmount,
      showTaxPercentInPdf: true,
      bankName:       source.bankName,
      bankAcName:     source.bankAcName,
      bankAccount:    source.bankAccount,
      bankIfsc:       source.bankIfsc,
      bankBranch:     source.bankBranch,
      notes:          source.notes,
      termsConditions:source.termsConditions,
      sourceDocId:    source.id,
      sourceDocType:  'quotation',
      convertedBadge: 'From Quotation',
      status:         'Draft',
      createdBy:      req.user.id,
    });

    await q.update({ status: 'Converted', convertedToId: inv.id, convertedToType: 'invoice' });
    res.status(201).json(inv);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /quotations/:id/pdf ───────────────────────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const record = await findScopedByPk(Quotation, 'quotation', req, req.params.id, {
      include: [{ model: Client, as: 'client', required: false }],
    }, 'Quotation not found');
    if (!record) return res.status(404).json({ message: 'Quotation not found' });
    const q = normalizeQuotationRecord(record.toJSON());

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename="${buildPdfFilename([
        q.sellerName || 'DHPE',
        'Quotation',
        q.quotationNumber || q.id,
      ])}"`
    );

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const HW = W / 2;
    const RX = X + HW;
    const items = q.items || [];
    const useIGST = taxModeFromQuotation(q) === 'igst';

    const sellerLines = [
      q.sellerName || 'DHPE',
      q.sellerAddress ? 'Address: ' + q.sellerAddress : 'Address: 182 / 1 Purbachal, Rahara, Khardaha, North 24 PGS, Kolkata, West Bengal, Pin-700118',
      (q.sellerPhone || q.sellerEmail)
        ? 'Phone: ' + (q.sellerPhone || '') + (q.sellerEmail ? ' | Email: ' + q.sellerEmail : '') : 'Phone: +91-9876543210 | Email: contact@dhpe.in',
      [
        q.sellerGstin ? 'GSTIN: ' + q.sellerGstin : '',
        q.sellerPan ? 'PAN: ' + q.sellerPan : '',
        q.sellerState ? 'State: ' + q.sellerState + (q.sellerStateCode ? ', Code: ' + q.sellerStateCode : '') : '',
      ].filter(Boolean).join(' | '),
    ].filter(Boolean);

    const metaRight = [
      'QUOTATION',
      'Date: ' + fmtDate(q.date) + '   Status: ' + (q.status || 'Draft'),
      'Ref No.: ' + (q.quotationNumber || ''),
      q.validTill ? 'Valid Till: ' + fmtDate(q.validTill) : '',
    ].filter(Boolean);

    let hBoxH = 8;
    sellerLines.forEach((line, i) => { hBoxH += txtH(line, HW - 14, i === 0 ? 12 : 7.5, i === 0) + 1.5; });
    const hBoxHR = metaRight.reduce((sum, line, i) => sum + txtH(line, HW - 12, i === 0 ? 8.5 : 7.5, i === 0) + 1.5, 5);
    const headerH = Math.max(hBoxH, hBoxHR) + 5;

    box(X, M, W, headerH, LBD);
    vLine(X + HW, M, M + headerH, LBD);

    let ly = M + 5;
    sellerLines.forEach((line, i) => {
      txt(line, X + 5, ly, HW - 10, { size: i === 0 ? 12 : 7.5, bold: i === 0, color: BLK, lineGap: 0.5 });
      ly = doc.y + (i === 0 ? 2 : 1);
    });
    let ry = M + 5;
    metaRight.forEach((line, i) => {
      txt(line, RX + 4, ry, HW - 10, { size: i === 0 ? 8.5 : 7.5, bold: i === 0, color: BLK, align: 'right', lineGap: 0.5 });
      ry = doc.y + 1;
    });

    let y = M + headerH;
    y = drawSectionLabel({ fillBox, box, txt }, 'Quote To:', y);

    const clientLeft = [q.clientName || '', q.clientAddress || ''].filter(Boolean);
    const clientRight = [
      q.clientGstin ? 'GSTIN: ' + q.clientGstin : '',
      q.clientPan ? 'PAN: ' + q.clientPan : '',
      q.clientEmail ? 'Email: ' + q.clientEmail : '',
      q.clientState ? 'State: ' + q.clientState + (q.clientStateCode ? ', Code: ' + q.clientStateCode : '') : '',
    ].filter(Boolean);

    let clientLeftH = 6;
    clientLeft.forEach((line, i) => { clientLeftH += txtH(line, HW - 12, i === 0 ? 8.5 : 7.5, i === 0) + 1.5; });
    const clientRightH = clientRight.reduce((sum, line) => sum + txtH(line, HW - 12, 7.5) + 1.5, 6);
    const clientBoxH = Math.max(clientLeftH, clientRightH) + 3;

    box(X, y, W, clientBoxH, LBD);
    vLine(X + HW, y, y + clientBoxH, LBD);
    let cly = y + 4, cry = y + 4;
    clientLeft.forEach((line, i) => {
      txt(line, X + 5, cly, HW - 10, { size: i === 0 ? 8.5 : 7.5, bold: i === 0, color: BLK });
      cly = doc.y + 0.5;
    });
    clientRight.forEach(line => {
      txt(line, RX + 4, cry, HW - 10, { size: 7.5, color: BLK });
      cry = doc.y + 0.5;
    });
    y += clientBoxH;

    // Keep the quotation table consistent with the proforma table: one tax
    // percentage and one tax amount column, with widths fitted to real values.
    function textWidth(value, size, bold) {
      doc.fontSize(size || 7.1).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      return doc.widthOfString(String(value || ''));
    }
    function money(value) {
      return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function contentWidth(values, min, max, bold) {
      const widest = values.reduce((width, value) => Math.max(width, textWidth(value, 7.1, bold)), 0);
      return Math.max(min, Math.min(max, Math.ceil(widest + 10)));
    }

    const COL = {
      sl: 18,
      code: contentWidth(items.map(it => it.itemCode || '').concat(['Code']), 28, 48),
      hsn: contentWidth(items.map(it => it.hsnCode || '').concat(['HSN/SAC']), 34, 58),
      unit: contentWidth(items.map(it => it.unit || '').concat(['Unit']), 26, 42),
      rate: contentWidth(items.map(it => money(it.unitPrice)).concat(['Rate']), 42, 70),
      qty: contentWidth(items.map(it => String(it.quantity || 0)).concat(['Qty']), 22, 36),
      taxP: contentWidth(items.map(it => Number(it.taxRate || 0).toFixed(0) + '%').concat(['Tax %']), 28, 38),
      taxAmt: contentWidth(items.map(it => money(useIGST ? it.igst : Number(it.cgst || 0) + Number(it.sgst || 0))).concat(['Tax Amt']), 52, 78),
      amt: contentWidth(items.map(it => money(it.taxableAmount)).concat(['Amount']), 80, 112),
    };
    COL.desc = W - Object.values(COL).reduce((sum, width) => sum + width, 0);
    // Reserve enough space for descriptions by shrinking low-priority columns.
    [['amt', 80], ['taxAmt', 52], ['rate', 42], ['hsn', 34], ['unit', 26], ['code', 28], ['qty', 22], ['taxP', 28]].forEach(([key, min]) => {
      if (COL.desc >= 145) return;
      const reduction = Math.min(COL[key] - min, 145 - COL.desc);
      if (reduction > 0) { COL[key] -= reduction; COL.desc += reduction; }
    });

    const ROW_H = 14;
    const drawItemsHeader = (startY, withLabel) => {
      let headerY = startY;
      if (withLabel) headerY = drawSectionLabel({ fillBox, box, txt }, 'Item Details', headerY);
      fillBox(X, headerY, W, ROW_H, HBG);
      box(X, headerY, W, ROW_H, LBD);
      let hx = X;
      const th = (label, width) => {
        vLine(hx, headerY, headerY + ROW_H, LBD);
        txt(label, hx + 2, headerY + 3, width - 4, { size: 6.3, bold: true, color: BLK, align: 'center' });
        hx += width;
      };
      th('Sl.', COL.sl); th('Code', COL.code); th('Description', COL.desc); th('HSN/SAC', COL.hsn);
      th('Unit', COL.unit); th('Rate', COL.rate); th('Qty', COL.qty); th('Tax %', COL.taxP);
      th(useIGST ? 'IGST Amt' : 'Tax Amt', COL.taxAmt); th('Amount', COL.amt);
      return headerY + ROW_H;
    };

    y = checkPage(y, 26);
    y = drawItemsHeader(y, true);
    items.forEach((it, idx) => {
      const qty = Number(it.quantity || 0);
      const price = Number(it.unitPrice || 0);
      const taxRate = Number(it.taxRate || 0);
      const taxable = Number(it.taxableAmount || 0);
      const taxAmount = useIGST ? Number(it.igst || 0) : Number(it.cgst || 0) + Number(it.sgst || 0);
      const descText = String(it.name || it.description || it.itemName || '-').trim() || '-';
      const rowH = Math.max(16, txtH(descText, COL.desc - 8, 7.1) + 6);
      y = checkPage(y, rowH);
      if (y === M) y = drawItemsHeader(y, false);
      if (idx % 2 === 0) fillBox(X, y, W, rowH, '#fafafa');
      box(X, y, W, rowH, LBD);
      let dx = X;
      const td = (value, width, options) => {
        vLine(dx, y, y + rowH, LBD);
        txt(String(value), dx + 3, y + 3, width - 6, Object.assign({ size: 7.1, color: BLK, align: 'center', lineGap: 0.4 }, options || {}));
        dx += width;
      };
      td(idx + 1, COL.sl); td(it.itemCode || '', COL.code); td(descText, COL.desc, { align: 'left' });
      td(it.hsnCode || '', COL.hsn); td(it.unit || '', COL.unit); td(money(price), COL.rate, { align: 'right' });
      td(qty % 1 === 0 ? qty : qty.toFixed(3), COL.qty); td(taxRate.toFixed(0) + '%', COL.taxP);
      td(money(taxAmount), COL.taxAmt, { align: 'right' }); td(money(taxable), COL.amt, { align: 'right', bold: true });
      y += rowH;
    });

    y = checkPage(y, 60);
    const taxLabels = buildTaxSummaryLabels(q, useIGST ? 'igst' : 'split');
    const totalIgst = parseFloat(q.totalIgst || 0);
    const totalCgst = parseFloat(q.totalCgst || 0);
    const totalSgst = parseFloat(q.totalSgst || 0);
    const sumLines = [
      ['Subtotal:', fmtINR(q.subtotal)],
      ...(useIGST
        ? (totalIgst > 0.004 ? [[taxLabels.igst + ':', fmtINR(totalIgst)]] : [])
        : [
            ...(totalCgst > 0.004 ? [[taxLabels.cgst + ':', fmtINR(totalCgst)]] : []),
            ...(totalSgst > 0.004 ? [[taxLabels.sgst + ':', fmtINR(totalSgst)]] : []),
            ...((totalCgst + totalSgst) > 0.004 ? [['Total Tax:', fmtINR(totalCgst + totalSgst)]] : []),
          ]),
      ...(parseFloat(q.roundOff) ? [['Round Off:', fmtINR(q.roundOff)]] : []),
    ];
    // Same layout as the invoice/proforma summary: each row's separator is drawn
    // below it, so the box's top border is the only line above "Subtotal".
    const sumRowH = 11;
    const sumTotalH = 14;
    const sumH = sumLines.length * sumRowH + sumTotalH;
    const wordText = numWords(parseFloat(q.totalAmount || 0));
    const botH = Math.max(sumH, txtH(wordText, HW - 14, 7.5) + 16);
    box(X, y, W, botH, LBD);
    vLine(X + HW, y, y + botH, LBD);
    txt('Amount in Words:', X + 5, y + 4, HW - 10, { size: 7.5, bold: true, color: BLK });
    txt(wordText, X + 5, y + 14, HW - 10, { size: 7.5, color: BLK });

    let sy = y;
    sumLines.forEach(([label, val]) => {
      sy += sumRowH;
      txt(label, X + HW + 4, sy - 8, HW / 2 - 6, { size: 7.5, color: BLK });
      txt(val, X + HW + HW / 2, sy - 8, HW / 2 - 6, { size: 7.5, align: 'right', color: BLK });
      hLine(sy, X + HW, X + W, LBD);
    });
    fillBox(X + HW, sy, HW, sumTotalH, HBG);
    box(X + HW, sy, HW, sumTotalH, LBD);
    txt('Amount After Tax:', X + HW + 4, sy + 3, HW / 2 - 6, { size: 8, bold: true, color: BLK });
    txt(fmtINR(q.totalAmount), X + HW + HW / 2, sy + 3, HW / 2 - 6, { size: 8, bold: true, color: BLK, align: 'right' });
    y += botH;

    y = checkPage(y, 70);
    const bankLines = [
      ['Bank:', q.bankName || 'N/A'],
      ['A/c Name:', q.bankAcName || 'N/A'],
      ['A/c No.:', q.bankAccount || 'N/A'],
      ['IFSC:', q.bankIfsc || 'N/A'],
      ['Branch:', q.bankBranch || 'N/A'],
    ];
    y = drawSignature({ fillBox, box, vLine, hLine, txt }, y, q.sellerName, bankLines);

    const noteLines = [
      String(q.notes || '').trim() ? 'Remarks: ' + String(q.notes).trim() : '',
      String(q.termsConditions || '').trim() ? 'Terms & Conditions: ' + String(q.termsConditions).trim() : '',
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

    addFooters(doc, {
      infoText: 'This is a computer-generated quotation and remains subject to the terms stated above.',
    });
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};
