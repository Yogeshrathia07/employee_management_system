'use strict';
const { Op } = require('sequelize');
const Invoice  = require('../models/Invoice');
const PDFDocument = require('pdfkit');

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n) {
  return '₹ ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
}

function numWords(n) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen',
    'Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function toWords(num) {
    if (num === 0) return '';
    if (num < 20) return ones[num] + ' ';
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '') + ' ';
    if (num < 1000) return ones[Math.floor(num / 100)] + ' Hundred ' + toWords(num % 100);
    if (num < 100000) return toWords(Math.floor(num / 1000)) + 'Thousand ' + toWords(num % 1000);
    if (num < 10000000) return toWords(Math.floor(num / 100000)) + 'Lakh ' + toWords(num % 100000);
    return toWords(Math.floor(num / 10000000)) + 'Crore ' + toWords(num % 10000000);
  }
  const intPart  = Math.floor(Math.abs(n));
  const decPart  = Math.round((Math.abs(n) - intPart) * 100);
  let result = toWords(intPart).trim() + ' Rupees';
  if (decPart > 0) result += ' and ' + toWords(decPart).trim() + ' Paise';
  return 'Rupees ' + result + '.';
}

function currentFY() {
  const now = new Date(), yr = now.getFullYear(), mo = now.getMonth() + 1;
  const start = mo >= 4 ? yr : yr - 1;
  return String(start).slice(-2) + '-' + String(start + 1).slice(-2);
}

