'use strict';
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// TTF fonts that can render the ₹ sign. The first pair that exists on the host
// wins (Windows dev machines, common Linux/macOS server font packages); when
// none is installed the PDF falls back to Helvetica with "Rs.".
const UNICODE_FONT_CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf', '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'],
  ['/usr/share/fonts/noto/NotoSans-Regular.ttf', '/usr/share/fonts/noto/NotoSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
  ['/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf', '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf'],
  ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
  ['/Library/Fonts/Arial.ttf', '/Library/Fonts/Arial Bold.ttf'],
];
let resolvedUnicodeFonts;

function resolveUnicodeFonts() {
  if (resolvedUnicodeFonts !== undefined) return resolvedUnicodeFonts;
  const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [[path.join(winDir, 'Fonts', 'arial.ttf'), path.join(winDir, 'Fonts', 'arialbd.ttf')]]
    .concat(UNICODE_FONT_CANDIDATES);
  const found = candidates.find(([regular, bold]) => fs.existsSync(regular) && fs.existsSync(bold));
  resolvedUnicodeFonts = found ? { regular: found[0], bold: found[1] } : null;
  return resolvedUnicodeFonts;
}

// Registers "Body"/"Body-Bold" on the document and reports whether ₹ renders.
function useUnicodeFonts(doc) {
  const fonts = resolveUnicodeFonts();
  if (fonts) {
    try {
      doc.registerFont('Body', fonts.regular);
      doc.registerFont('Body-Bold', fonts.bold);
      doc.font('Body');
      const face = doc._font && doc._font.font;
      const rupee = !!(face && typeof face.hasGlyphForCodePoint === 'function' && face.hasGlyphForCodePoint(0x20B9));
      return { regular: 'Body', bold: 'Body-Bold', rupee };
    } catch (err) {
      // unreadable font file — fall through to the built-in font
    }
  }
  doc.font('Helvetica');
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', rupee: false };
}

const M        = 10;
const PW       = 595;
const PH       = 842;
const W        = PW - M * 2;   // 555
const X        = M;
const BLK      = '#000000';
const DRK      = '#1a1a1a';
const GRY      = '#555555';
const LGY      = '#888888';
const HBG      = '#f2f2f2';
const LBD      = 0.5;
const FOOTER_H = 24;

function confidentialityText(companyName) {
  const owner = String(companyName || '').replace(/\s+/g, ' ').trim();
  return 'Note: This document is ' + (owner ? 'the property of ' + owner + ' and ' : '') + 'confidential. It must not be disclosed, ' +
  'shared, or transmitted to any person or firm not authorized by us. No part of this ' +
  'document may be copied, reproduced, or used in whole or in part without our prior written consent.';
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+'/'+d.getFullYear();
}

function fmtINR(n) {
  return 'Rs. ' + Number(n||0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function numWords(n) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function toWords(num) {
    if (num === 0) return '';
    if (num < 20)       return ones[num] + ' ';
    if (num < 100)      return tens[Math.floor(num/10)] + (num%10 ? ' '+ones[num%10] : '') + ' ';
    if (num < 1000)     return ones[Math.floor(num/100)] + ' Hundred ' + toWords(num%100);
    if (num < 100000)   return toWords(Math.floor(num/1000))    + 'Thousand ' + toWords(num%1000);
    if (num < 10000000) return toWords(Math.floor(num/100000))  + 'Lakh '     + toWords(num%100000);
    return               toWords(Math.floor(num/10000000)) + 'Crore ' + toWords(num%10000000);
  }
  const intPart = Math.floor(Math.abs(n));
  const decPart = Math.round((Math.abs(n) - intPart) * 100);
  let result = toWords(intPart).trim() + ' Rupees';
  if (decPart > 0) result += ' and ' + toWords(decPart).trim() + ' Paise';
  return 'Rupees ' + result + '.';
}

function pdfSafePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPdfFilename(parts) {
  const base = (parts || [])
    .map(pdfSafePart)
    .filter(Boolean)
    .join('-');
  return (base || 'document') + '.pdf';
}

function normalizeTaxRate(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0.0001) return 0;
  return Math.round(num * 10000) / 10000;
}

