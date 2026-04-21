'use strict';
const { Op } = require('sequelize');
const { PurchaseOrder, Vendor, ProjectAccount, Company } = require('../models');
const {
  M, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, createDoc, addFooters,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim().toUpperCase();
  return code && code !== 'AUTO-GENERATED' ? code : prefix + '-' + genCode();
}

// ── GET /purchase-orders ──────────────────────────────────────────────────────
exports.getPurchaseOrders = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { poNumber:   { [Op.like]: `%${q}%` } },
      { vendorName: { [Op.like]: `%${q}%` } },
    ];
    const rows = await PurchaseOrder.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Vendor, as: 'vendor', attributes: ['id','name','vendorCode','gstin'] },
        { model: ProjectAccount, as: 'projectAccount', attributes: ['id','name','projectCode'] },
      ] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /purchase-orders/:id ──────────────────────────────────────────────────
exports.getPurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id, {
      include: [
        { model: Vendor, as: 'vendor' },
        { model: ProjectAccount, as: 'projectAccount' },
      ],
    });
    if (!po) return res.status(404).json({ message: 'PO not found' });
    res.json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /purchase-orders ─────────────────────────────────────────────────────
exports.createPurchaseOrder = async (req, res) => {
  try {
    const data = req.body;
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.vendorName && !data.vendorId) return res.status(400).json({ message: 'Vendor required' });
    data.poNumber = cleanGeneratedCode(data.poNumber, 'PO');
    data.createdBy = req.user.id;
    // auto-fill vendorName from vendorId if provided
    if (data.vendorId && !data.vendorName) {
      const v = await Vendor.findByPk(data.vendorId);
      if (v) data.vendorName = v.name;
    }
    const po = await PurchaseOrder.create(data);
    res.status(201).json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /purchase-orders/:id ──────────────────────────────────────────────────
exports.updatePurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'PO not found' });
    await po.update(req.body);
    res.json(po);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /purchase-orders/:id/pdf ─────────────────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id, {
      include: [{ model: Vendor, as: 'vendor' }],
    });
    if (!po) return res.status(404).json({ message: 'PO not found' });

    // Fetch company for header
    const company = req.user.companyId
      ? await Company.findByPk(req.user.companyId)
      : null;

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline?'inline':'attachment') + `; filename="PO-${po.poNumber}.pdf"`);

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const HW = W / 2;
    const RX = X + HW;
    const items   = po.items || [];
    const vendor  = po.vendor || {};
    const co      = company  || {};

    // ── 1. HEADER ──────────────────────────────────────────────────────────────
    const sellerLines = [
      co.name || 'DHPE',
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
    // Keep the description column wide; the other columns are compact numeric fields.
    const C = { sl:18, desc:340, qty:40, unit:42, rate:65, amt:70 };

    y = checkPage(y, 26);
    y = drawSectionLabel({ fillBox, box, txt }, 'Item Details', y);

    const ROW_H = 14;
    fillBox(X, y, W, ROW_H, HBG);
    box(X, y, W, ROW_H, LBD);

    let hcx = X;
    function th(label, w) {
      vLine(hcx, y, y+ROW_H, LBD);
      txt(label, hcx+2, y+3, w-4, { size:6.5, bold:true, color:BLK, align:'center' });
      hcx += w;
    }
    th('Sl.', C.sl); th('Description', C.desc); th('Qty', C.qty);
    th('Unit', C.unit); th('Rate (Rs.)', C.rate); th('Amount (Rs.)', C.amt);
    y += ROW_H;

    items.forEach((it, idx) => {
      const qty  = parseFloat(it.qty  || 0);
      const rate = parseFloat(it.rate || 0);
      const amt  = qty * rate;
      const rowH = Math.max(14, txtH(it.name || '', C.desc - 6, 7.5) + 7);
      y = checkPage(y, rowH+1);
      if (idx%2===0) fillBox(X, y, W, rowH, '#fafafa');
      box(X, y, W, rowH, LBD);

      let dcx = X;
      function td(text, w, opts) {
        vLine(dcx, y, y+rowH, LBD);
        const to = Object.assign({ size:7.5, align:'center', lineGap:0.5 }, opts||{});
        const ty = y + 3;
        txt(String(text), dcx+3, ty, w-6, to);
        dcx += w;
      }
      td(idx+1,            C.sl);
      td(it.name||'',      C.desc, { align:'left' });
      td(qty%1===0?qty:qty.toFixed(3), C.qty);
      td(it.unit||'',      C.unit);
      td(rate.toFixed(2),  C.rate, { align:'right' });
      td(amt.toFixed(2),   C.amt,  { align:'right', bold:true });
      y += rowH;
    });

    // ── 4. AMOUNT IN WORDS + TOTAL ─────────────────────────────────────────────
    y = checkPage(y, 50);
    const totalAmt  = parseFloat(po.totalAmount || 0);
    const wordText  = numWords(totalAmt);
    const wordH     = txtH(wordText, HW-14, 7.5);
    const sumTotalH = 14;
    const botH      = Math.max(sumTotalH+3, wordH+18);

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
    const noteLines = [po.notes||'', 'This is a computer-generated Purchase Order.'].filter(Boolean);
    y = checkPage(y, 32);
    box(X, y, W, noteLines.length*9+7, LBD);
    let ny = y+4;
    noteLines.forEach(line => {
      txt(line, X+5, ny, W-10, { size:7, color:GRY });
      ny += 9;
    });
    y += noteLines.length*9+7;

    // ── 6. SIGNATURE ───────────────────────────────────────────────────────────
    y = checkPage(y, 55);
    const bankLines = [
      ['Bank:',     co.bankName    || 'N/A'],
      ['A/c Name:', co.bankAcName  || 'N/A'],
      ['A/c No.:',  co.bankAccount || 'N/A'],
      ['IFSC:',     co.bankIfsc    || 'N/A'],
      ['Branch:',   co.bankBranch  || 'N/A'],
    ];
    drawSignature({ fillBox, box, vLine, hLine, txt }, y, co.name||'DHPE', bankLines);

    addFooters(doc);
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};

// ── DELETE /purchase-orders/:id ───────────────────────────────────────────────
exports.deletePurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'PO not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('purchase_order', po.id, req.user, po.toJSON(), po.poNumber);
    await po.destroy();
    res.json({ message: 'Purchase Order deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
