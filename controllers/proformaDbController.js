'use strict';
const { Op } = require('sequelize');
const { Proforma, Invoice, Client, Quotation } = require('../models');
const {
  M, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, createDoc, addFooters,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

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
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { proformaNumber: { [Op.like]: `%${q}%` } },
      { customerName:   { [Op.like]: `%${q}%` } },
    ];
    const rows = await Proforma.findAll({ where, order: [['createdAt','DESC']],
      include: [{ model: Client, as: 'client', attributes: ['id','name','clientCode'] }] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /proformas-db/:id ─────────────────────────────────────────────────────
exports.getProforma = async (req, res) => {
  try {
    const p = await Proforma.findByPk(req.params.id, {
      include: [
        { model: Client, as: 'client' },
        { model: Quotation, as: 'sourceQuotation', attributes: ['id','quotationNumber'] },
      ],
    });
    if (!p) return res.status(404).json({ message: 'Proforma not found' });
    res.json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /proformas-db ────────────────────────────────────────────────────────
exports.createProforma = async (req, res) => {
  try {
    const data = req.body;
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.customerName) return res.status(400).json({ message: 'Customer name required' });
    data.proformaNumber = 'PRO-' + genCode();
    data.createdBy = req.user.id;
    const p = await Proforma.create(data);
    res.status(201).json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /proformas-db/:id ─────────────────────────────────────────────────────
exports.updateProforma = async (req, res) => {
  try {
    const p = await Proforma.findByPk(req.params.id);
    if (!p) return res.status(404).json({ message: 'Proforma not found' });
    await p.update(req.body);
    res.json(p);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /proformas-db/:id ──────────────────────────────────────────────────
exports.deleteProforma = async (req, res) => {
  try {
    const p = await Proforma.findByPk(req.params.id);
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
    const p = await Proforma.findByPk(req.params.id);
    if (!p) return res.status(404).json({ message: 'Proforma not found' });

    // Derive company code from seller name initials (e.g. "DHPE Pvt Ltd" → "DHPE")
    const codeMatch = (p.sellerName || '').match(/^([A-Z0-9]+)/i);
    const compCode  = codeMatch ? codeMatch[1].toUpperCase().slice(0, 6) : 'INV';
    const invNumber = await nextInvoiceNumber(compCode);

    const inv = await Invoice.create({
      invoiceNumber:  invNumber,
      invoiceDate:    p.date,
      clientId:       p.clientId,
      customerName:   p.customerName,
      customerGstin:  p.customerGstin,
      customerPan:    p.customerPan,
      customerEmail:  p.customerEmail,
      customerAddress:p.customerAddress,
      customerState:  p.customerState,
      customerStateCode: p.customerStateCode,
      sellerName:     p.sellerName,
      sellerGstin:    p.sellerGstin,
      sellerAddress:  p.sellerAddress,
      sellerState:    p.sellerState,
      sellerStateCode:p.sellerStateCode,
      sellerPhone:    p.sellerPhone,
      sellerEmail:    p.sellerEmail,
      sellerPan:      p.sellerPan,
      placeOfSupply:  p.placeOfSupply,
      billMonth:      p.billMonth,
      billPeriodFrom: p.billPeriodFrom,
      billPeriodTo:   p.billPeriodTo,
      workOrder:      p.workOrder,
      projectName:    p.projectName,
      workDetails:    p.workDetails,
      items:          p.items,
      sgstRate:       p.sgstRate,
      cgstRate:       p.cgstRate,
      subtotal:       p.subtotal,
      totalCgst:      p.totalCgst,
      totalSgst:      p.totalSgst,
      totalIgst:      p.totalIgst,
      totalTax:       p.totalTax,
      roundOff:       p.roundOff,
      totalAmount:    p.totalAmount,
      showTaxInPdf:   p.showTaxInPdf,
      bankName:       p.bankName,
      bankAcName:     p.bankAcName,
      bankAccount:    p.bankAccount,
      bankIfsc:       p.bankIfsc,
      bankBranch:     p.bankBranch,
      notes:          p.notes,
      termsConditions:p.termsConditions,
      sourceDocId:    p.id,
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
    const p = await Proforma.findByPk(req.params.id);
    if (!p) return res.status(404).json({ message: 'Proforma not found' });

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename="Proforma-${p.proformaNumber}.pdf"`);

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const PW = 595;
    const HW = W / 2;
    const RX = X + HW;
    const items   = p.items || [];
    const showTax = p.showTaxInPdf !== false;
    const useIGST = showTax && p.sellerStateCode && p.customerStateCode &&
                    p.sellerStateCode !== p.customerStateCode;

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
      'Date: '+fmtDate(p.date)+'   Status: '+(p.status||'Draft'),
      p.billMonth ? 'Bill for Month: '+p.billMonth : '',
      (p.billPeriodFrom && p.billPeriodTo)
        ? 'Bill Period: '+fmtDate(p.billPeriodFrom)+' to '+fmtDate(p.billPeriodTo) : '',
      'Ref No.: '+(p.proformaNumber||''),
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
    const COL = !showTax
      ? { sl:20, code:60, hsn:65, unit:45, rate:80, qty:45, amt:240 }
      : useIGST
        ? { sl:20, code:50, hsn:55, unit:35, rate:65, qty:35, igstP:35, igst:65, amt:195 }
        : { sl:18, code:48, hsn:50, unit:32, rate:55, qty:32, cgstP:30, cgst:48, sgstP:30, sgst:48, amt:164 };

    y = checkPage(y, 26);
    y = drawSectionLabel({ fillBox, box, txt }, 'Item Details', y);

    const ROW_H = 14;
    fillBox(X, y, W, ROW_H, HBG);
    box(X, y, W, ROW_H, LBD);

    let cx = X;
    function th(label, w) {
      vLine(cx, y, y+ROW_H, LBD);
      txt(label, cx+2, y+3, w-4, { size:6.5, bold:true, color:BLK, align:'center' });
      cx += w;
    }
    if (!showTax) {
      th('Sl.', COL.sl); th('Item Code', COL.code); th('HSN/SAC', COL.hsn);
      th('Unit', COL.unit); th('Rate (Rs.)', COL.rate); th('Qty', COL.qty);
      th('Amount (Rs.)', COL.amt);
    } else if (useIGST) {
      th('Sl.', COL.sl); th('Item Code', COL.code); th('HSN/SAC', COL.hsn);
      th('Unit', COL.unit); th('Rate (Rs.)', COL.rate); th('Qty', COL.qty);
      th('IGST%', COL.igstP); th('IGST', COL.igst); th('Amount (Rs.)', COL.amt);
    } else {
      th('Sl.', COL.sl); th('Item Code', COL.code); th('HSN/SAC', COL.hsn);
      th('Unit', COL.unit); th('Rate (Rs.)', COL.rate); th('Qty', COL.qty);
      th('CGST%', COL.cgstP); th('CGST', COL.cgst); th('SGST%', COL.sgstP);
      th('SGST', COL.sgst); th('Amount (Rs.)', COL.amt);
    }
    y += ROW_H;

    const DATA_ROW_H = 14;
    items.forEach((it, idx) => {
      const qty     = parseFloat(it.quantity      || 0);
      const price   = parseFloat(it.unitPrice     || 0);
      const disc    = parseFloat(it.discount      || 0);
      const taxRate = parseFloat(it.taxRate       || 0);
      const taxable = parseFloat(it.taxableAmount || (qty*price*(1-disc/100)));
      const igstAmt = parseFloat(it.igst || 0);
      const cgstAmt = parseFloat(it.cgst || 0);
      const sgstAmt = parseFloat(it.sgst || 0);
      const total   = parseFloat(it.itemTotal     || (taxable+igstAmt+cgstAmt+sgstAmt));
      const descText = (it.name||'').trim();
      const descH   = descText ? txtH(descText, W-16, 7.5) + 7 : 0;
      const totalRowH = DATA_ROW_H + (descText ? descH : 0);
      y = checkPage(y, totalRowH+1);

      if (idx%2===0) fillBox(X, y, W, DATA_ROW_H, '#fafafa');
      box(X, y, W, DATA_ROW_H, LBD);

      let dcx = X;
      function td(text, w, opts) {
        vLine(dcx, y, y+DATA_ROW_H, LBD);
        const to = Object.assign({ size:7.5, align:'center', lineGap:0.5 }, opts||{});
        const ty = y + (DATA_ROW_H - (to.size+2)) / 2 + 1;
        txt(String(text), dcx+3, ty, w-6, to);
        dcx += w;
      }
      if (!showTax) {
        td(idx+1,                               COL.sl);
        td(it.itemCode||'',                     COL.code);
        td(it.hsnCode||'',                      COL.hsn);
        td(it.unit||'',                         COL.unit);
        td(price.toFixed(2),                    COL.rate, { align:'right' });
        td(qty%1===0?qty:qty.toFixed(3),        COL.qty);
        td(total.toFixed(2),                    COL.amt,  { align:'right', bold:true });
      } else if (useIGST) {
        td(idx+1,                               COL.sl);
        td(it.itemCode||'',                     COL.code);
        td(it.hsnCode||'',                      COL.hsn);
        td(it.unit||'',                         COL.unit);
        td(price.toFixed(2),                    COL.rate, { align:'right' });
        td(qty%1===0?qty:qty.toFixed(3),        COL.qty);
        td(taxRate.toFixed(0)+'%',              COL.igstP);
        td(igstAmt.toFixed(2),                  COL.igst, { align:'right' });
        td(total.toFixed(2),                    COL.amt,  { align:'right', bold:true });
      } else {
        td(idx+1,                               COL.sl);
        td(it.itemCode||'',                     COL.code);
        td(it.hsnCode||'',                      COL.hsn);
        td(it.unit||'',                         COL.unit);
        td(price.toFixed(2),                    COL.rate, { align:'right' });
        td(qty%1===0?qty:qty.toFixed(3),        COL.qty);
        td((taxRate/2).toFixed(0)+'%',          COL.cgstP);
        td(cgstAmt.toFixed(2),                  COL.cgst, { align:'right' });
        td((taxRate/2).toFixed(0)+'%',          COL.sgstP);
        td(sgstAmt.toFixed(2),                  COL.sgst, { align:'right' });
        td(total.toFixed(2),                    COL.amt,  { align:'right', bold:true });
      }
      y += DATA_ROW_H;

      if (descText) {
        y = checkPage(y, descH);
        fillBox(X, y, W, descH, '#f9fafb');
        box(X, y, W, descH, LBD);
        txt(descText, X+8, y+3, W-16, { size:7.5, align:'left', lineGap:0.5, color:GRY });
        y += descH;
      }
    });

    // ── 5. AMOUNT IN WORDS + SUMMARY ───────────────────────────────────────────
    y = checkPage(y, 60);
    const sumLines = [
      ['Total Amount:', fmtINR(p.subtotal)],
      ...(showTax
        ? (useIGST
          ? [['IGST:', fmtINR(p.totalIgst)]]
          : [['SGST:', fmtINR(p.totalSgst)], ['CGST:', fmtINR(p.totalCgst)]])
        : []),
      ...(parseFloat(p.roundOff) ? [['Round Off:', fmtINR(p.roundOff)]] : []),
    ];
    const sumRowH   = 12;
    const sumTotalH = 14;
    const sumH      = sumLines.length * sumRowH + sumTotalH;
    const wordText  = numWords(parseFloat(p.totalAmount||0));
    const wordH     = txtH(wordText, HW-14, 7.5);
    const botH      = Math.max(sumH+3, wordH+18);

    const sy0 = y + 3 + sumLines.length * sumRowH;
    fillBox(X+HW, sy0, HW, sumTotalH, HBG);
    box(X, y, W, botH, LBD);
    vLine(X+HW, y, y+botH, LBD);

    txt('Amount in Words:', X+5, y+4, HW-10, { size:7.5, bold:true, color:BLK });
    txt(wordText, X+5, y+14, HW-10, { size:7.5, color:BLK });

    let sy = y+3;
    sumLines.forEach(([label, val]) => {
      hLine(sy, X+HW, X+W, LBD);
      txt(label, X+HW+4, sy+2, HW/2-6, { size:7.5, color:BLK });
      txt(val,   X+HW+HW/2, sy+2, HW/2-6, { size:7.5, align:'right', color:BLK });
      sy += sumRowH;
    });
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
      p.termsConditions || '',
      'Note: This is a Proforma Invoice — not a Tax Invoice. No legal payment obligation.',
    ].filter(Boolean);
    y = checkPage(y, 32);
    box(X, y, W, noteLines.length*9+7, LBD);
    let ny = y+4;
    noteLines.forEach(line => {
      txt(line, X+5, ny, W-10, { size:7, color:GRY });
      ny += 9;
    });

    addFooters(doc);
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};
