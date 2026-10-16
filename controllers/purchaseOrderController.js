'use strict';
const { Op } = require('sequelize');
const { PurchaseOrder, Vendor, ProjectAccount, Company } = require('../models');
const {
  applyCompanyScope,
  assertScopedRelation,
  findScopedByPk,
  resolveAccountCompanyId,
  syncAccountsCompanyIds,
} = require('./accountsCompanyScope');
const {
  M, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, buildPdfFilename, createDoc, addFooters,
  drawSectionLabel, drawSignature, drawTextSection, drawPagedTable, serialColumnWidth,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim();
  return code && code.toLowerCase() !== 'auto-generated' ? code : prefix + '-' + genCode();
}

// ── GET /purchase-orders ──────────────────────────────────────────────────────
exports.getPurchaseOrders = async (req, res) => {
  try {
    const { q, status } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { poNumber:   { [Op.like]: `%${q}%` } },
      { vendorName: { [Op.like]: `%${q}%` } },
    ];
    const rows = await PurchaseOrder.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Company, as: 'company', attributes: ['id','name','gstNo'], required: false },
        { model: Vendor, as: 'vendor', attributes: ['id','name','vendorCode','gstin'] },
        { model: ProjectAccount, as: 'projectAccount', attributes: ['id','name','projectCode'] },
      ] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /purchase-orders/:id ──────────────────────────────────────────────────
exports.getPurchaseOrder = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const po = await findScopedByPk(PurchaseOrder, 'purchaseOrder', req, req.params.id, {
      include: [
        { model: Company, as: 'company', required: false },
        { model: Vendor, as: 'vendor' },
        { model: ProjectAccount, as: 'projectAccount' },
      ],
    }, 'PO not found');
    if (!po) return res.status(404).json({ message: 'PO not found' });
    res.json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /purchase-orders ─────────────────────────────────────────────────────
exports.createPurchaseOrder = async (req, res) => {
  try {
    const data = Object.assign({}, req.body);
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.vendorName && !data.vendorId) return res.status(400).json({ message: 'Vendor required' });
    data.poNumber = cleanGeneratedCode(data.poNumber, 'PO');
    data.createdBy = req.user.id;
    const vendor = data.vendorId
      ? await assertScopedRelation(Vendor, 'vendor', req, data.vendorId, 'Vendor not found')
      : null;
    const projectAccount = data.projectAccountId
      ? await assertScopedRelation(ProjectAccount, 'projectAccount', req, data.projectAccountId, 'Project account not found')
      : null;
    data.companyId = await resolveAccountCompanyId(req, data, [
      projectAccount && projectAccount.companyId, vendor && vendor.companyId,
    ]);
    // auto-fill vendorName from vendorId if provided
    if (data.vendorId && !data.vendorName) {
      if (vendor) data.vendorName = vendor.name;
    }
    const po = await PurchaseOrder.create(data);
    res.status(201).json(po);
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── PUT /purchase-orders/:id ──────────────────────────────────────────────────
exports.updatePurchaseOrder = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const po = await findScopedByPk(PurchaseOrder, 'purchaseOrder', req, req.params.id, null, 'PO not found');
    if (!po) return res.status(404).json({ message: 'PO not found' });
    const updates = Object.assign({}, req.body);
    const vendor = updates.vendorId
      ? await assertScopedRelation(Vendor, 'vendor', req, updates.vendorId, 'Vendor not found')
      : null;
    const projectAccount = updates.projectAccountId
      ? await assertScopedRelation(ProjectAccount, 'projectAccount', req, updates.projectAccountId, 'Project account not found')
      : null;
    if (updates.vendorId && !updates.vendorName && vendor) updates.vendorName = vendor.name;
    updates.companyId = await resolveAccountCompanyId(req, updates, [
      po.companyId, projectAccount && projectAccount.companyId, vendor && vendor.companyId,
    ]);
    await po.update(updates);
    res.json(po);
  } catch (err) { res.status(err.status || 500).json({ message: err.message }); }
};

