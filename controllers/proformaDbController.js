'use strict';
const { Op } = require('sequelize');
const { Proforma, Invoice, Client, Quotation } = require('../models');
const {
  M, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, buildPdfFilename, createDoc, addFooters,
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
    const priceTexts = items.map(it => cellMoney(parseFloat(it.unitPrice || 0))).concat(['Rate']);
    const amtTexts = items.map(it => {
      const qty = parseFloat(it.quantity || 0), price = parseFloat(it.unitPrice || 0);
      const disc = parseFloat(it.discount || 0);
      const taxable = parseFloat(it.taxableAmount || (qty * price * (1 - disc / 100)));
      const tot = parseFloat(it.itemTotal || (taxable + parseFloat(it.igst || 0) + parseFloat(it.cgst || 0) + parseFloat(it.sgst || 0)));
      return cellMoney(tot);
    }).concat(['Total']);
    const taxAmtTexts = showTax ? items.map(it =>
      useIGST ? cellMoney(parseFloat(it.igst || 0))
              : cellMoney(parseFloat(it.cgst || 0) + parseFloat(it.sgst || 0))
    ).concat(['Tax Amt']) : [];

    const rateW  = dynW(priceTexts, 36, 52, 7.1, false, 8);
    const amtW   = dynW(amtTexts, 70, 88, 7.1, true, 10);
    const taxPW  = showTax ? 28 : 0;
    const taxAmtW = showTax ? dynW(taxAmtTexts, 44, 64, 7.1, false, 8) : 0;
    const fixedSum = 18 + 30 + 36 + 22 + 20 + rateW + taxPW + taxAmtW + amtW;
    const descW = Math.max(120, W - fixedSum);
    const COL = { sl: 18, code: 30, desc: descW, hsn: 36, unit: 22, qty: 20, rate: rateW, taxP: taxPW, taxAmt: taxAmtW, amt: amtW };

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
      if (showTax) {
        th('Tax %', COL.taxP);
        th(useIGST ? 'IGST Amt' : 'Tax Amt', COL.taxAmt);
      }
      th('Total', COL.amt);
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
      const total   = parseFloat(it.itemTotal || (taxable + igstAmt + cgstAmt + sgstAmt));
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
          txt(String(text), dcx+3, y+3, w-6, to);
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
        td(firstSeg ? itemCode : '',                                COL.code);
        tdDesc(seg,                                                 COL.desc);
        td(firstSeg ? (it.hsnCode || '') : '',                     COL.hsn);
        td(firstSeg ? (it.unit || '') : '',                        COL.unit);
        td(firstSeg ? cellMoney(price) : '',                       COL.rate, { align:'right' });
        td(firstSeg ? (qty % 1 === 0 ? qty : qty.toFixed(3)) : '', COL.qty);
        if (showTax) {
          td(firstSeg ? taxRate.toFixed(0) + '%' : '', COL.taxP);
          td(firstSeg ? cellMoney(useIGST ? igstAmt : cgstAmt + sgstAmt) : '', COL.taxAmt, { align:'right' });
        }
        td(firstSeg ? cellMoney(total) : '', COL.amt, { align:'right', bold:true });

        y += rowH;
        lineIdx += segCount;
        firstSeg = false;
        if (lineIdx < descLns.length) { doc.addPage(); y = drawProHeader(M, false); }
      }
    });

    // ── 5. AMOUNT IN WORDS + SUMMARY ───────────────────────────────────────────
    y = checkPage(y, 60);
    const igstV = showTax ? parseFloat(p.totalIgst || 0) : 0;
    const cgstV = showTax ? parseFloat(p.totalCgst || 0) : 0;
    const sgstV = showTax ? parseFloat(p.totalSgst || 0) : 0;
    const hasSplit = cgstV > 0.004 || sgstV > 0.004;
    const splitTotal = cgstV + sgstV;

    const sumLines = [
      ['Subtotal:', fmtINR(p.subtotal)],
      ...(igstV > 0.004 ? [['IGST:', fmtINR(igstV)]] : []),
      ...(cgstV > 0.004 ? [['CGST:', fmtINR(cgstV)]] : []),
      ...(sgstV > 0.004 ? [['SGST:', fmtINR(sgstV)]] : []),
      ...(hasSplit && splitTotal > 0.004 ? [['Total Tax:', fmtINR(splitTotal)]] : []),
      ...(parseFloat(p.roundOff) ? [['Round Off:', fmtINR(p.roundOff)]] : []),
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
        const fy = PH - M - FOOTER_H;
        const pageLabelW = 62;
        doc.moveTo(X, fy).lineTo(X + W, fy).lineWidth(0.3).strokeColor('#aaaaaa').stroke();
        doc.fontSize(5.8).font('Helvetica').fillColor(LGY)
           .text(CONF_TEXT, X+4, fy+6, { width: W - pageLabelW - 14, align:'left', lineGap:0.7 });
        doc.fontSize(6.2).font('Helvetica').fillColor(GRY)
           .text(`Page ${pi + 1} of ${totalPages}`, X + W - pageLabelW - 4, fy + 18, pageLabelW, { align:'right', lineGap:0 });
      }
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};