function uniquePositiveRates(values) {
  return Array.from(
    new Set((values || []).map(normalizeTaxRate).filter(rate => rate > 0))
  ).sort((a, b) => a - b);
}

function formatTaxRate(rate) {
  const normalized = normalizeTaxRate(rate);
  if (!normalized) return '0%';
  if (Math.abs(normalized - Math.round(normalized)) < 0.0001) {
    return Math.round(normalized) + '%';
  }
  return parseFloat(normalized.toFixed(2)) + '%';
}

function collectItemTaxRates(record) {
  const items = Array.isArray(record && record.items) ? record.items : [];
  return uniquePositiveRates(items.map(item => Number(item && item.taxRate || 0)));
}

function hasValue(value) {
  return !(value === null || value === undefined || (typeof value === 'string' && value.trim() === ''));
}

function providedNumber(value) {
  if (!hasValue(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstProvidedNumber() {
  for (let i = 0; i < arguments.length; i += 1) {
    const num = providedNumber(arguments[i]);
    if (num !== null) return num;
  }
  return null;
}

function firstTextValue() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeAccountItem(item, taxModeHint) {
  const source = item || {};
  const quantity = firstProvidedNumber(source.quantity, source.qty, 0) || 0;
  const unitPrice = firstProvidedNumber(source.unitPrice, source.rate, 0) || 0;
  const discount = firstProvidedNumber(source.discount, 0) || 0;
  const taxRate = firstProvidedNumber(source.taxRate, source.taxPercent, 0) || 0;
  const computedTaxable = roundMoney(quantity * unitPrice * (1 - (discount / 100)));
  const taxableAmount = roundMoney(firstProvidedNumber(source.taxableAmount, computedTaxable) || 0);
  let cgst = firstProvidedNumber(source.cgst);
  let sgst = firstProvidedNumber(source.sgst);
  let igst = firstProvidedNumber(source.igst);
  let taxAmount = firstProvidedNumber(source.taxAmount);
  const inferredMode = taxModeHint === 'igst' || taxModeHint === 'split'
    ? taxModeHint
    : ((igst || 0) > 0.004 && (cgst || 0) <= 0.004 && (sgst || 0) <= 0.004 ? 'igst' : 'split');

  if (taxAmount === null) {
    const summedTax = roundMoney((cgst || 0) + (sgst || 0) + (igst || 0));
    taxAmount = summedTax > 0.004 ? summedTax : null;
  }

  if (taxAmount !== null && cgst === null && sgst === null && igst === null) {
    if (inferredMode === 'igst') {
      igst = taxAmount;
      cgst = 0;
      sgst = 0;
    } else {
      cgst = roundMoney(taxAmount / 2);
      sgst = roundMoney(taxAmount / 2);
      igst = 0;
    }
  }

  if (taxAmount === null && taxRate > 0.0001 && taxableAmount > 0.0001) {
    taxAmount = roundMoney(taxableAmount * taxRate / 100);
    if (inferredMode === 'igst') {
      igst = taxAmount;
      cgst = 0;
      sgst = 0;
    } else {
      cgst = roundMoney(taxAmount / 2);
      sgst = roundMoney(taxAmount / 2);
      igst = 0;
    }
  }

  cgst = roundMoney(cgst || 0);
  sgst = roundMoney(sgst || 0);
  igst = roundMoney(igst || 0);
  taxAmount = roundMoney(taxAmount === null ? (cgst + sgst + igst) : taxAmount);

  const itemTotal = roundMoney(firstProvidedNumber(source.itemTotal, source.total, taxableAmount + taxAmount) || 0);
  const code = firstTextValue(source.itemCode, source.code);
  const description = firstTextValue(source.name, source.description, source.itemName);
  const hsnCode = firstTextValue(source.hsnCode, source.hsnSac, source.hsn);
  const unit = firstTextValue(source.unit);

  return {
    itemCode: code,
    code: code,
    name: description,
    description: description,
    itemName: description,
    hsnCode: hsnCode,
    hsnSac: hsnCode,
    hsn: hsnCode,
    unit: unit,
    quantity: quantity,
    qty: quantity,
    unitPrice: unitPrice,
    rate: unitPrice,
    discount: discount,
    taxRate: roundMoney(taxRate),
    taxPercent: roundMoney(taxRate),
    taxableAmount: taxableAmount,
    cgst: cgst,
    sgst: sgst,
    igst: igst,
    taxAmount: taxAmount,
    itemTotal: itemTotal,
  };
}

function normalizeAccountItems(items, taxModeHint) {
  return (Array.isArray(items) ? items : []).map(item => normalizeAccountItem(item, taxModeHint));
}

function deriveItemTotals(items) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    acc.subtotal += roundMoney(item && item.taxableAmount || 0);
    acc.totalCgst += roundMoney(item && item.cgst || 0);
    acc.totalSgst += roundMoney(item && item.sgst || 0);
    acc.totalIgst += roundMoney(item && item.igst || 0);
    return acc;
  }, { subtotal: 0, totalCgst: 0, totalSgst: 0, totalIgst: 0 });
}