// Format: {SEQ}/{CODE}/{FY}/{RANDOM}  e.g. 004/DHPE/26-27/GDTYJH
async function nextInvoiceNumber(fy, code) {
  const safeFY   = /^\d{2}-\d{2}$/.test(fy || '') ? fy : currentFY();
  const safeCode = ((code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV');
  const random   = Math.random().toString(36).substr(2, 6).toUpperCase();
  const count    = await Invoice.count({
    where: { invoiceNumber: { [Op.like]: `%/${safeCode}/${safeFY}/%` } },
  });
  const seq = String(count + 1).padStart(3, '0');
  return `${seq}/${safeCode}/${safeFY}/${random}`;
}

// ── GET /invoices ─────────────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
  try {
    const { q, status, type, from, to } = req.query;
    const where = {};
    if (status)        where.status      = status;
    if (type)          where.invoiceType = type;
    if (q)             where[Op.or] = [
      { invoiceNumber: { [Op.like]: `%${q}%` } },
      { customerName:  { [Op.like]: `%${q}%` } },
      { customerGstin: { [Op.like]: `%${q}%` } },
    ];
    if (from || to) {
      where.invoiceDate = {};
      if (from) where.invoiceDate[Op.gte] = from;
      if (to)   where.invoiceDate[Op.lte] = to;
    }
    const rows = await Invoice.findAll({ where, order: [['createdAt', 'DESC']] });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /invoices/:id ─────────────────────────────────────────────────────────
exports.getInvoice = async (req, res) => {
  try {
    const inv = await Invoice.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    res.json(inv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /invoices ────────────────────────────────────────────────────────────
exports.createInvoice = async (req, res) => {
  try {
    const data = req.body;
    if (!data.invoiceDate)    return res.status(400).json({ message: 'Invoice date required' });
    if (!data.customerName)   return res.status(400).json({ message: 'Customer name required' });
    data.invoiceNumber = await nextInvoiceNumber(data.financialYear, data.companyCode);
    data.createdBy     = req.user.id;
    const inv = await Invoice.create(data);
    res.status(201).json(inv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /invoices/:id ─────────────────────────────────────────────────────────
exports.updateInvoice = async (req, res) => {
  try {
    const inv = await Invoice.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    await inv.update(req.body);
    res.json(inv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /invoices/:id ──────────────────────────────────────────────────────
exports.deleteInvoice = async (req, res) => {
  try {
    const inv = await Invoice.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('invoice', inv.id, req.user, inv.toJSON(), inv.invoiceNumber || ('Invoice #' + inv.id));
    await inv.destroy();
    res.json({ message: 'Invoice deleted (moved to recycle bin)' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /invoices/:id/pay ───────────────────────────────────────────────────
exports.markPaid = async (req, res) => {
  try {
    const inv = await Invoice.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    await inv.update({
      paymentStatus: 'Paid',
      status:        'Paid',
      paymentMode:   req.body.paymentMode || inv.paymentMode || 'Bank',
      paidAt:        new Date(),
    });
    res.json(inv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /invoices/:id/pdf  (DHPE-style layout) ────────────────────────────────
exports.downloadPDF = async (req, res) => {
  try {
    const inv = await Invoice.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="Invoice-${inv.invoiceNumber}.pdf"`);

    const doc = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true });
    doc.pipe(res);

    // ── Constants ────────────────────────────────────────────────────────────
    const M   = 30;           // page margin
    const PW  = 595;          // page width
    const PH  = 842;          // page height
    const W   = PW - M * 2;  // 535 usable width
    const X   = M;
    const BLK = '#000000';
    const DRK = '#1a1a1a';
    const GRY = '#555555';
    const LGY = '#888888';
    const HBG = '#f2f2f2';   // header row background
    const LBD = 0.4;         // light border width
    const HBD = 1.0;         // heavy border width

    // ── Drawing helpers ──────────────────────────────────────────────────────
    function hLine(y, x1, x2, lw) {
      doc.moveTo(x1 !== undefined ? x1 : X, y)
         .lineTo(x2 !== undefined ? x2 : X + W, y)
         .lineWidth(lw || LBD).strokeColor(BLK).stroke();
    }
    function vLine(x, y1, y2, lw) {
      doc.moveTo(x, y1).lineTo(x, y2)
         .lineWidth(lw || LBD).strokeColor(BLK).stroke();
    }
    function box(x, y, w, h, lw) {
      doc.rect(x, y, w, h).lineWidth(lw || LBD).strokeColor(BLK).stroke();
    }
    function fillBox(x, y, w, h, fill) {
      doc.rect(x, y, w, h).fillColor(fill).fill();
    }
    function txt(text, x, y, w, opts) {
      opts = opts || {};
      doc.fontSize(opts.size || 8)
         .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(opts.color || DRK)
         .text(String(text || ''), x, y, {
           width:    w,
           align:    opts.align || 'left',
           lineGap:  opts.lineGap !== undefined ? opts.lineGap : 0.5,
           ellipsis: false,
         });
    }
    // returns height of text block
    function txtH(text, w, size, bold) {
      doc.fontSize(size || 8).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      return doc.heightOfString(String(text || ''), { width: w, lineGap: 0.5 });
    }

    // check page space, add new page if needed
    function checkPage(y, needed) {
      if (y + needed > PH - M) {
        doc.addPage();
        return M;
      }
      return y;
    }

    let y = M;
    const items    = inv.items || [];
    const useIGST  = inv.sellerStateCode && inv.customerStateCode &&
                     inv.sellerStateCode !== inv.customerStateCode;

    // ════════════════════════════════════════════════════════════════════════
    // 1. COMPANY HEADER  (left: company info | right: invoice meta)
    // ════════════════════════════════════════════════════════════════════════
    const HW = W / 2;          // half width
    const RX = X + HW;         // right column x

    // Pre-calculate company text height
    const compLines = [
      inv.sellerName || '',
      inv.sellerAddress ? 'Address: ' + inv.sellerAddress : '',
      (inv.sellerPhone || inv.sellerEmail)
        ? 'Phone: ' + (inv.sellerPhone || '') + (inv.sellerEmail ? ' | Email: ' + inv.sellerEmail : '')
        : '',
      [
        inv.sellerGstin  ? 'GSTIN: ' + inv.sellerGstin : '',
        inv.sellerPan    ? 'PAN: '   + inv.sellerPan   : '',
        inv.sellerState  ? 'State: ' + inv.sellerState + (inv.sellerStateCode ? ', Code: ' + inv.sellerStateCode : '') : '',
      ].filter(Boolean).join(' | '),
    ].filter(Boolean);

    const metaRight = [
      'TAX INVOICE (ORIGINAL FOR RECIPIENT)',
      'Date: ' + fmtDate(inv.invoiceDate) + '   Status: ' + (inv.status || 'Draft'),
      inv.billMonth      ? 'Bill for Month: ' + inv.billMonth : '',
      (inv.billPeriodFrom && inv.billPeriodTo)
        ? 'Bill Period: ' + fmtDate(inv.billPeriodFrom) + ' to ' + fmtDate(inv.billPeriodTo) : '',
      'Ref No.: ' + (inv.invoiceNumber || ''),
      inv.dueDate        ? 'Due Date: ' + fmtDate(inv.dueDate) : '',
    ].filter(Boolean);

    // estimate header box height
    let hBoxH = 16; // padding
    compLines.forEach((l, i) => {
      const sz = i === 0 ? 13 : 7.5;
      const bold = i === 0;
      hBoxH += txtH(l, HW - 16, sz, bold) + 2;
    });
    const hBoxHRight = metaRight.reduce((s, l, i) => s + txtH(l, HW - 12, i === 0 ? 9 : 7.5, i === 0) + 2, 8);
    const headerH = Math.max(hBoxH, hBoxHRight) + 8;

    // Draw outer box
    box(X, y, W, headerH, HBD);
    // Vertical divider
    vLine(X + HW, y, y + headerH, LBD);

    // LEFT: Company info
    let ly = y + 6;
    compLines.forEach((line, i) => {
      if (!line) return;
      const sz   = i === 0 ? 13 : 7.5;
      const bold = i === 0;
      txt(line, X + 6, ly, HW - 12, { size: sz, bold, color: BLK, lineGap: 1 });
      ly = doc.y + (i === 0 ? 3 : 1);
    });

    // RIGHT: Invoice meta
    let ry = y + 6;
    metaRight.forEach((line, i) => {
      if (!line) return;
      const bold = i === 0;
      const sz   = i === 0 ? 9 : 7.5;
      txt(line, RX + 4, ry, HW - 10, { size: sz, bold, color: BLK, align: 'right', lineGap: 1 });
      ry = doc.y + 1;
    });

    y += headerH;

    // ════════════════════════════════════════════════════════════════════════
    // 2. BILL TO
    // ════════════════════════════════════════════════════════════════════════
    // Label row
    fillBox(X, y, W, 14, HBG);
    box(X, y, W, 14, LBD);
    txt('Bill To:', X + 6, y + 3, W - 12, { size: 8, bold: true, color: BLK });
    y += 14;

    // Content: left = customer name+address, right = GSTIN/PAN/email/state
    const custLeft = [
      inv.customerName || '',
      inv.customerAddress || '',
    ].filter(Boolean);
    const custRight = [
      inv.customerGstin  ? 'GSTIN: ' + inv.customerGstin + (inv.customerPan ? ' | PAN: ' + inv.customerPan : '') : '',
      inv.customerEmail  ? 'Email: ' + inv.customerEmail : '',
      inv.customerState  ? 'State: ' + inv.customerState + (inv.customerStateCode ? ', Code: ' + inv.customerStateCode : '') : '',
    ].filter(Boolean);

    let billH = 10;
    custLeft.forEach((l, i) => { billH += txtH(l, HW - 14, i === 0 ? 9 : 7.5, i === 0) + 2; });
    const billHR = custRight.reduce((s, l) => s + txtH(l, HW - 14, 7.5, false) + 2, 10);
    const billBoxH = Math.max(billH, billHR) + 4;

    box(X, y, W, billBoxH, LBD);
    vLine(X + HW, y, y + billBoxH, LBD);

    let by = y + 5, bry = y + 5;
    custLeft.forEach((line, i) => {
      if (!line) return;
      txt(line, X + 6, by, HW - 14, { size: i === 0 ? 9 : 7.5, bold: i === 0, color: BLK });
      by = doc.y + 1;
    });
    custRight.forEach(line => {
      if (!line) return;
      txt(line, RX + 4, bry, HW - 10, { size: 7.5, color: BLK });
      bry = doc.y + 1;
    });

    y += billBoxH;

    // ════════════════════════════════════════════════════════════════════════
    // 3. WORK ORDER / PROJECT (optional)
    // ════════════════════════════════════════════════════════════════════════
    if (inv.workOrder || inv.projectName || inv.workDetails) {
      const woLines = [
        inv.workOrder   ? 'Work Order: ' + inv.workOrder : '',
        inv.projectName ? 'Project Name: ' + inv.projectName : '',
        inv.workDetails ? 'Work Details: ' + inv.workDetails : '',
      ].filter(Boolean);

      let woH = 8;
      woLines.forEach(l => { woH += txtH(l, W - 14, 7.5, false) + 2; });
      woH += 4;

      y = checkPage(y, woH);
      box(X, y, W, woH, LBD);
      let wy = y + 5;
      woLines.forEach((line, i) => {
        const bold = i === 0 || line.startsWith('Project Name');
        txt(line, X + 6, wy, W - 12, { size: 7.5, bold, color: BLK });
        wy = doc.y + 1;
      });
      y += woH;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4. ITEMS TABLE
    // ════════════════════════════════════════════════════════════════════════
    // Column widths (total = W = 535)
    // Column widths must sum to W (535) for IGST, and < W for CGST (remainder = Amount col)
    // IGST  total: 20+45+183+48+35+58+45+101 = 535
    // CGST  total: 18+38+126+42+30+48+33+30+38+30+38 = 471  →  amtW = 64
    const COL = useIGST
      ? { sl:20, code:45, desc:183, hsn:48, unit:35, rate:58, qty:45, amt:101 }
      : { sl:18, code:38, desc:126, hsn:42, unit:30, rate:48, qty:33, cgstP:30, cgst:38, sgstP:30, sgst:38 };

    // Table section label
    y = checkPage(y, 30);
    fillBox(X, y, W, 14, HBG);
    box(X, y, W, 14, LBD);
    txt('Item Details', X + 6, y + 3, W - 12, { size: 8, bold: true, color: BLK });
    y += 14;

    // Header row
    const ROW_H = 18;
    fillBox(X, y, W, ROW_H, HBG);
    box(X, y, W, ROW_H, LBD);

    // Draw header cells
    function drawColHeaders(y) {
      let cx = X;
      function th(label, w) {
        vLine(cx, y, y + ROW_H, LBD);
        txt(label, cx + 2, y + 4, w - 4, { size: 7, bold: true, color: BLK, align: 'center' });
        cx += w;
      }
      if (useIGST) {
        th('Sl.', COL.sl); th('Item Code', COL.code); th('Description', COL.desc);
        th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
        th('Rate (₹)', COL.rate); th('Qty', COL.qty); th('Amount (₹)', COL.amt);
      } else {
        th('Sl.', COL.sl); th('Item Code', COL.code); th('Description', COL.desc);
        th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
        th('Rate (₹)', COL.rate); th('Qty', COL.qty);
        th('CGST%', COL.cgstP); th('CGST', COL.cgst);
        th('SGST%', COL.sgstP); th('SGST', COL.sgst);
        // Amount column fills remainder
        const amtW = W - (COL.sl+COL.code+COL.desc+COL.hsn+COL.unit+COL.rate+COL.qty+COL.cgstP+COL.cgst+COL.sgstP+COL.sgst);
        vLine(cx, y, y + ROW_H, LBD);
        txt('Amount (₹)', cx + 2, y + 4, amtW - 4, { size: 7, bold: true, color: BLK, align: 'center' });
      }
    }
    drawColHeaders(y);
    y += ROW_H;

    // Item rows
    items.forEach((it, idx) => {
      const qty      = parseFloat(it.quantity  || 0);
      const price    = parseFloat(it.unitPrice || 0);
      const disc     = parseFloat(it.discount  || 0);
      const taxRate  = parseFloat(it.taxRate   || 0);
      const taxable  = parseFloat(it.taxableAmount  || (qty * price * (1 - disc / 100)));
      const igst     = parseFloat(it.igst  || (taxable * taxRate / 100));
      const cgst     = parseFloat(it.cgst  || (igst / 2));
      const total    = parseFloat(it.itemTotal || (taxable + igst));
      const itemCode = it.itemCode || 'N/A';

      // Calculate row height based on description
      const descW = (useIGST ? COL.desc : COL.desc) - 6;
      const descH = txtH(it.name || '', descW, 7.5, false);
      const rowH  = Math.max(descH + 8, 18);

      y = checkPage(y, rowH + 2);
      if (idx % 2 === 0) fillBox(X, y, W, rowH, '#fafafa');
      box(X, y, W, rowH, LBD);

      let cx = X;
      function td(text, w, opts) {
        vLine(cx, y, y + rowH, LBD);
        txt(text, cx + 2, y + (rowH - (opts && opts.size ? opts.size + 2 : 9)) / 2 + 1,
            w - 4, Object.assign({ size: 7.5, align: 'center', lineGap: 0.5 }, opts || {}));
        cx += w;
      }
      function tdDesc(text, w) {
        vLine(cx, y, y + rowH, LBD);
        txt(text, cx + 3, y + 3, w - 6, { size: 7.5, align: 'left', lineGap: 1 });
        cx += w;
      }

      if (useIGST) {
        td(idx + 1, COL.sl);
        td(itemCode, COL.code);
        tdDesc(it.name || '', COL.desc);
        td(it.hsnCode || '', COL.hsn);
        td(it.unit || '', COL.unit);
        td(price.toFixed(2), COL.rate, { align: 'right' });
        td(qty % 1 === 0 ? qty : qty.toFixed(3), COL.qty);
        td(total.toFixed(2), COL.amt, { align: 'right', bold: true });
      } else {
        td(idx + 1, COL.sl);
        td(itemCode, COL.code);
        tdDesc(it.name || '', COL.desc);
        td(it.hsnCode || '', COL.hsn);
        td(it.unit || '', COL.unit);
        td(price.toFixed(2), COL.rate, { align: 'right' });
        td(qty % 1 === 0 ? qty : qty.toFixed(3), COL.qty);
        td((taxRate / 2).toFixed(0) + '%', COL.cgstP);
        td(cgst.toFixed(2), COL.cgst, { align: 'right' });
        td((taxRate / 2).toFixed(0) + '%', COL.sgstP);
        td(cgst.toFixed(2), COL.sgst, { align: 'right' });
        const amtW = W - (COL.sl+COL.code+COL.desc+COL.hsn+COL.unit+COL.rate+COL.qty+COL.cgstP+COL.cgst+COL.sgstP+COL.sgst);
        vLine(cx, y, y + rowH, LBD);
        txt(total.toFixed(2), cx + 2, y + (rowH - 10) / 2 + 1, amtW - 4, { size: 7.5, align: 'right', bold: true, lineGap: 0.5 });
      }

      y += rowH;
    });

    // ════════════════════════════════════════════════════════════════════════
    // 5. AMOUNT IN WORDS  +  SUMMARY  (side by side)
    // ════════════════════════════════════════════════════════════════════════
    y = checkPage(y, 60);

    const sumLines = [
      ['Subtotal:', fmtINR(inv.subtotal)],
      ...(useIGST
        ? [['IGST (' + (items[0] ? items[0].taxRate : '') + '%):', fmtINR(inv.totalIgst)]]
        : [
            ['SGST:', fmtINR(inv.totalSgst)],
            ['CGST:', fmtINR(inv.totalCgst)],
          ]),
      ...(parseFloat(inv.roundOff) ? [['Round Off:', fmtINR(inv.roundOff)]] : []),
    ];

    const sumRowH  = 14;
    const sumTotalH = 18;
    const sumH = sumLines.length * sumRowH + sumTotalH;
    const wordText = numWords(parseFloat(inv.totalAmount || 0));
    const wordH    = txtH(wordText, HW - 16, 8, false);
    const botH     = Math.max(sumH + 4, wordH + 28);

    box(X, y, HW, botH, LBD);          // Amount in words box
    box(X + HW, y, HW, botH, LBD);     // Summary box

    txt('Amount in Words (This Bill):', X + 6, y + 5, HW - 12, { size: 7.5, bold: true, color: BLK });
    txt(wordText, X + 6, y + 18, HW - 12, { size: 8, color: BLK });

    // Summary rows
    let sy = y + 4;
    sumLines.forEach(([label, val]) => {
      hLine(sy, X + HW, X + W, LBD);
      txt(label, X + HW + 4, sy + 3, HW / 2 - 6, { size: 8, color: BLK });
      txt(val,   X + HW + HW / 2, sy + 3, HW / 2 - 6, { size: 8, align: 'right', color: BLK });
      sy += sumRowH;
    });

    // Total Amount row (bold blue-ish)
    fillBox(X + HW, sy, HW, sumTotalH, '#1d4ed8');
    txt('Total Amount:', X + HW + 4, sy + 4, HW / 2 - 6,
        { size: 9, bold: true, color: '#ffffff' });
    txt(fmtINR(inv.totalAmount), X + HW + HW / 2, sy + 4, HW / 2 - 6,
        { size: 9, bold: true, color: '#ffffff', align: 'right' });

    y += botH;

    // ════════════════════════════════════════════════════════════════════════
    // 6. BANK ACCOUNT DETAILS
    // ════════════════════════════════════════════════════════════════════════
    y = checkPage(y, 70);

    const bankLines = [
      ['Bank:', inv.bankName    || 'N/A'],
      ['A/c Name:', inv.bankAcName  || 'N/A'],
      ['A/c No.:', inv.bankAccount || 'N/A'],
      ['IFSC:',   inv.bankIfsc   || 'N/A'],
      ['Branch:', inv.bankBranch  || 'N/A'],
    ];

    const bankH = bankLines.length * 12 + 20;
    box(X, y, HW, bankH, LBD);

    // Bank label header
    fillBox(X, y, HW, 14, HBG);
    hLine(y + 14, X, X + HW, LBD);
    txt('Bank Account Details:', X + 6, y + 3, HW - 12, { size: 8, bold: true, color: BLK });
    let bky = y + 18;
    bankLines.forEach(([label, val]) => {
      txt(label + ' ' + val, X + 6, bky, HW - 12, { size: 7.5, color: BLK });
      bky += 12;
    });

    // Signature box (right side, same height)
    box(X + HW, y, HW, bankH, LBD);
    txt('For ' + (inv.sellerName || ''), X + HW + 4, y + bankH - 30,
        HW - 10, { size: 8, bold: true, color: BLK, align: 'right' });
    txt('Authorized Signatory', X + HW + 4, y + bankH - 16,
        HW - 10, { size: 8, color: BLK, align: 'right' });

    y += bankH;

    // ════════════════════════════════════════════════════════════════════════
    // 7. FOOTER NOTE
    // ════════════════════════════════════════════════════════════════════════
    y = checkPage(y, 32);
    const noteLines = [
      inv.termsConditions || '',
      'Note: This is a computer-generated invoice.',
    ].filter(Boolean);

    box(X, y, W, noteLines.length * 11 + 10, LBD);
    let ny = y + 5;
    noteLines.forEach(line => {
      txt(line, X + 6, ny, W - 12, { size: 7, color: GRY });
      ny += 11;
    });

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};
