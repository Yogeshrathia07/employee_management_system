'use strict';
const { Op } = require('sequelize');
const { Invoice, Client, Vendor, ProjectAccount } = require('../models');
const PDFDocument = require('pdfkit');
const {
  applyCompanyScope,
  applySellerCompanySnapshot,
  assertScopedRelation,
  findScopedByPk,
  getActorCompanyId,
  resolveScopedCompany,
  syncAccountsCompanyIds,
} = require('./accountsCompanyScope');
const { buildTaxSummaryLabels } = require('./pdfHelper');

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtINR(n) {
  return 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function deriveFinancialYearFromDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d)) return '';
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const start = month >= 4 ? year : year - 1;
  return String(start).slice(-2) + '-' + String(start + 1).slice(-2);
}

function normalizeFinancialYear(value, invoiceDate, invoiceNumber) {
  const fy = String(value || '').trim();
  if (/^\d{2}-\d{2}$/.test(fy)) return fy;
  const numMatch = String(invoiceNumber || '').match(/\/(\d{2}-\d{2})\//);
  if (numMatch) return numMatch[1];
  return deriveFinancialYearFromDate(invoiceDate) || currentFY();
}

function withNormalizedFinancialYear(invoice) {
  const data = invoice && typeof invoice.toJSON === 'function'
    ? invoice.toJSON()
    : Object.assign({}, invoice || {});
  data.financialYear = normalizeFinancialYear(data.financialYear, data.invoiceDate, data.invoiceNumber);
  return data;
}

function pdfSafePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function invoicePdfFilename(inv) {
  const company = pdfSafePart(inv.sellerName || 'DHPE')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const docType = pdfSafePart(inv.documentType || 'Tax Invoice')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const number = pdfSafePart(inv.invoiceNumber || 'invoice')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return [company || 'DHPE', docType || 'Tax-Invoice', number || 'invoice']
    .filter(Boolean)
    .join('-') + '.pdf';
}

// Format: {SEQ}/{CODE}/{FY}/{RANDOM}  e.g. 004/DHPE/26-27/GDTYJH
// Sequence is global per FY (shared across all codes) so manual + converted invoices
// always increment together and never restart at 001.
async function nextInvoiceNumber(fy, code) {
  const safeFY   = /^\d{2}-\d{2}$/.test(fy || '') ? fy : currentFY();
  const safeCode = ((code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV');
  const random   = Math.random().toString(36).substr(2, 6).toUpperCase();
  // Find the highest sequence already used in this FY (any code)
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

function cleanGeneratedCode(value) {
  const code = String(value || '').trim();
  if (!code) return '';
  return code.toLowerCase() === 'auto-generated' ? '' : code;
}

// ── GET /invoices ─────────────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
  try {
    const { q, status, type, from, to, financialYear } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
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
    let rows = await Invoice.findAll({ where, order: [['createdAt', 'DESC']] });
    rows = rows.map(withNormalizedFinancialYear);
    if (/^\d{2}-\d{2}$/.test(String(financialYear || '').trim())) {
      rows = rows.filter(row => row.financialYear === String(financialYear).trim());
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /invoices/:id ─────────────────────────────────────────────────────────
exports.getInvoice = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const inv = await findScopedByPk(Invoice, 'invoice', req, req.params.id, null, 'Invoice not found');
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    res.json(withNormalizedFinancialYear(inv));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /invoices ────────────────────────────────────────────────────────────
exports.createInvoice = async (req, res) => {
  try {
    const data = Object.assign({}, req.body);
    if (!data.invoiceDate)    return res.status(400).json({ message: 'Invoice date required' });
    if (!data.customerName)   return res.status(400).json({ message: 'Customer name required' });
    if (data.clientId) await assertScopedRelation(Client, 'client', req, data.clientId, 'Client not found');
    if (data.vendorId) await assertScopedRelation(Vendor, 'vendor', req, data.vendorId, 'Vendor not found');
    if (data.projectAccountId) {
      await assertScopedRelation(ProjectAccount, 'projectAccount', req, data.projectAccountId, 'Project account not found');
    }
    const company = await resolveScopedCompany(req, data);
    if (company) applySellerCompanySnapshot(data, company);
    if (getActorCompanyId(req) && !data.companyId) {
      return res.status(400).json({ message: 'Admin company not found' });
    }
    data.financialYear = normalizeFinancialYear(data.financialYear, data.invoiceDate, data.invoiceNumber);
    data.invoiceNumber = cleanGeneratedCode(data.invoiceNumber) || await nextInvoiceNumber(data.financialYear, data.companyCode);
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
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const inv = await findScopedByPk(Invoice, 'invoice', req, req.params.id, null, 'Invoice not found');
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    const updates = Object.assign({}, req.body);
    if (updates.clientId) await assertScopedRelation(Client, 'client', req, updates.clientId, 'Client not found');
    if (updates.vendorId) await assertScopedRelation(Vendor, 'vendor', req, updates.vendorId, 'Vendor not found');
    if (updates.projectAccountId) {
      await assertScopedRelation(ProjectAccount, 'projectAccount', req, updates.projectAccountId, 'Project account not found');
    }
    const company = await resolveScopedCompany(req, Object.assign({}, inv.toJSON(), updates));
    if (company) applySellerCompanySnapshot(updates, company);
    if (getActorCompanyId(req)) updates.companyId = getActorCompanyId(req);
    updates.financialYear = normalizeFinancialYear(
      updates.financialYear,
      updates.invoiceDate || inv.invoiceDate,
      updates.invoiceNumber || inv.invoiceNumber
    );
    await inv.update(updates);
    res.json(inv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /invoices/:id ──────────────────────────────────────────────────────
exports.deleteInvoice = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const inv = await findScopedByPk(Invoice, 'invoice', req, req.params.id, null, 'Invoice not found');
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
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const inv = await findScopedByPk(Invoice, 'invoice', req, req.params.id, null, 'Invoice not found');
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
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const inv = await findScopedByPk(Invoice, 'invoice', req, req.params.id, null, 'Invoice not found');
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename="${invoicePdfFilename(inv)}"`);

    const doc = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true });
    doc.pipe(res);

    // ── Constants ────────────────────────────────────────────────────────────
    const M   = 10;           // page margin
    const PW  = 595;          // page width
    const PH  = 842;          // page height
    const W   = PW - M * 2;  // 575 usable width
    const X   = M;
    const BLK = '#000000';
    const DRK = '#1a1a1a';
    const GRY = '#555555';
    const LGY = '#888888';
    const HBG = '#f2f2f2';   // header row background
    const LBD = 0.5;         // unified border width (all lines same thickness)

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
           ellipsis: opts.ellipsis !== undefined ? opts.ellipsis : false,
           lineBreak: opts.lineBreak !== undefined ? opts.lineBreak : true,
           height: opts.height,
         });
    }
    // returns height of text block
    function txtH(text, w, size, bold) {
      doc.fontSize(size || 8).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      return doc.heightOfString(String(text || ''), { width: w, lineGap: 0.5 });
    }
    function txtMeasure(text, w, size, bold, lineGap) {
      doc.fontSize(size || 8).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      return doc.heightOfString(String(text || ''), { width: w, lineGap: lineGap !== undefined ? lineGap : 0.5 });
    }
    function cellMoney(n) {
      return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function textW(text, size, bold) {
      doc.fontSize(size || 7.2).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      return doc.widthOfString(String(text || ''));
    }
    function cleanText(value) {
      return String(value || '').replace(/\r/g, '').replace(/\t/g, ' ').replace(/[ ]{2,}/g, ' ').trim();
    }
    function taxAmount(value) {
      return Math.abs(Number(value || 0));
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
    function showTaxPercentColumn() {
      if (taxExempt) return false;
      if (inv.showTaxPercentInPdf === false) return false;
      if (inv.showTaxPercentInPdf === true) return true;
      return inv.showTaxInPdf !== false;
    }
    function normalizedStateCode(code, gstin) {
      const raw = String(code || '').trim();
      if (raw) return raw.length === 1 ? '0' + raw : raw;
      const match = String(gstin || '').trim().match(/^(\d{2})/);
      return match ? match[1] : '';
    }
    function taxSummaryMode() {
      const sellerStateCode = normalizedStateCode(inv.sellerStateCode, inv.sellerGstin);
      const customerStateCode = normalizedStateCode(inv.customerStateCode, inv.customerGstin);
      if (!showTaxSummary) return 'none';
      if (taxAmount(inv.totalIgst) > 0.004 && taxAmount(inv.totalCgst) <= 0.004 && taxAmount(inv.totalSgst) <= 0.004) return 'igst';
      if (taxAmount(inv.totalCgst) > 0.004 || taxAmount(inv.totalSgst) > 0.004) return 'split';
      if (items.some(it => taxAmount(it.igst) > 0.004)) return 'igst';
      if (items.some(it => taxAmount(it.cgst) > 0.004 || taxAmount(it.sgst) > 0.004)) return 'split';
      if (sellerStateCode && customerStateCode && sellerStateCode !== customerStateCode) return 'igst';
      return 'split';
    }
    function breakLongToken(token, maxWidth, size, bold) {
      const chunks = [];
      let current = '';
      doc.fontSize(size || 7.2).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      String(token || '').split('').forEach(ch => {
        const probe = current + ch;
        if (current && doc.widthOfString(probe) > maxWidth) {
          chunks.push(current);
          current = ch;
        } else {
          current = probe;
        }
      });
      if (current) chunks.push(current);
      return chunks;
    }
    function wrapTextLines(text, maxWidth, size, bold) {
      const lines = [];
      doc.fontSize(size || 7.2).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      String(text || '-')
        .replace(/\r/g, '')
        .split('\n')
        .forEach(raw => {
          const words = raw.trim().split(/\s+/).filter(Boolean);
          if (!words.length) {
            lines.push('');
            return;
          }
          let line = '';
          words.forEach(word => {
            const fragments = doc.widthOfString(word) > maxWidth
              ? breakLongToken(word, maxWidth, size, bold)
              : [word];
            fragments.forEach(fragment => {
              const probe = line ? line + ' ' + fragment : fragment;
              if (line && doc.widthOfString(probe) > maxWidth) {
                lines.push(line);
                line = fragment;
              } else {
                line = probe;
              }
            });
          });
          if (line) lines.push(line);
        });
      return lines.length ? lines : ['-'];
    }
    function clamp(n, min, max) {
      return Math.max(min, Math.min(max, n));
    }
    function dynamicColWidth(values, min, max, size, bold, padding) {
      const widest = values.reduce((mx, value) => Math.max(mx, textW(value, size, bold)), 0);
      return clamp(Math.ceil(widest + (padding || 8)), min, max);
    }
    function fitTextSize(text, maxWidth, baseSize, minSize, bold) {
      let size = baseSize;
      while (size > minSize) {
        if (textW(text, size, bold) <= maxWidth) return size;
        size -= 0.2;
      }
      return minSize;
    }
    function assignDesc(layout, minDesc, adjustable) {
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

    const FOOTER_H = 24;  // reserved at bottom of every page for footer

    // check page space, add new page if needed
    function checkPage(y, needed) {
      if (y + needed > PH - M - FOOTER_H) {
        doc.addPage();
        return M;
      }
      return y;
    }

    let y = M;
    const items        = inv.items || [];
    const taxExempt    = !!inv.taxExempt;
    const showTaxSummary = !taxExempt;
    const showItemTaxColumns = showTaxPercentColumn();
    const showTaxPercent = showItemTaxColumns;
    const roundOffMode = normalizeRoundOffMode(inv.roundOffMode, inv.roundOff);
    const taxMode      = taxSummaryMode();
    const useIGST      = taxMode === 'igst';
    const useSplitGST  = taxMode === 'split';

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
    let hBoxH = 8;
    compLines.forEach((l, i) => {
      const sz = i === 0 ? 12 : 7.5;
      const bold = i === 0;
      hBoxH += txtH(l, HW - 14, sz, bold) + 1.5;
    });
    const hBoxHRight = metaRight.reduce((s, l, i) => s + txtH(l, HW - 12, i === 0 ? 8.5 : 7.5, i === 0) + 1.5, 5);
    const headerH = Math.max(hBoxH, hBoxHRight) + 5;

    // Draw outer box (same weight as all other boxes)
    box(X, y, W, headerH, LBD);
    // Vertical divider
    vLine(X + HW, y, y + headerH, LBD);

    // LEFT: Company info
    let ly = y + 5;
    compLines.forEach((line, i) => {
      if (!line) return;
      const sz   = i === 0 ? 12 : 7.5;
      const bold = i === 0;
      txt(line, X + 5, ly, HW - 10, { size: sz, bold, color: BLK, lineGap: 0.5 });
      ly = doc.y + (i === 0 ? 2 : 1);
    });

    // RIGHT: Invoice meta
    let ry = y + 5;
    metaRight.forEach((line, i) => {
      if (!line) return;
      const bold = i === 0;
      const sz   = i === 0 ? 8.5 : 7.5;
      txt(line, RX + 4, ry, HW - 10, { size: sz, bold, color: BLK, align: 'right', lineGap: 0.5 });
      ry = doc.y + 1;
    });

    y += headerH;

    // ════════════════════════════════════════════════════════════════════════
    // 2. BILL TO
    // ════════════════════════════════════════════════════════════════════════
    // Label row
    fillBox(X, y, W, 11, HBG);
    box(X, y, W, 11, LBD);
    txt('Bill To:', X + 5, y + 2, W - 10, { size: 7.5, bold: true, color: BLK });
    y += 11;

    // Content: left = customer name+address, right = GSTIN/PAN/email/state
    const custLeft = [
      inv.customerName || '',
      inv.customerAddress || '',
    ].filter(Boolean);
    const custRight = [
      inv.customerGstin ? 'GSTIN: ' + inv.customerGstin : '',
      inv.customerPan   ? 'PAN: ' + inv.customerPan : '',
      inv.customerEmail ? 'Email: ' + inv.customerEmail : '',
      inv.customerState ? 'State: ' + inv.customerState + (inv.customerStateCode ? ', Code: ' + inv.customerStateCode : '') : '',
    ].filter(Boolean);

    let billH = 6;
    custLeft.forEach((l, i) => { billH += txtH(l, HW - 12, i === 0 ? 8.5 : 7.5, i === 0) + 1.5; });
    const billHR = custRight.reduce((s, l) => s + txtH(l, HW - 12, 7.5, false) + 1.5, 6);
    const billBoxH = Math.max(billH, billHR) + 3;

    box(X, y, W, billBoxH, LBD);
    vLine(X + HW, y, y + billBoxH, LBD);

    let by = y + 4, bry = y + 4;
    custLeft.forEach((line, i) => {
      if (!line) return;
      txt(line, X + 5, by, HW - 10, { size: i === 0 ? 8.5 : 7.5, bold: i === 0, color: BLK });
      by = doc.y + 0.5;
    });
    custRight.forEach(line => {
      if (!line) return;
      txt(line, RX + 4, bry, HW - 10, { size: 7.5, color: BLK });
      bry = doc.y + 0.5;
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

      let woH = 5;
      woLines.forEach(l => { woH += txtH(l, W - 12, 7.5, false) + 1.5; });
      woH += 3;

      y = checkPage(y, woH);
      box(X, y, W, woH, LBD);
      let wy = y + 4;
      woLines.forEach((line, i) => {
        const bold = i === 0 || line.startsWith('Project Name');
        txt(line, X + 5, wy, W - 10, { size: 7.5, bold, color: BLK });
        wy = doc.y + 0.5;
      });
      y += woH;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4. ITEMS TABLE
    // Description gets the widest stable column. Amount keeps enough room for
    // large values, while the shorter header label avoids wasting width.
    const codeTexts = items.map(it => cleanText(it.itemCode || '') || '-').concat(['Code']);
    const hsnTexts = items.map(it => cleanText(it.hsnCode || '') || '-').concat(['HSN/SAC']);
    const unitTexts = items.map(it => cleanText(it.unit || '') || '-').concat(['Unit']);
    const qtyTexts = items.map(it => {
      const qty = parseFloat(it.quantity || 0);
      return qty % 1 === 0 ? String(qty) : qty.toFixed(3);
    }).concat(['Qty']);
    const priceTexts = items.map(it => cellMoney(parseFloat(it.unitPrice || 0))).concat(['Rate']);
    const amountTexts = items.map(it => {
      const qty = parseFloat(it.quantity || 0);
      const price = parseFloat(it.unitPrice || 0);
      const disc = parseFloat(it.discount || 0);
      const taxable = parseFloat(it.taxableAmount || (qty * price * (1 - disc / 100)));
      return cellMoney(taxable);
    }).concat(['Amount']);
    const igstTexts = items.map(it => cellMoney(parseFloat(it.igst || 0))).concat(['IGST Amt']);
    const splitTaxTexts = items.map(it => cellMoney(parseFloat(it.cgst || 0) + parseFloat(it.sgst || 0))).concat(['Tax Amt']);
    const taxPctTexts = items.map(it => parseFloat(it.taxRate || 0).toFixed(0) + '%').concat(['Tax %']);

    const COL = !showTaxSummary || !showItemTaxColumns
      ? assignDesc({
          sl: 18,
          code: dynamicColWidth(codeTexts, 28, 50, 7.1, false, 8),
          hsn: dynamicColWidth(hsnTexts, 34, 58, 7.1, false, 8),
          unit: dynamicColWidth(unitTexts, 26, 44, 7.1, false, 8),
          rate: dynamicColWidth(priceTexts, 42, 72, 7.1, false, 10),
          qty: dynamicColWidth(qtyTexts, 22, 36, 7.1, false, 8),
          amt: dynamicColWidth(amountTexts, 82, 112, 7.1, true, 12),
        }, 180, [
          { key: 'amt', min: 82 },
          { key: 'rate', min: 42 },
          { key: 'hsn', min: 34 },
          { key: 'unit', min: 26 },
          { key: 'code', min: 28 },
          { key: 'qty', min: 22 },
        ])
      : useIGST
        ? assignDesc({
            sl: 18,
            code: dynamicColWidth(codeTexts, 28, 50, 7.1, false, 8),
            hsn: dynamicColWidth(hsnTexts, 34, 58, 7.1, false, 8),
            unit: dynamicColWidth(unitTexts, 26, 44, 7.1, false, 8),
            rate: dynamicColWidth(priceTexts, 42, 72, 7.1, false, 10),
            qty: dynamicColWidth(qtyTexts, 22, 36, 7.1, false, 8),
            ...(showTaxPercent ? { taxP: dynamicColWidth(taxPctTexts, 24, 40, 6.3, true, 8) } : {}),
            taxAmt: dynamicColWidth(igstTexts, 44, 88, 7.1, false, 10),
            amt: dynamicColWidth(amountTexts, 82, 118, 7.1, true, 12),
          }, showTaxPercent ? 150 : 170, [
            { key: 'amt', min: 82 },
            { key: 'taxAmt', min: 44 },
            { key: 'rate', min: 42 },
            { key: 'hsn', min: 34 },
            { key: 'unit', min: 26 },
            { key: 'code', min: 28 },
            { key: 'qty', min: 22 },
            ...(showTaxPercent ? [{ key: 'taxP', min: 24 }] : []),
          ])
        : assignDesc({
            sl: 18,
            code: dynamicColWidth(codeTexts, 26, 48, 7.1, false, 8),
            hsn: dynamicColWidth(hsnTexts, 32, 54, 7.1, false, 8),
            unit: dynamicColWidth(unitTexts, 26, 42, 7.1, false, 8),
            rate: dynamicColWidth(priceTexts, 40, 66, 7.1, false, 10),
            qty: dynamicColWidth(qtyTexts, 20, 34, 7.1, false, 8),
            ...(showTaxPercent ? { taxP: dynamicColWidth(taxPctTexts, 22, 36, 6.3, true, 8) } : {}),
            taxAmt: dynamicColWidth(splitTaxTexts, 48, 82, 7.1, false, 10),
            amt: dynamicColWidth(amountTexts, 78, 110, 7.1, true, 12),
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
    const DATA_ROW_MIN_H = 16;
    const ROW_LINE_H = 8;
    const ITEM_SECTION_H = 11;

    function drawItemsHeader(startY, includeSectionLabel) {
      let hy = startY;
      if (includeSectionLabel) {
        fillBox(X, hy, W, ITEM_SECTION_H, HBG);
        box(X, hy, W, ITEM_SECTION_H, LBD);
        txt('Item Details', X + 5, hy + 2, W - 10, { size: 7.5, bold: true, color: BLK });
        hy += ITEM_SECTION_H;
      }

      fillBox(X, hy, W, ROW_H, HBG);
      box(X, hy, W, ROW_H, LBD);

      let cx = X;
      function th(label, w) {
        vLine(cx, hy, hy + ROW_H, LBD);
        txt(label, cx + 2, hy + 3, w - 4, { size: 6.3, bold: true, color: BLK, align: 'center' });
        cx += w;
      }

      if (!showTaxSummary || !showItemTaxColumns) {
        th('Sl.', COL.sl); th('Code', COL.code);
        th('Description', COL.desc); th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
        th('Rate', COL.rate); th('Qty', COL.qty); th('Amount', COL.amt);
      } else if (useIGST) {
        th('Sl.', COL.sl); th('Code', COL.code);
        th('Description', COL.desc); th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
        th('Rate', COL.rate); th('Qty', COL.qty);
        if (showTaxPercent) th('Tax %', COL.taxP);
        th('IGST Amt', COL.taxAmt); th('Amount', COL.amt);
      } else {
        th('Sl.', COL.sl); th('Code', COL.code);
        th('Description', COL.desc); th('HSN/SAC', COL.hsn); th('Unit', COL.unit);
        th('Rate', COL.rate); th('Qty', COL.qty);
        if (showTaxPercent) th('Tax %', COL.taxP);
        th('Tax Amt', COL.taxAmt); th('Amount', COL.amt);
      }
      return hy + ROW_H;
    }

    y = checkPage(y, ITEM_SECTION_H + ROW_H + DATA_ROW_MIN_H);
    y = drawItemsHeader(y, true);

    items.forEach((it, idx) => {
      const qty = parseFloat(it.quantity || 0);
      const price = parseFloat(it.unitPrice || 0);
      const disc = parseFloat(it.discount || 0);
      const taxRate = parseFloat(it.taxRate || 0);
      const taxable = parseFloat(it.taxableAmount || (qty * price * (1 - disc / 100)));
      const igstAmt = parseFloat(it.igst || 0);
      const cgstAmt = parseFloat(it.cgst || 0);
      const sgstAmt = parseFloat(it.sgst || 0);
      const itemCode = cleanText(it.itemCode || '');
      const hsnCode = cleanText(it.hsnCode || '');
      const unitText = cleanText(it.unit || '');
      const qtyText = qty % 1 === 0 ? String(qty) : qty.toFixed(3);
      const descText = cleanText(it.name || it.description || it.itemName || '') || '-';
      const descLines = wrapTextLines(descText, COL.desc - 10, 7.1, false);
      let lineIndex = 0;
      let firstSegment = true;

      while (lineIndex < descLines.length) {
        let available = PH - M - FOOTER_H - y;
        if (available < DATA_ROW_MIN_H) {
          doc.addPage();
          y = drawItemsHeader(M, false);
          available = PH - M - FOOTER_H - y;
        }

        let segmentLineCount = Math.min(descLines.length - lineIndex, Math.max(1, Math.floor((available - 6) / ROW_LINE_H)));
        let rowH = Math.max(DATA_ROW_MIN_H, segmentLineCount * ROW_LINE_H + 6);

        if (!segmentLineCount) {
          doc.addPage();
          y = drawItemsHeader(M, false);
          continue;
        }

        if ((idx + (firstSegment ? 0 : 1)) % 2 === 0) fillBox(X, y, W, rowH, '#fafafa');
        box(X, y, W, rowH, LBD);

        let cx = X;
        function td(text, w, opts) {
          vLine(cx, y, y + rowH, LBD);
          const to = Object.assign({ size: 7.4, align: 'center', lineGap: 0.5 }, opts || {});
          const raw = String(text || '');
          const size = to.fit ? fitTextSize(raw, w - 6, to.size, to.minSize || 6.2, !!to.bold) : to.size;
          txt(raw, cx + 3, y + 3, w - 6, Object.assign({}, to, { size: size }));
          cx += w;
        }
        function tdDesc(lines, w) {
          vLine(cx, y, y + rowH, LBD);
          lines.forEach((line, i) => {
            txt(line, cx + 3, y + 3 + (i * ROW_LINE_H), w - 6, { size: 7.1, align: 'left', lineGap: 0, color: DRK });
          });
          cx += w;
        }

        const descSlice = descLines.slice(lineIndex, lineIndex + segmentLineCount);
        td(firstSegment ? idx + 1 : '',                    COL.sl);
        td(firstSegment ? itemCode : '',                   COL.code, { fit: true, minSize: 5.6, lineBreak: false, ellipsis: true });
        tdDesc(descSlice,                                  COL.desc);
        td(firstSegment ? hsnCode : '',                    COL.hsn, { fit: true, minSize: 5.6, lineBreak: false, ellipsis: true });
        td(firstSegment ? unitText : '',                   COL.unit, { fit: true, minSize: 5.6, lineBreak: false, ellipsis: true });
        td(firstSegment ? cellMoney(price) : '',           COL.rate, { align: 'right', fit: true, minSize: 5.8, lineBreak: false });
        td(firstSegment ? qtyText : '',                    COL.qty, { fit: true, minSize: 5.8, lineBreak: false });

        if (showItemTaxColumns && useIGST) {
          if (showTaxPercent) td(firstSegment ? taxRate.toFixed(0) + '%' : '', COL.taxP, { fit: true, minSize: 5.8, lineBreak: false });
          td(firstSegment ? cellMoney(igstAmt) : '',       COL.taxAmt, { align: 'right', fit: true, minSize: 5.8, lineBreak: false });
        } else if (showItemTaxColumns && useSplitGST) {
          if (showTaxPercent) td(firstSegment ? taxRate.toFixed(0) + '%' : '', COL.taxP, { fit: true, minSize: 5.8, lineBreak: false });
          td(firstSegment ? cellMoney(cgstAmt + sgstAmt) : '', COL.taxAmt, { align: 'right', fit: true, minSize: 5.8, lineBreak: false });
        }

        td(firstSegment ? cellMoney(taxable) : '', COL.amt, { align: 'right', bold: true, size: 7.2, fit: true, minSize: 5.6, lineBreak: false });

        y += rowH;
        lineIndex += segmentLineCount;
        firstSegment = false;

        if (lineIndex < descLines.length) {
          doc.addPage();
          y = drawItemsHeader(M, false);
        }
      }
    });

    // 5. AMOUNT IN WORDS  +  SUMMARY  (side by side)
    // ════════════════════════════════════════════════════════════════════════
    y = checkPage(y, 60);

    const igstV = showTaxSummary ? taxAmount(inv.totalIgst) : 0;
    const cgstV = showTaxSummary ? taxAmount(inv.totalCgst) : 0;
    const sgstV = showTaxSummary ? taxAmount(inv.totalSgst) : 0;
    const hasSplit = cgstV > 0.004 || sgstV > 0.004;
    const splitTotal = cgstV + sgstV;
    const taxLabels = buildTaxSummaryLabels(inv, useIGST ? 'igst' : 'split');

    const sumLines = [
      ['Subtotal:', fmtINR(inv.subtotal)],
      ...(igstV > 0.004 ? [[taxLabels.igst + ':', fmtINR(igstV)]] : []),
      ...(cgstV > 0.004 ? [[taxLabels.cgst + ':', fmtINR(cgstV)]] : []),
      ...(sgstV > 0.004 ? [[taxLabels.sgst + ':', fmtINR(sgstV)]] : []),
      ...(hasSplit && splitTotal > 0.004 ? [['Total Tax:', fmtINR(splitTotal)]] : []),
      ...(roundOffMode !== 'none' ? [['Round Off:', fmtSignedINR(inv.roundOff, roundOffMode)]] : []),
    ];

    const sumRowH  = 11;
    const sumTotalH = 14;
    const sumH = sumLines.length * sumRowH + sumTotalH;
    const wordText = numWords(parseFloat(inv.totalAmount || 0));
    const wordH    = txtH(wordText, HW - 14, 7.5, false);
    const botH     = Math.max(sumH, wordH + 16);

    // Now draw all borders (they paint over the fill, keeping lines clean)
    box(X, y, W, botH, LBD);
    vLine(X + HW, y, y + botH, LBD);

    txt('Amount in Words:', X + 5, y + 4, HW - 10, { size: 7.5, bold: true, color: BLK });
    txt(wordText, X + 5, y + 14, HW - 10, { size: 7.5, color: BLK });

    // Summary rows (right half)
    let sy = y;
    sumLines.forEach(([label, val]) => {
      sy += sumRowH;
      txt(label, X + HW + 4, sy - 8, HW / 2 - 6, { size: 7.5, color: BLK });
      txt(val,   X + HW + HW / 2, sy - 8, HW / 2 - 6, { size: 7.5, align: 'right', color: BLK });
      hLine(sy, X + HW, X + W, LBD);
    });

    fillBox(X + HW, sy, HW, sumTotalH, HBG);
    box(X + HW, sy, HW, sumTotalH, LBD);
    // Total Amount row text (drawn after borders so text is on top)
    txt('Amount After Tax:', X + HW + 4, sy + 3, HW / 2 - 6,
        { size: 8, bold: true, color: BLK });
    txt(fmtINR(inv.totalAmount), X + HW + HW / 2, sy + 3, HW / 2 - 6,
        { size: 8, bold: true, color: BLK, align: 'right' });

    y += botH;

    // ════════════════════════════════════════════════════════════════════════
    // 6. BANK ACCOUNT DETAILS
    // ════════════════════════════════════════════════════════════════════════
    y = checkPage(y, 70);

    const bankLines = [
      ['Bank:',     inv.bankName    || 'N/A'],
      ['A/c Name:', inv.bankAcName  || 'N/A'],
      ['A/c No.:',  inv.bankAccount || 'N/A'],
      ['IFSC:',     inv.bankIfsc    || 'N/A'],
      ['Branch:',   inv.bankBranch  || 'N/A'],
    ];

    const bankH = bankLines.length * 10 + 17;

    // Draw fills FIRST, then all borders on top (prevents fill from covering borders)
    fillBox(X, y, W, 11, HBG);          // header background
    // Outer box + dividers drawn after fills so borders are always visible
    box(X, y, W, bankH, LBD);
    vLine(X + HW, y, y + bankH, LBD);
    hLine(y + 11, X, X + W, LBD);
    // Header labels
    txt('Bank Account Details:', X + 5, y + 2, HW - 10, { size: 7.5, bold: true, color: BLK });
    txt('Authorized Signature', X + HW + 5, y + 2, HW - 10, { size: 7.5, bold: true, color: BLK, align: 'right' });

    let bky = y + 14;
    bankLines.forEach(([label, val]) => {
      txt(label + ' ' + val, X + 5, bky, HW - 10, { size: 7.5, color: BLK });
      bky += 10;
    });

    // Signature text (bottom of right column)
    txt('For ' + (inv.sellerName || ''), X + HW + 5, y + bankH - 19,
        HW - 10, { size: 7.5, bold: true, color: BLK, align: 'right' });
    txt('Authorized Signatory', X + HW + 5, y + bankH - 10,
        HW - 10, { size: 7.5, color: BLK, align: 'right' });

    y += bankH;

    // ════════════════════════════════════════════════════════════════════════
    // 7. FOOTER NOTE
    // ════════════════════════════════════════════════════════════════════════
    const noteLines = [
      String(inv.notes || '').trim() ? 'Remarks: ' + String(inv.notes).trim() : '',
      String(inv.termsConditions || '').trim() ? 'Terms & Conditions: ' + String(inv.termsConditions).trim() : '',
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

    // ════════════════════════════════════════════════════════════════════════
    // 8. FOOTER: slim full-width footer strip on every page
    // ════════════════════════════════════════════════════════════════════════
    const footerInfoText = 'This is a computer-generated invoice.';
    const CONF_TEXT =
      'Note: This document is the property of DHPE and is confidential. It must not be disclosed, ' +
      'shared, or transmitted to any person or firm not authorized by us. No part of this ' +
      'document may be copied, reproduced, or used in whole or in part without our prior written consent.';

    const pageRange  = doc.bufferedPageRange();
    const totalPages = pageRange.count;

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      doc.switchToPage(pageRange.start + pageIndex);
      box(X, M, W, PH - (M * 2), LBD);
    }

    if (totalPages) {
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
        doc.switchToPage(pageRange.start + pageIndex);
        const pageLabel = `Page ${pageIndex + 1} of ${totalPages}`;
        const footerY = PH - M - FOOTER_H + 3;
        const pageLabelW = 60;
        const sepX = X + W - pageLabelW - 8;
        const noteW = sepX - X - 6;
        const showInfo = pageIndex === totalPages - 1;

        doc.moveTo(X, footerY)
           .lineTo(X + W, footerY)
           .lineWidth(0.3)
           .strokeColor('#d7dce5')
           .stroke();

        doc.moveTo(sepX, footerY + 2)
           .lineTo(sepX, footerY + FOOTER_H - 8)
           .lineWidth(0.3)
           .strokeColor('#d7dce5')
           .stroke();

        if (showInfo) {
          doc.fontSize(5.7).font('Helvetica-Bold').fillColor('#4b5563')
             .text(footerInfoText, X + 4, footerY + 1, {
               width: noteW,
               align: 'center',
               lineGap: 0,
             });
        }

        doc.fontSize(showInfo ? 4.9 : 5.2).font('Helvetica').fillColor('#7c8797')
           .text(CONF_TEXT, X + 4, showInfo ? footerY + 8 : footerY + 3, {
             width: noteW,
             align: 'center',
             lineGap: showInfo ? 0.1 : 0.15,
           });

        doc.fontSize(5.8).font('Helvetica').fillColor('#7c8797')
           .text(pageLabel, sepX + 4, showInfo ? footerY + 7 : footerY + 4, {
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