function buildTaxSummaryLabels(record, mode) {
  const itemRates = collectItemTaxRates(record);
  const splitRates = uniquePositiveRates(
    (record ? [record.sgstRate, record.cgstRate] : []).concat(
      itemRates.length ? itemRates.map(rate => rate / 2) : []
    )
  );
  const igstRates = uniquePositiveRates(
    (record ? [Number(record.sgstRate || 0) + Number(record.cgstRate || 0)] : []).concat(itemRates)
  );
  const formatList = rates => rates.map(formatTaxRate).join(', ');
  return {
    cgst: splitRates.length ? 'CGST @ ' + formatList(splitRates) : 'CGST',
    sgst: splitRates.length ? 'SGST @ ' + formatList(splitRates) : 'SGST',
    igst: mode === 'igst' && igstRates.length ? 'IGST @ ' + formatList(igstRates) : 'IGST',
  };
}

function createDoc() {
  const doc = new PDFDocument({ margin:0, size:'A4', bufferPages:true });

  function hLine(y, x1, x2, lw) {
    doc.moveTo(x1!==undefined?x1:X, y).lineTo(x2!==undefined?x2:X+W, y)
       .lineWidth(lw||LBD).strokeColor(BLK).stroke();
  }
  function vLine(x, y1, y2, lw) {
    doc.moveTo(x,y1).lineTo(x,y2).lineWidth(lw||LBD).strokeColor(BLK).stroke();
  }
  function box(x, y, w, h, lw) {
    doc.rect(x,y,w,h).lineWidth(lw||LBD).strokeColor(BLK).stroke();
  }
  function fillBox(x, y, w, h, fill) {
    doc.rect(x,y,w,h).fillColor(fill).fill();
  }
  function txt(text, x, y, w, opts) {
    opts = opts || {};
    doc.fontSize(opts.size||8).font(opts.bold?'Helvetica-Bold':'Helvetica')
       .fillColor(opts.color||DRK)
       .text(String(text ?? ''), x, y, {
         width:w, align:opts.align||'left',
         lineGap:opts.lineGap!==undefined?opts.lineGap:0.5,
         ellipsis:opts.ellipsis!==undefined?opts.ellipsis:false,
         lineBreak:opts.lineBreak!==undefined?opts.lineBreak:true,
         height:opts.height,
       });
  }
  function txtH(text, w, size, bold) {
    doc.fontSize(size||8).font(bold?'Helvetica-Bold':'Helvetica');
    return doc.heightOfString(String(text ?? ''), { width:w, lineGap:0.5 });
  }
  function checkPage(y, needed) {
    if (y + needed > PH - M - FOOTER_H) { doc.addPage(); return M; }
    return y;
  }

  return { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage };
}

