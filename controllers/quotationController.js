'use strict';
const { Op } = require('sequelize');
const { Quotation, Proforma, Invoice, Client } = require('../models');
const {
  M, W, X, BLK, GRY, HBG, LBD,
  fmtDate, fmtINR, numWords, createDoc, addFooters,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

// ── GET /quotations ───────────────────────────────────────────────────────────
exports.getQuotations = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { quotationNumber: { [Op.like]: `%${q}%` } },
      { clientName:      { [Op.like]: `%${q}%` } },
    ];
    const rows = await Quotation.findAll({ where, order: [['createdAt','DESC']],
      include: [{ model: Client, as: 'client', attributes: ['id','name','clientCode'] }] });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /quotations/:id ──────────────────────────────────────────────────────
exports.getQuotation = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id, {
      include: [{ model: Client, as: 'client' }]
    });
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    res.json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /quotations ─────────────────────────────────────────────────────────
exports.createQuotation = async (req, res) => {
  try {
    const data = req.body;
    if (!data.date) return res.status(400).json({ message: 'Date required' });
    if (!data.clientName) return res.status(400).json({ message: 'Client name required' });
    data.quotationNumber = 'QUO-' + genCode();
    data.createdBy = req.user.id;
    const q = await Quotation.create(data);
    res.status(201).json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /quotations/:id ──────────────────────────────────────────────────────
exports.updateQuotation = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    await q.update(req.body);
    res.json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /quotations/:id ───────────────────────────────────────────────────
exports.deleteQuotation = async (req, res) => {
  try {
    const q = await Quotation.findByPk(req.params.id);
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
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });

    const pro = await Proforma.create({
      proformaNumber: 'PRO-' + genCode(),
      clientId:       q.clientId,
      sourceQuotationId: q.id,
      customerName:      q.clientName,
      customerGstin:     q.clientGstin,
      customerPan:       q.clientPan,
      customerEmail:     q.clientEmail,
      customerAddress:   q.clientAddress,
      customerState:     q.clientState,
      customerStateCode: q.clientStateCode,
      sellerName:        q.sellerName,
      sellerGstin:       q.sellerGstin,
      sellerAddress:     q.sellerAddress,
      sellerState:       q.sellerState,
      sellerStateCode:   q.sellerStateCode,
      sellerPhone:       q.sellerPhone,
      sellerEmail:       q.sellerEmail,
      sellerPan:         q.sellerPan,
      date:          q.date,
      validityDate:  q.validTill,
      items:         q.items,
      sgstRate:      q.sgstRate,
      cgstRate:      q.cgstRate,
      subtotal:      q.subtotal,
      totalCgst:     q.totalCgst,
      totalSgst:     q.totalSgst,
      totalIgst:     q.totalIgst,
      totalTax:      q.totalTax,
      roundOff:      q.roundOff,
      totalAmount:   q.totalAmount,
      bankName:      q.bankName,
      bankAcName:    q.bankAcName,
      bankAccount:   q.bankAccount,
      bankIfsc:      q.bankIfsc,
      bankBranch:    q.bankBranch,
      notes:         q.notes,
      termsConditions: q.termsConditions,
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
    const q = await Quotation.findByPk(req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });

    const inv = await Invoice.create({
      invoiceNumber:  'INV-' + genCode(),
      invoiceDate:    q.date,
      clientId:       q.clientId,
      customerName:   q.clientName,
      customerGstin:  q.clientGstin,
      customerPan:    q.clientPan,
      customerEmail:  q.clientEmail,
      customerAddress:q.clientAddress,
      customerState:  q.clientState,
      customerStateCode: q.clientStateCode,
      sellerName:     q.sellerName,
      sellerGstin:    q.sellerGstin,
      sellerAddress:  q.sellerAddress,
      sellerState:    q.sellerState,
      sellerStateCode:q.sellerStateCode,
      sellerPhone:    q.sellerPhone,
      sellerEmail:    q.sellerEmail,
      sellerPan:      q.sellerPan,
      items:          q.items,
      sgstRate:       q.sgstRate,
      cgstRate:       q.cgstRate,
      subtotal:       q.subtotal,
      totalCgst:      q.totalCgst,
      totalSgst:      q.totalSgst,
      totalIgst:      q.totalIgst,
      totalTax:       q.totalTax,
      roundOff:       q.roundOff,
      totalAmount:    q.totalAmount,
      bankName:       q.bankName,
      bankAcName:     q.bankAcName,
      bankAccount:    q.bankAccount,
      bankIfsc:       q.bankIfsc,
      bankBranch:     q.bankBranch,
      notes:          q.notes,
      termsConditions:q.termsConditions,
      sourceDocId:    q.id,
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
    const q = await Quotation.findByPk(req.params.id, {
      include: [{ model: Client, as: 'client', required: false }],
    });
    if (!q) return res.status(404).json({ message: 'Quotation not found' });

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename="Quotation-${q.quotationNumber}.pdf"`
    );

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const HW = W / 2;
    const RX = X + HW;
    const items = q.items || [];
    const useIGST = q.sellerStateCode && q.clientStateCode &&
                    q.sellerStateCode !== q.clientStateCode;

    const sellerLines = [
      q.sellerName || '',
      q.sellerAddress ? 'Address: ' + q.sellerAddress : '',
      (q.sellerPhone || q.sellerEmail)
        ? 'Phone: ' + (q.sellerPhone || '') + (q.sellerEmail ? ' | Email: ' + q.sellerEmail : '') : '',
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
      q.clientGstin ? 'GSTIN: ' + q.clientGstin + (q.clientPan ? ' | PAN: ' + q.clientPan : '') : '',
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

    const COL = useIGST
      ? { sl: 20, code: 50, hsn: 55, unit: 35, rate: 65, qty: 35, igstP: 35, igst: 65, amt: 195 }
      : { sl: 18, code: 48, hsn: 50, unit: 32, rate: 55, qty: 32, cgstP: 30, cgst: 48, sgstP: 30, sgst: 48, amt: 164 };

    y = checkPage(y, 26);
    y = drawSectionLabel({ fillBox, box, txt }, 'Item Details', y);

    const ROW_H = 14;
    fillBox(X, y, W, ROW_H, HBG);
    box(X, y, W, ROW_H, LBD);
    let hx = X;
    function th(label, width) {
      vLine(hx, y, y + ROW_H, LBD);
      txt(label, hx + 2, y + 3, width - 4, { size: 6.5, bold: true, color: BLK, align: 'center' });
      hx += width;
    }
    if (useIGST) {
      th('Sl.', COL.sl); th('Item Code', COL.code); th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
      th('Rate (Rs.)', COL.rate); th('Qty', COL.qty); th('IGST%', COL.igstP); th('IGST', COL.igst); th('Amount (Rs.)', COL.amt);
    } else {
      th('Sl.', COL.sl); th('Item Code', COL.code); th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
      th('Rate (Rs.)', COL.rate); th('Qty', COL.qty); th('CGST%', COL.cgstP); th('CGST', COL.cgst);
      th('SGST%', COL.sgstP); th('SGST', COL.sgst); th('Amount (Rs.)', COL.amt);
    }
    y += ROW_H;

    items.forEach((it, idx) => {
      const qty = parseFloat(it.quantity || 0);
      const price = parseFloat(it.unitPrice || 0);
      const discount = parseFloat(it.discount || 0);
      const taxRate = parseFloat(it.taxRate || 0);
      const taxable = parseFloat(it.taxableAmount || (qty * price * (1 - discount / 100)));
      const igstAmt = parseFloat(it.igst || 0);
      const cgstAmt = parseFloat(it.cgst || 0);
      const sgstAmt = parseFloat(it.sgst || 0);
      const total = parseFloat(it.itemTotal || (taxable + igstAmt + cgstAmt + sgstAmt));
      const descText = (it.name || '').trim();
      const descH = descText ? txtH(descText, W - 16, 7.5) + 7 : 0;
      y = checkPage(y, ROW_H + descH + 1);
      if (idx % 2 === 0) fillBox(X, y, W, ROW_H, '#fafafa');
      box(X, y, W, ROW_H, LBD);

      let dx = X;
      function td(text, width, opts) {
        vLine(dx, y, y + ROW_H, LBD);
        const to = Object.assign({ size: 7.5, align: 'center', lineGap: 0.5 }, opts || {});
        txt(String(text), dx + 3, y + 3, width - 6, to);
        dx += width;
      }
      if (useIGST) {
        td(idx + 1, COL.sl); td(it.itemCode || '', COL.code); td(it.hsnCode || '', COL.hsn); td(it.unit || '', COL.unit);
        td(price.toFixed(2), COL.rate, { align: 'right' }); td(qty % 1 === 0 ? qty : qty.toFixed(3), COL.qty);
        td(taxRate.toFixed(0) + '%', COL.igstP); td(igstAmt.toFixed(2), COL.igst, { align: 'right' }); td(total.toFixed(2), COL.amt, { align: 'right', bold: true });
      } else {
        td(idx + 1, COL.sl); td(it.itemCode || '', COL.code); td(it.hsnCode || '', COL.hsn); td(it.unit || '', COL.unit);
        td(price.toFixed(2), COL.rate, { align: 'right' }); td(qty % 1 === 0 ? qty : qty.toFixed(3), COL.qty);
        td((taxRate / 2).toFixed(0) + '%', COL.cgstP); td(cgstAmt.toFixed(2), COL.cgst, { align: 'right' });
        td((taxRate / 2).toFixed(0) + '%', COL.sgstP); td(sgstAmt.toFixed(2), COL.sgst, { align: 'right' }); td(total.toFixed(2), COL.amt, { align: 'right', bold: true });
      }
      y += ROW_H;

      if (descText) {
        fillBox(X, y, W, descH, '#f9fafb');
        box(X, y, W, descH, LBD);
        txt(descText, X + 8, y + 3, W - 16, { size: 7.5, align: 'left', lineGap: 0.5, color: GRY });
        y += descH;
      }
    });

    y = checkPage(y, 60);
    const sumLines = [
      ['Subtotal:', fmtINR(q.subtotal)],
      ...(useIGST ? [['IGST:', fmtINR(q.totalIgst)]] : [['SGST:', fmtINR(q.totalSgst)], ['CGST:', fmtINR(q.totalCgst)]]),
      ...(parseFloat(q.roundOff) ? [['Round Off:', fmtINR(q.roundOff)]] : []),
    ];
    const sumRowH = 12;
    const sumTotalH = 14;
    const wordText = numWords(parseFloat(q.totalAmount || 0));
    const botH = Math.max(sumLines.length * sumRowH + sumTotalH + 3, txtH(wordText, HW - 14, 7.5) + 18);
    fillBox(X + HW, y + 3 + sumLines.length * sumRowH, HW, sumTotalH, HBG);
    box(X, y, W, botH, LBD);
    vLine(X + HW, y, y + botH, LBD);
    txt('Amount in Words:', X + 5, y + 4, HW - 10, { size: 7.5, bold: true, color: BLK });
    txt(wordText, X + 5, y + 14, HW - 10, { size: 7.5, color: BLK });

    let sy = y + 3;
    sumLines.forEach(([label, val]) => {
      hLine(sy, X + HW, X + W, LBD);
      txt(label, X + HW + 4, sy + 2, HW / 2 - 6, { size: 7.5, color: BLK });
      txt(val, X + HW + HW / 2, sy + 2, HW / 2 - 6, { size: 7.5, align: 'right', color: BLK });
      sy += sumRowH;
    });
    txt('Total Amount:', X + HW + 4, sy + 3, HW / 2 - 6, { size: 8, bold: true, color: BLK });
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

    const noteLines = [q.termsConditions || q.notes || '', 'This is a quotation and is valid as per the terms stated above.'].filter(Boolean);
    y = checkPage(y, 32);
    box(X, y, W, noteLines.length * 9 + 7, LBD);
    let ny = y + 4;
    noteLines.forEach(line => {
      txt(line, X + 5, ny, W - 10, { size: 7, color: GRY });
      ny += 9;
    });

    addFooters(doc);
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};