// ── GET /purchase-orders/:id/pdf ─────────────────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const po = await findScopedByPk(PurchaseOrder, 'purchaseOrder', req, req.params.id, {
      include: [
        { model: Vendor, as: 'vendor' },
        { model: Company, as: 'company', required: false },
      ],
    }, 'PO not found');
    if (!po) return res.status(404).json({ message: 'PO not found' });

    // Fetch company for header
    const company = po.company || (po.companyId ? await Company.findByPk(po.companyId) : null);

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline?'inline':'attachment') + `; filename="${buildPdfFilename([
        (company && company.name) || 'Company',
        'Purchase-Order',
        po.poNumber || po.id,
      ])}"`);

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const HW = W / 2;
    const RX = X + HW;
    const items   = po.items || [];
    const vendor  = po.vendor || {};
    const co      = company  || {};

    // ── 1. HEADER ──────────────────────────────────────────────────────────────
    const sellerLines = [
      co.name || 'Company not specified',
      co.address ? 'Address: '+co.address : '',
      (co.phone||co.email) ? 'Phone: '+(co.phone||'')+(co.email?' | Email: '+co.email:'') : '',
      [co.gstNo?'GSTIN: '+co.gstNo:'', co.panNo?'PAN: '+co.panNo:'', co.state?'State: '+co.state:'']
        .filter(Boolean).join(' | '),
    ].filter(Boolean);

    const metaRight = [
      'PURCHASE ORDER',
      'Order Date: '+fmtDate(po.date)+'   Status: '+(po.status||'Draft'),
      'Ref No.: '+(po.poNumber||''),
      po.deliveryDate ? 'Delivery Date: '+fmtDate(po.deliveryDate) : '',
    ].filter(Boolean);

    let hBoxH = 8;
    sellerLines.forEach((l,i) => { hBoxH += txtH(l, HW-14, i===0?12:7.5, i===0)+1.5; });
    const hBoxHR = metaRight.reduce((s,l,i) => s+txtH(l, HW-12, i===0?8.5:7.5, i===0)+1.5, 5);
    const headerH = Math.max(hBoxH, hBoxHR) + 5;

    box(X, M, W, headerH, LBD);
    vLine(X+HW, M, M+headerH, LBD);

    let ly = M+5;
    sellerLines.forEach((line,i) => {
      if (!line) return;
      txt(line, X+5, ly, HW-10, { size:i===0?12:7.5, bold:i===0, color:BLK, lineGap:0.5 });
      ly = doc.y+(i===0?2:1);
    });
    let ry = M+5;
    metaRight.forEach((line,i) => {
      if (!line) return;
      txt(line, RX+4, ry, HW-10, { size:i===0?8.5:7.5, bold:i===0, color:BLK, align:'right', lineGap:0.5 });
      ry = doc.y+1;
    });

    let y = M + headerH;

    // ── 2. VENDOR DETAILS ──────────────────────────────────────────────────────
    y = drawSectionLabel({ fillBox, box, txt }, 'Vendor Details:', y);

    const vendorLeft = [
      vendor.name        || po.vendorName || '',
      vendor.address     ? 'Address: '+vendor.address : '',
      vendor.phone||vendor.email
        ? 'Phone: '+(vendor.phone||'')+(vendor.email?' | Email: '+vendor.email:'') : '',
    ].filter(Boolean);
    const vendorRight = [
      vendor.gstin       ? 'GSTIN: '+vendor.gstin : '',
      vendor.pan         ? 'PAN: '+vendor.pan     : '',
      vendor.state       ? 'State: '+vendor.state+(vendor.stateCode?', Code: '+vendor.stateCode:'') : '',
      vendor.contactPerson ? 'Contact: '+vendor.contactPerson : '',
    ].filter(Boolean);

    let vLeftH = 6;
    vendorLeft.forEach((l,i) => { vLeftH += txtH(l, HW-12, i===0?8.5:7.5, i===0)+1.5; });
    const vRightH = vendorRight.reduce((s,l) => s+txtH(l, HW-12, 7.5)+1.5, 6);
    const vendorBoxH = Math.max(vLeftH, vRightH)+3;

    box(X, y, W, vendorBoxH, LBD);
    vLine(X+HW, y, y+vendorBoxH, LBD);
    let vly=y+4, vry=y+4;
    vendorLeft.forEach((line,i) => {
      if (!line) return;
      txt(line, X+5, vly, HW-10, { size:i===0?8.5:7.5, bold:i===0, color:BLK });
      vly = doc.y+0.5;
    });
    vendorRight.forEach(line => {
      if (!line) return;
      txt(line, RX+4, vry, HW-10, { size:7.5, color:BLK });
      vry = doc.y+0.5;
    });
    y += vendorBoxH;

    // ── 3. ITEMS TABLE ─────────────────────────────────────────────────────────
    const slW = serialColumnWidth({ doc }, items.length);
    const money = value => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const columns = [
      { label: 'Sl.', width: slW }, { label: 'Description', width: 340 - (slW - 18), align: 'left' },
      { label: 'Qty', width: 40, fit: true }, { label: 'Unit', width: 42 },
      { label: 'Rate (Rs.)', width: 65, align: 'right', fit: true },
      { label: 'Amount (Rs.)', width: 70, align: 'right', bold: true, fit: true },
    ];
    const itemRows = items.map((item, index) => {
      const qty = Number(item.qty ?? item.quantity ?? 0);
      const rate = Number(item.rate ?? item.unitPrice ?? 0);
      return [index + 1, item.name || item.description || '', qty, item.unit || '', money(rate), money(qty * rate)];
    });
    y = drawPagedTable({ doc, box, fillBox, vLine, txt, txtH, checkPage }, columns, itemRows, y);

    // Amount in words and total
    y = checkPage(y, 50);
    const totalAmt  = parseFloat(po.totalAmount || 0);
    const wordText  = numWords(totalAmt);
    const wordH     = txtH(wordText, HW-14, 7.5);
    const sumTotalH = 14;
    const botH      = Math.max(sumTotalH+3, wordH+18);
    y = checkPage(y, botH);

    fillBox(X+HW, y+botH-sumTotalH, HW, sumTotalH, HBG);
    box(X, y, W, botH, LBD);
    vLine(X+HW, y, y+botH, LBD);

    txt('Amount in Words:', X+5, y+4, HW-10, { size:7.5, bold:true, color:BLK });
    txt(wordText, X+5, y+14, HW-10, { size:7.5, color:BLK });

    const tx = y+botH-sumTotalH;
    txt('Total Amount:', X+HW+4, tx+3, HW/2-6, { size:8, bold:true, color:BLK });
    txt(fmtINR(totalAmt), X+HW+HW/2, tx+3, HW/2-6, { size:8, bold:true, color:BLK, align:'right' });
    y += botH;

    // ── 5. NOTES ───────────────────────────────────────────────────────────────
    y = drawTextSection({ doc, txt, txtH, box, fillBox, checkPage }, 'Remarks', po.notes, y);

    // ── 6. SIGNATURE ───────────────────────────────────────────────────────────
    const bankLines = [
      ['Bank:',     co.bankName    || 'N/A'],
      ['A/c Name:', co.bankAcName  || 'N/A'],
      ['A/c No.:',  co.bankAccount || 'N/A'],
      ['IFSC:',     co.bankIfsc    || 'N/A'],
      ['Branch:',   co.bankBranch  || 'N/A'],
    ];
    drawSignature({ fillBox, box, vLine, hLine, txt, txtH, checkPage }, y, co.name || '', bankLines);

    addFooters(doc, { companyName: co.name, infoText: 'This is a computer-generated Purchase Order.' });
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};

// ── DELETE /purchase-orders/:id ───────────────────────────────────────────────
exports.deletePurchaseOrder = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const po = await findScopedByPk(PurchaseOrder, 'purchaseOrder', req, req.params.id, null, 'PO not found');
    if (!po) return res.status(404).json({ message: 'PO not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('purchase_order', po.id, req.user, po.toJSON(), po.poNumber);
    await po.destroy();
    res.json({ message: 'Purchase Order deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