function addFooters(doc, options) {
  options = options || {};
  const confidentialNote = confidentialityText(options.companyName);
  const infoText = String(options.infoText || '').trim();
  const infoOnAllPages = options.infoOnAllPages === true;
  const range = doc.bufferedPageRange();
  const total = range.count;
  if (!total) return;
  for (let pageIndex = 0; pageIndex < total; pageIndex += 1) {
    doc.switchToPage(range.start + pageIndex);
    const pageW = doc.page.width - M * 2;
    const footerY = doc.page.height - M - FOOTER_H + 3;
    const pageLabelW = 60;
    const sepX = X + pageW - pageLabelW - 8;
    const noteW = sepX - X - 6;
    const showInfo = !!infoText && (infoOnAllPages || pageIndex === total - 1);

    doc.moveTo(X, footerY)
      .lineTo(X + pageW, footerY)
      .lineWidth(0.3)
      .strokeColor('#d7dce5')
      .stroke();

    doc.moveTo(sepX, footerY + 2)
      .lineTo(sepX, footerY + FOOTER_H - 8)
      .lineWidth(0.3)
      .strokeColor('#d7dce5')
      .stroke();

    if (showInfo) {
      doc.fontSize(5.5).font('Helvetica-Bold').fillColor('#4b5563')
        .text(infoText, X + 4, footerY + 1, {
          width: noteW,
          align: 'center',
          lineGap: 0,
        });
    }

    let noteSize = showInfo ? 4.9 : 5.2;
    const noteY = showInfo ? footerY + 8 : footerY + 3;
    doc.font('Helvetica').fontSize(noteSize);
    while (noteSize > 3.5 && doc.heightOfString(confidentialNote, { width: noteW, lineGap: 0.1 }) > doc.page.height - M - noteY) {
      noteSize -= 0.2;
      doc.fontSize(noteSize);
    }
    doc.fillColor('#7c8797')
      .text(confidentialNote, X + 4, noteY, {
        width: noteW,
        align: 'center',
        lineGap: showInfo ? 0.1 : 0.15,
      });

    doc.fontSize(5.8).font('Helvetica').fillColor('#7c8797')
      .text(`Page ${pageIndex + 1} of ${total}`, sepX + 4, showInfo ? footerY + 7 : footerY + 4, {
        width: pageLabelW,
        align: 'right',
        lineGap: 0,
      });
  }
}

// Split at a word boundary before drawing, so PDFKit cannot create an untracked page.
function splitTextToFit(h, text, width, height, size, bold) {
  const value = String(text ?? '');
  if (h.txtH(value, width, size, bold) <= height) return [value, ''];
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (h.txtH(value.slice(0, mid), width, size, bold) <= height) low = mid;
    else high = mid - 1;
  }
  if (!low) throw new Error('PDF text area is too small for one line');
  const boundary = value.slice(0, low + 1).search(/\s+\S*$/);
  const end = boundary > 0 ? boundary : low;
  return [value.slice(0, end).trimEnd(), value.slice(end).trimStart()];
}

function drawTextSection(h, label, text, y, options = {}) {
  let remaining = String(text ?? '').trim();
  if (!remaining) return y;
  const size = options.size || 7.5;
  let continued = false;
  while (remaining) {
    y = h.checkPage(y, 11 + h.txtH('Ag', W - 10, size) + 10);
    y = drawSectionLabel(h, label + (continued ? ' (continued)' : ''), y);
    const available = PH - M - FOOTER_H - y - 9;
    const [part, rest] = splitTextToFit(h, remaining, W - 10, available, size);
    const height = h.txtH(part, W - 10, size) + 9;
    h.box(X, y, W, height, LBD);
    h.txt(part, X + 5, y + 4, W - 10, { size, color: options.color || GRY });
    y += height;
    remaining = rest;
    continued = true;
  }
  return y;
}

