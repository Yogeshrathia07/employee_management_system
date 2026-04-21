'use strict';
const PDFDocument = require('pdfkit');

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
const FOOTER_H = 22;

const CONF_TEXT =
  'Note: This document is the property of DHPE and is confidential. It must not be disclosed, ' +
  'shared, or transmitted to any person or firm not authorized by us. No part of this ' +
  'document may be copied, reproduced, or used in whole or in part without our prior written consent.';

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
       .text(String(text||''), x, y, {
         width:w, align:opts.align||'left',
         lineGap:opts.lineGap!==undefined?opts.lineGap:0.5,
         ellipsis:false,
       });
  }
  function txtH(text, w, size, bold) {
    doc.fontSize(size||8).font(bold?'Helvetica-Bold':'Helvetica');
    return doc.heightOfString(String(text||''), { width:w, lineGap:0.5 });
  }
  function checkPage(y, needed) {
    if (y + needed > PH - M - FOOTER_H) { doc.addPage(); return M; }
    return y;
  }

  return { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage };
}

function addFooters(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  if (!total) return;
  doc.switchToPage(range.start + total - 1);
  const fy = PH - M - FOOTER_H + 2;
  doc.moveTo(X, fy).lineTo(X + W, fy).lineWidth(0.3).strokeColor('#aaaaaa').stroke();
  doc.fontSize(5.5).font('Helvetica').fillColor(LGY)
     .text(CONF_TEXT, X, fy + 4, { width: W, align: 'left', lineGap: 0.5 });
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
function drawSignature(h, y, companyName, bankLines) {
  const { fillBox, box, vLine, hLine, txt } = h;
  const HW = W / 2;
  const RX = X + HW;
  const bankH = bankLines.length * 10 + 17;

  fillBox(X, y, W, 11, HBG);
  box(X, y, W, bankH, LBD);
  vLine(X+HW, y, y+bankH, LBD);
  hLine(y+11, X, X+W, LBD);

  txt('Bank Account Details:', X+5, y+2, HW-10, { size:7.5, bold:true, color:BLK });
  txt('Authorized Signature', RX+5, y+2, HW-10, { size:7.5, bold:true, color:BLK, align:'right' });

  let bky = y + 14;
  bankLines.forEach(([label, val]) => {
    txt(label+' '+val, X+5, bky, HW-10, { size:7.5, color:BLK });
    bky += 10;
  });

  txt('For '+(companyName||''), RX+5, y+bankH-19, HW-10, { size:7.5, bold:true, color:BLK, align:'right' });
  txt('Authorized Signatory',   RX+5, y+bankH-10, HW-10, { size:7.5, color:BLK, align:'right' });

  return y + bankH;
}

module.exports = {
  M, PW, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, createDoc, addFooters,
  drawHeader, drawSectionLabel, drawSignature,
};
