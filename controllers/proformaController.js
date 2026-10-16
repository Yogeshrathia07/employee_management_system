'use strict';
const PDFDocument = require('pdfkit');
const { applySellerCompanySnapshot, getRequestCompany } = require('./accountsCompanyScope');
const {
  buildTaxSummaryLabels, addFooters, drawSignature, drawTextSection, drawPagedTable, drawLineBlock, numWords, serialColumnWidth,
} = require('./pdfHelper');

function fmtINR(n) {
  return 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
}
function cellMoney(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// POST /api/proformas/pdf  — accepts full proforma object in body
function shouldShowItemTaxColumns(record) {
  if (!record) return true;
  if (record.showTaxPercentInPdf === false) return false;
  if (record.showTaxPercentInPdf === true) return true;
  return record.showTaxInPdf !== false;
}
function normalizedStateCode(code, gstin) {
  const raw = String(code || '').trim();
  if (raw) return raw.length === 1 ? '0' + raw : raw;
  const match = String(gstin || '').trim().match(/^(\d{2})/);
  return match ? match[1] : '';
}
function taxModeFromRecord(record) {
  const totalIgst = Number(record && record.totalIgst || 0);
  const totalCgst = Number(record && record.totalCgst || 0);
  const totalSgst = Number(record && record.totalSgst || 0);
  if (totalIgst > 0.004 && totalCgst <= 0.004 && totalSgst <= 0.004) return 'igst';
  if (totalCgst > 0.004 || totalSgst > 0.004) return 'split';
  const items = Array.isArray(record && record.items) ? record.items : [];
  if (items.some(it => Number(it && it.igst || 0) > 0.004)) return 'igst';
  if (items.some(it => Number(it && it.cgst || 0) > 0.004 || Number(it && it.sgst || 0) > 0.004)) return 'split';
  const sellerStateCode = normalizedStateCode(record && record.sellerStateCode, record && record.sellerGstin);
  const customerStateCode = normalizedStateCode(record && record.customerStateCode, record && record.customerGstin);
  if (sellerStateCode && customerStateCode && sellerStateCode !== customerStateCode) return 'igst';
  return 'split';
}

exports.generatePDF = async (req, res) => {
  try {
    const inv = Object.assign({}, req.body);
    if (!inv || !inv.customerName) return res.status(400).json({ message: 'Proforma data required' });
    if (req.user && req.user.role === 'admin') {
      const company = await getRequestCompany(req);
      if (!company) return res.status(400).json({ message: 'Admin company not found' });
      applySellerCompanySnapshot(inv, company);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Proforma-${inv.id||'PRO'}.pdf"`);

    const doc = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true });
    doc.pipe(res);

    const M=10, PW=595, PH=842, W=PW-M*2, X=M;
    const BLK='#000000', DRK='#1a1a1a', GRY='#555555', HBG='#f2f2f2', LBD=0.4, HBD=1.0;

    const hLine = (y,x1,x2,lw)=>{ doc.moveTo(x1!==undefined?x1:X,y).lineTo(x2!==undefined?x2:X+W,y).lineWidth(lw||LBD).strokeColor(BLK).stroke(); };
    const vLine = (x,y1,y2,lw)=>{ doc.moveTo(x,y1).lineTo(x,y2).lineWidth(lw||LBD).strokeColor(BLK).stroke(); };
    const box   = (x,y,w,h,lw)=>{ doc.rect(x,y,w,h).lineWidth(lw||LBD).strokeColor(BLK).stroke(); };
    const fillBox=(x,y,w,h,fill)=>{ doc.rect(x,y,w,h).fillColor(fill).fill(); };
    function txt(text,x,y,w,opts){
      opts=opts||{};
      doc.fontSize(opts.size||8).font(opts.bold?'Helvetica-Bold':'Helvetica').fillColor(opts.color||DRK)
         .text(String(text||''),x,y,{width:w,align:opts.align||'left',lineGap:opts.lineGap!==undefined?opts.lineGap:0.5,ellipsis:false});
    }
    function txtH(text,w,size,bold){
      doc.fontSize(size||8).font(bold?'Helvetica-Bold':'Helvetica');
      return doc.heightOfString(String(text||''),{width:w,lineGap:0.5});
    }
    function checkPage(y,needed){ if(y+needed>PH-M-24){ doc.addPage(); return M; } return y; }

    let y=M;
    const items=inv.items||[];
    const useIGST=taxModeFromRecord(inv)==='igst';
    const showItemTaxColumns = shouldShowItemTaxColumns(inv);
    const HW=W/2, RX=X+HW;

    // ── 1. HEADER ─────────────────────────────────────────────────────────────
    const compLines=[
      inv.sellerName||'',
      inv.sellerAddress?'Address: '+inv.sellerAddress:'',
      (inv.sellerPhone||inv.sellerEmail)?'Phone: '+(inv.sellerPhone||'')+(inv.sellerEmail?' | Email: '+inv.sellerEmail:''):'',
      [inv.sellerGstin?'GSTIN: '+inv.sellerGstin:'',inv.sellerPan?'PAN: '+inv.sellerPan:'',
       inv.sellerState?'State: '+inv.sellerState+(inv.sellerStateCode?', Code: '+inv.sellerStateCode:''):''].filter(Boolean).join(' | '),
    ].filter(Boolean);

    const metaRight=[
      'PROFORMA INVOICE',
      'Ref No.: '+(inv.id||''),
      'Date: '+fmtDate(inv.date)+'   Status: '+(inv.status||'Draft'),
      inv.billMonth?'Bill for Month: '+inv.billMonth:'',
      (inv.billPeriodFrom&&inv.billPeriodTo)?'Bill Period: '+fmtDate(inv.billPeriodFrom)+' to '+fmtDate(inv.billPeriodTo):'',
      inv.validityDate?'Valid Till: '+fmtDate(inv.validityDate):'',
    ].filter(Boolean);

    let hBoxH=16;
    compLines.forEach((l,i)=>{ hBoxH+=txtH(l,HW-16,i===0?13:7.5,i===0)+2; });
    const hBoxHR=metaRight.reduce((s,l,i)=>s+txtH(l,HW-12,i===0?9:7.5,i===0)+2,8);
    const headerH=Math.max(hBoxH,hBoxHR)+8;

    box(X,y,W,headerH,HBD);
    vLine(X+HW,y,y+headerH,LBD);

    let ly=y+6;
    compLines.forEach((line,i)=>{ if(!line)return; txt(line,X+6,ly,HW-12,{size:i===0?13:7.5,bold:i===0,color:BLK,lineGap:1}); ly=doc.y+(i===0?3:1); });
    let ry=y+6;
    metaRight.forEach((line,i)=>{ if(!line)return; txt(line,RX+4,ry,HW-10,{size:i===0?9:7.5,bold:i===0,color:BLK,align:'right',lineGap:1}); ry=doc.y+1; });
    y+=headerH;

    // ── 2. BILL TO ────────────────────────────────────────────────────────────
    fillBox(X,y,W,14,HBG); box(X,y,W,14,LBD);
    txt('Bill To:',X+6,y+3,W-12,{size:8,bold:true,color:BLK});
    y+=14;

    const custLeft=[inv.customerName||'',inv.customerAddress||''].filter(Boolean);
    const custRight=[
      inv.customerGstin?'GSTIN: '+inv.customerGstin+(inv.customerPan?' | PAN: '+inv.customerPan:''):'',
      inv.customerEmail?'Email: '+inv.customerEmail:'',
      inv.customerState?'State: '+inv.customerState+(inv.customerStateCode?', Code: '+inv.customerStateCode:''):'',
    ].filter(Boolean);

    let billH=10;
    custLeft.forEach((l,i)=>{ billH+=txtH(l,HW-14,i===0?9:7.5,i===0)+2; });
    const billHR=custRight.reduce((s,l)=>s+txtH(l,HW-14,7.5,false)+2,10);
    const billBoxH=Math.max(billH,billHR)+4;

    box(X,y,W,billBoxH,LBD); vLine(X+HW,y,y+billBoxH,LBD);
    let by2=y+5,bry=y+5;
    custLeft.forEach((line,i)=>{ if(!line)return; txt(line,X+6,by2,HW-14,{size:i===0?9:7.5,bold:i===0,color:BLK}); by2=doc.y+1; });
    custRight.forEach(line=>{ if(!line)return; txt(line,RX+4,bry,HW-10,{size:7.5,color:BLK}); bry=doc.y+1; });
    y+=billBoxH;

    // ── 3. WORK ORDER (optional) ──────────────────────────────────────────────
    if(inv.workOrder||inv.projectName||inv.workDetails){
      const woLines=[
        inv.workOrder?'Work Order: '+inv.workOrder:'',
        inv.projectName?'Project Name: '+inv.projectName:'',
        inv.workDetails?'Work Details: '+inv.workDetails:'',
      ].filter(Boolean);
      y = drawLineBlock({ doc, txt, txtH, box, checkPage },
        woLines.map((text, i) => ({ text, bold: i === 0 })), y, { padX: 6 });
    }

    // ── 4. ITEMS TABLE ────────────────────────────────────────────────────────
    const slW = serialColumnWidth({ doc }, items.length);
    // Unit and Qty are wide enough for values such as "Running Metre" and "12345.678".
    const columns = [
      { label: 'Sl.', width: slW }, { label: 'Code', width: 32 },
      { label: 'Description', width: (showItemTaxColumns ? 197 : 284) - (slW - 18), align: 'left' },
      { label: 'HSN/SAC', width: 36, fit: true }, { label: 'Unit', width: 34 },
      { label: 'Rate', width: 50, align: 'right', fit: true }, { label: 'Qty', width: 36, fit: true },
      ...(showItemTaxColumns ? [
        { label: 'Tax %', width: 32, fit: true },
        { label: useIGST ? 'IGST Amt' : 'Tax Amt', width: 55, align: 'right', fit: true },
      ] : []),
      { label: 'Amount', width: 85, align: 'right', bold: true, fit: true },
    ];
    const itemRows = items.map((item, index) => {
      const qty = Number(item.quantity ?? item.qty ?? 0);
      const price = Number(item.unitPrice ?? item.rate ?? 0);
      const taxRate = Number(item.taxRate || 0);
      const taxable = Number(item.taxableAmount ?? qty * price * (1 - Number(item.discount || 0) / 100));
      const tax = useIGST ? Number(item.igst ?? taxable * taxRate / 100)
        : Number(item.cgst ?? taxable * taxRate / 200) + Number(item.sgst ?? taxable * taxRate / 200);
      return [index + 1, item.itemCode || 'N/A', item.name || item.description || '',
        item.hsnCode || '', item.unit || '', cellMoney(price), qty,
        ...(showItemTaxColumns ? [taxRate + '%', cellMoney(tax)] : []), cellMoney(taxable)];
    });
    y = drawPagedTable({ doc, box, fillBox, vLine, txt, txtH, checkPage }, columns, itemRows, y);

    // ── 5. AMOUNT IN WORDS + SUMMARY ─────────────────────────────────────────
    y=checkPage(y,60);
    const taxLabels = buildTaxSummaryLabels(inv, useIGST ? 'igst' : 'split');
    const sumLines=[
      ['Subtotal:',fmtINR(inv.subtotal)],
      ...(useIGST?[[taxLabels.igst + ':',fmtINR(inv.totalIgst)]]:[[taxLabels.sgst + ':',fmtINR(inv.totalSgst)],[taxLabels.cgst + ':',fmtINR(inv.totalCgst)]]),
      ...(parseFloat(inv.roundOff)?[['Round Off:',fmtINR(inv.roundOff)]]:[]),
    ];
    const sumRowH=14,sumTotalH=18;
    // Rows grow when a mixed-rate label such as "CGST @ 0.05%, 0.13%, ..." wraps.
    const sumRowHeights=sumLines.map(([label,val])=>Math.max(sumRowH,txtH(label,HW/2-6,8)+5,txtH(val,HW/2-6,8)+5));
    const sumH=sumRowHeights.reduce((sum,height)=>sum+height,0)+sumTotalH;
    const wordText=numWords(parseFloat(inv.totalAmount||0));
    const wordH=txtH(wordText,HW-16,8,false);
    const botH=Math.max(sumH,wordH+28);
    y = checkPage(y, botH);

    const totalY=y+botH-sumTotalH;
    fillBox(X+HW,totalY,HW,sumTotalH,HBG);
    box(X,y,HW,botH,LBD); box(X+HW,y,HW,botH,LBD);
    txt('Amount in Words (This Bill):',X+6,y+5,HW-12,{size:7.5,bold:true,color:BLK});
    txt(wordText,X+6,y+18,HW-12,{size:8,color:BLK});

    let sy=y;
    sumLines.forEach(([label,val],i)=>{
      txt(label,X+HW+4,sy+3,HW/2-6,{size:8,color:BLK});
      txt(val,X+HW+HW/2,sy+3,HW/2-6,{size:8,align:'right',color:BLK});
      sy+=sumRowHeights[i];
      if (i<sumLines.length-1) hLine(sy,X+HW,X+W,LBD);
    });
    hLine(totalY,X+HW,X+W,LBD);
    txt('Total Amount:',X+HW+4,totalY+4,HW/2-6,{size:9,bold:true,color:BLK});
    txt(fmtINR(inv.totalAmount),X+HW+HW/2,totalY+4,HW/2-6,{size:9,bold:true,color:BLK,align:'right'});
    y+=botH;

    // ── 6. PAYMENT TERMS ─────────────────────────────────────────────────────
    const ptLines=[inv.paymentTerms?'Payment Terms: '+inv.paymentTerms:'',inv.deliveryTimeline?'Delivery: '+inv.deliveryTimeline:''].filter(Boolean);
    const sectionHelpers = { doc, box, fillBox, txt, txtH, checkPage };
    y = drawTextSection(sectionHelpers, 'Payment Terms & Delivery', ptLines.join('\n'), y, { color: BLK });

    // ── 7. BANK + SIGNATURE ───────────────────────────────────────────────────
    const bankLines=[['Bank:',inv.bankName||'N/A'],['A/c Name:',inv.bankAcName||'N/A'],['A/c No.:',inv.bankAccount||'N/A'],['IFSC:',inv.bankIfsc||'N/A'],['Branch:',inv.bankBranch||'N/A']];
    y = drawSignature({ ...sectionHelpers, vLine, hLine }, y, inv.sellerName, bankLines);

    // ── 8. FOOTER ─────────────────────────────────────────────────────────────
    const footLines=[
      String(inv.notes || '').trim() ? 'Remarks: ' + String(inv.notes).trim() : '',
      String(inv.termsConditions || '').trim() ? 'Terms & Conditions: ' + String(inv.termsConditions).trim() : '',
    ].filter(Boolean);
    y = drawTextSection(sectionHelpers, 'Additional Information', footLines.join('\n'), y, { size: 7 });
    addFooters(doc, { companyName: inv.sellerName, infoText: 'This is a computer-generated proforma invoice, not a tax invoice.' });

    doc.end();
  } catch(err) {
    if(!res.headersSent) res.status(500).json({ message: err.message });
  }
};