function drawDetailRows(h, rows, y, options = {}) {
  const labelWidth = options.labelWidth || 150;
  const valueWidth = W - labelWidth - 12;
  rows.forEach(([label, value], index) => {
    let remaining = String(value ?? '').trim() || 'N/A';
    let continued = false;
    while (remaining) {
      const caption = label + (continued ? ' (continued)' : '');
      const minH = Math.max(14, h.txtH(caption, labelWidth - 10, 7.5, true) + 7);
      y = h.checkPage(y, Math.max(minH, h.txtH('Ag', valueWidth, 7.5) + 8));
      const available = PH - M - FOOTER_H - y - 8;
      const [part, rest] = splitTextToFit(h, remaining, valueWidth, available, 7.5);
      const height = Math.max(minH, h.txtH(part, valueWidth, 7.5) + 7);
      if (index % 2 === 0) h.fillBox(X, y, W, height, '#fafafa');
      h.box(X, y, W, height, LBD);
      h.vLine(X + labelWidth, y, y + height, LBD);
      h.txt(caption, X + 5, y + 3, labelWidth - 10, { size: 7.5, bold: true, color: BLK });
      h.txt(part, X + labelWidth + 6, y + 3, valueWidth, { size: 7.5, color: BLK });
      y += height;
      remaining = rest;
      continued = true;
    }
  });
  return y;
}

function drawPagedTable(h, columns, rows, y, options = {}) {
  const size = options.size || 7.5;
  const headerH = options.headerHeight || 14;
  const minRowH = Math.max(16, h.txtH('Ag', 100, size) + 8);
  const pageBottom = PH - M - FOOTER_H;
  function header() {
    h.fillBox(X, y, W, headerH, HBG);
    h.box(X, y, W, headerH, LBD);
    let x = X;
    columns.forEach(column => {
      h.vLine(x, y, y + headerH, LBD);
      h.txt(column.label, x + 2, y + 3, column.width - 4, { size: 6.3, bold: true, align: 'center', color: BLK });
      x += column.width;
    });
    y += headerH;
  }
  y = h.checkPage(y, 11 + headerH + minRowH);
  y = drawSectionLabel(h, options.label || 'Item Details', y);
  header();
  rows.forEach((values, rowIndex) => {
    let remaining = values.map(value => String(value ?? ''));
    do {
      const fullH = Math.max(minRowH, ...remaining.map((value, i) => h.txtH(value, columns[i].width - 6, size, columns[i].bold) + 8));
      const needed = fullH <= pageBottom - M - headerH ? fullH : minRowH;
      if (y + needed > pageBottom) { h.doc.addPage(); y = M; header(); }
      const segments = remaining.map((value, i) => value
        ? splitTextToFit(h, value, columns[i].width - 6, pageBottom - y - 8, size, columns[i].bold)
        : ['', '']);
      const rowH = Math.max(minRowH, ...segments.map(([value], i) => h.txtH(value, columns[i].width - 6, size, columns[i].bold) + 8));
      if (rowIndex % 2 === 0) h.fillBox(X, y, W, rowH, '#fafafa');
      h.box(X, y, W, rowH, LBD);
      let x = X;
      columns.forEach((column, i) => {
        h.vLine(x, y, y + rowH, LBD);
        h.txt(segments[i][0], x + 3, y + 3, column.width - 6,
          { size, bold: column.bold, align: column.align || 'center', color: BLK });
        x += column.width;
      });
      y += rowH;
      remaining = segments.map(segment => segment[1]);
    } while (remaining.some(Boolean));
  });
  return y;
}

// ── Standard header box: company info (left) | doc meta (right) ───────────────
function drawHeader(h, metaRight, sellerLines) {
  const { doc, hLine, vLine, box, fillBox, txt, txtH } = h;
  const HW = W / 2;
  const RX = X + HW;

  let hBoxH = 8;
  sellerLines.forEach((l, i) => {
    hBoxH += txtH(l, HW - 14, i===0?12:7.5, i===0) + 1.5;
  });
  const hBoxHR = metaRight.reduce((s,l,i) => s + txtH(l, HW-12, i===0?8.5:7.5, i===0) + 1.5, 5);
  const headerH = Math.max(hBoxH, hBoxHR) + 5;

  box(X, M, W, headerH, LBD);
  vLine(X+HW, M, M+headerH, LBD);

  let ly = M + 5;
  sellerLines.forEach((line, i) => {
    if (!line) return;
    txt(line, X+5, ly, HW-10, { size:i===0?12:7.5, bold:i===0, color:BLK, lineGap:0.5 });
    ly = doc.y + (i===0?2:1);
  });

  let ry = M + 5;
  metaRight.forEach((line, i) => {
    if (!line) return;
    txt(line, RX+4, ry, HW-10, { size:i===0?8.5:7.5, bold:i===0, color:BLK, align:'right', lineGap:0.5 });
    ry = doc.y + 1;
  });

  return M + headerH;
}

// ── Standard section label row ────────────────────────────────────────────────
function drawSectionLabel(h, label, y) {
  const { fillBox, box, txt } = h;
  fillBox(X, y, W, 11, HBG);
  box(X, y, W, 11, LBD);
  txt(label, X+5, y+2, W-10, { size:7.5, bold:true, color:BLK });
  return y + 11;
}

// ── Signature block (bank left + authorized right) ────────────────────────────
function signatureLayout(h, companyName, bankLines, width = W) {
  const half = width / 2;
  const rows = bankLines.map(([label, value]) => ({
    text: label + ' ' + value,
    height: Math.max(10, h.txtH(label + ' ' + value, half - 10, 7.5) + 2),
  }));
  const nameHeight = h.txtH('For ' + (companyName || ''), half - 10, 7.5, true);
  return { rows, nameHeight, height: Math.max(rows.reduce((sum, row) => sum + row.height, 0) + 18, nameHeight + 42) };
}

function drawSignature(h, y, companyName, bankLines, options = {}) {
  const { fillBox, box, vLine, hLine, txt } = h;
  const width = options.width || W;
  const HW = width / 2;
  const RX = X + HW;
  const layout = signatureLayout(h, companyName, bankLines, width);
  const bankH = layout.height;
  if (h.checkPage) y = h.checkPage(y, bankH);

  fillBox(X, y, width, 11, HBG);
  box(X, y, width, bankH, LBD);
  vLine(X+HW, y, y+bankH, LBD);
  hLine(y+11, X, X+width, LBD);

  txt('Bank Account Details:', X+5, y+2, HW-10, { size:7.5, bold:true, color:BLK });
  txt('Authorized Signature', RX+5, y+2, HW-10, { size:7.5, bold:true, color:BLK, align:'right' });

  let bky = y + 14;
  layout.rows.forEach(row => {
    txt(row.text, X+5, bky, HW-10, { size:7.5, color:BLK });
    bky += row.height;
  });

  txt('For '+(companyName||''), RX+5, y+bankH-layout.nameHeight-13, HW-10, { size:7.5, bold:true, color:BLK, align:'right' });
  txt('Authorized Signatory',   RX+5, y+bankH-10, HW-10, { size:7.5, color:BLK, align:'right' });

  return y + bankH;
}

module.exports = {
  M, PW, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, pdfSafePart, buildPdfFilename, buildTaxSummaryLabels, createDoc, addFooters,
  roundMoney, normalizeAccountItems, deriveItemTotals,
  drawHeader, drawSectionLabel, drawSignature, signatureLayout,
  drawTextSection, drawDetailRows, drawPagedTable, splitTextToFit, confidentialityText,
  resolveUnicodeFonts, useUnicodeFonts,
};
