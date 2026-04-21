'use strict';
const PDFDocument = require('pdfkit');

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
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function toWords(num) {
    if (num === 0) return '';
    if (num < 20)      return ones[num] + ' ';
    if (num < 100)     return tens[Math.floor(num/10)] + (num%10 ? ' '+ones[num%10] : '') + ' ';
    if (num < 1000)    return ones[Math.floor(num/100)] + ' Hundred ' + toWords(num%100);
    if (num < 100000)  return toWords(Math.floor(num/1000)) + 'Thousand ' + toWords(num%1000);
    if (num < 10000000) return toWords(Math.floor(num/100000)) + 'Lakh ' + toWords(num%100000);
    return toWords(Math.floor(num/10000000)) + 'Crore ' + toWords(num%10000000);
  }
  const intPart = Math.floor(Math.abs(n));
  const decPart = Math.round((Math.abs(n) - intPart) * 100);
  let result = toWords(intPart).trim() + ' Rupees';
  if (decPart > 0) result += ' and ' + toWords(decPart).trim() + ' Paise';
  return 'Rupees ' + result + '.';
}

// POST /api/proformas/pdf  — accepts full proforma object in body
exports.generatePDF = async (req, res) => {
  try {
    const inv = req.body;
    if (!inv || !inv.customerName) return res.status(400).json({ message: 'Proforma data required' });

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
    const useIGST=inv.sellerStateCode&&inv.customerStateCode&&inv.sellerStateCode!==inv.customerStateCode;
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
      'Date: '+fmtDate(inv.date)+'   Status: '+(inv.status||'Draft'),
      inv.billMonth?'Bill for Month: '+inv.billMonth:'',
      (inv.billPeriodFrom&&inv.billPeriodTo)?'Bill Period: '+fmtDate(inv.billPeriodFrom)+' to '+fmtDate(inv.billPeriodTo):'',
      'Ref No.: '+(inv.id||''),
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
      let woH=8; woLines.forEach(l=>{ woH+=txtH(l,W-14,7.5,false)+2; }); woH+=4;
      y=checkPage(y,woH); box(X,y,W,woH,LBD);
      let wy=y+5;
      woLines.forEach((line,i)=>{ txt(line,X+6,wy,W-12,{size:7.5,bold:i===0,color:BLK}); wy=doc.y+1; });
      y+=woH;
    }

    // ── 4. ITEMS TABLE ────────────────────────────────────────────────────────
    const COL=useIGST
      ?{sl:18,code:38,desc:260,hsn:40,unit:28,rate:52,qty:34,amt:105}
      :{sl:16,code:32,desc:217,hsn:36,unit:26,rate:42,qty:30,cgstP:26,cgst:34,sgstP:26,sgst:34};

    y=checkPage(y,30);
    fillBox(X,y,W,14,HBG); box(X,y,W,14,LBD);
    txt('Item Details',X+6,y+3,W-12,{size:8,bold:true,color:BLK});
    y+=14;

    const ROW_H=18;
    fillBox(X,y,W,ROW_H,HBG); box(X,y,W,ROW_H,LBD);

    (function drawHdr(y){
      let cx=X;
      const th=(label,w)=>{ vLine(cx,y,y+ROW_H,LBD); txt(label,cx+2,y+4,w-4,{size:7,bold:true,color:BLK,align:'center'}); cx+=w; };
      if(useIGST){
        th('Sl.',COL.sl);th('Item Code',COL.code);th('Description',COL.desc);
        th('HSN/SAC',COL.hsn);th('Unit',COL.unit);th('Rate (₹)',COL.rate);th('Qty',COL.qty);th('Amount (₹)',COL.amt);
      } else {
        th('Sl.',COL.sl);th('Item Code',COL.code);th('Description',COL.desc);
        th('HSN/SAC',COL.hsn);th('Unit',COL.unit);th('Rate (₹)',COL.rate);th('Qty',COL.qty);
        th('CGST%',COL.cgstP);th('CGST',COL.cgst);th('SGST%',COL.sgstP);th('SGST',COL.sgst);
        const amtW=W-(COL.sl+COL.code+COL.desc+COL.hsn+COL.unit+COL.rate+COL.qty+COL.cgstP+COL.cgst+COL.sgstP+COL.sgst);
        vLine(cx,y,y+ROW_H,LBD); txt('Amount (₹)',cx+2,y+4,amtW-4,{size:7,bold:true,color:BLK,align:'center'});
      }
    })(y);
    y+=ROW_H;

    items.forEach((it,idx)=>{
      const qty=parseFloat(it.quantity||0),price=parseFloat(it.unitPrice||0),disc=parseFloat(it.discount||0),taxRate=parseFloat(it.taxRate||0);
      const taxable=parseFloat(it.taxableAmount||(qty*price*(1-disc/100)));
      const igst=parseFloat(it.igst||(taxable*taxRate/100));
      const cgst=parseFloat(it.cgst||(igst/2));
      const total=parseFloat(it.itemTotal||(taxable+igst));
      const itemCode=it.itemCode||'N/A';
      const descH=txtH(it.name||'',COL.desc-6,7.5,false);
      const rowH=Math.max(descH+8,18);

      y=checkPage(y,rowH+2);
      if(idx%2===0) fillBox(X,y,W,rowH,'#fafafa');
      box(X,y,W,rowH,LBD);

      let cx=X;
      const td=(text,w,opts)=>{ vLine(cx,y,y+rowH,LBD); txt(text,cx+2,y+3,w-4,Object.assign({size:7.5,align:'center',lineGap:0.5},opts||{})); cx+=w; };
      const tdDesc=(text,w)=>{ vLine(cx,y,y+rowH,LBD); txt(text,cx+3,y+3,w-6,{size:7.5,align:'left',lineGap:1}); cx+=w; };

      if(useIGST){
        td(idx+1,COL.sl);td(itemCode,COL.code);tdDesc(it.name||'',COL.desc);
        td(it.hsnCode||'',COL.hsn);td(it.unit||'',COL.unit);
        td(price.toFixed(2),COL.rate,{align:'right'});td(qty%1===0?qty:qty.toFixed(3),COL.qty);
        td(total.toFixed(2),COL.amt,{align:'right',bold:true});
      } else {
        td(idx+1,COL.sl);td(itemCode,COL.code);tdDesc(it.name||'',COL.desc);
        td(it.hsnCode||'',COL.hsn);td(it.unit||'',COL.unit);
        td(price.toFixed(2),COL.rate,{align:'right'});td(qty%1===0?qty:qty.toFixed(3),COL.qty);
        td((taxRate/2).toFixed(0)+'%',COL.cgstP);td(cgst.toFixed(2),COL.cgst,{align:'right'});
        td((taxRate/2).toFixed(0)+'%',COL.sgstP);td(cgst.toFixed(2),COL.sgst,{align:'right'});
        const amtW=W-(COL.sl+COL.code+COL.desc+COL.hsn+COL.unit+COL.rate+COL.qty+COL.cgstP+COL.cgst+COL.sgstP+COL.sgst);
        vLine(cx,y,y+rowH,LBD);
        txt(total.toFixed(2),cx+2,y+3,amtW-4,{size:7.5,align:'right',bold:true,lineGap:0.5});
      }
      y+=rowH;
    });

    // ── 5. AMOUNT IN WORDS + SUMMARY ─────────────────────────────────────────
    y=checkPage(y,60);
    const sumLines=[
      ['Subtotal:',fmtINR(inv.subtotal)],
      ...(useIGST?[['IGST:',fmtINR(inv.totalIgst)]]:[['SGST:',fmtINR(inv.totalSgst)],['CGST:',fmtINR(inv.totalCgst)]]),
      ...(parseFloat(inv.roundOff)?[['Round Off:',fmtINR(inv.roundOff)]]:[]),
    ];
    const sumRowH=14,sumTotalH=18,sumH=sumLines.length*sumRowH+sumTotalH;
    const wordText=numWords(parseFloat(inv.totalAmount||0));
    const wordH=txtH(wordText,HW-16,8,false);
    const botH=Math.max(sumH+4,wordH+28);

    box(X,y,HW,botH,LBD); box(X+HW,y,HW,botH,LBD);
    txt('Amount in Words (This Bill):',X+6,y+5,HW-12,{size:7.5,bold:true,color:BLK});
    txt(wordText,X+6,y+18,HW-12,{size:8,color:BLK});

    let sy=y+4;
    sumLines.forEach(([label,val])=>{ hLine(sy,X+HW,X+W,LBD); txt(label,X+HW+4,sy+3,HW/2-6,{size:8,color:BLK}); txt(val,X+HW+HW/2,sy+3,HW/2-6,{size:8,align:'right',color:BLK}); sy+=sumRowH; });
    fillBox(X+HW,sy,HW,sumTotalH,HBG);
    txt('Total Amount:',X+HW+4,sy+4,HW/2-6,{size:9,bold:true,color:BLK});
    txt(fmtINR(inv.totalAmount),X+HW+HW/2,sy+4,HW/2-6,{size:9,bold:true,color:BLK,align:'right'});
    y+=botH;

    // ── 6. PAYMENT TERMS ─────────────────────────────────────────────────────
    const ptLines=[inv.paymentTerms?'Payment Terms: '+inv.paymentTerms:'',inv.deliveryTimeline?'Delivery: '+inv.deliveryTimeline:''].filter(Boolean);
    if(ptLines.length){
      y=checkPage(y,40);
      let ptH=8; ptLines.forEach(l=>{ ptH+=txtH(l,W-14,7.5,false)+2; }); ptH+=4+14;
      box(X,y,W,ptH,LBD); fillBox(X,y,W,14,HBG); hLine(y+14,X,X+W,LBD);
      txt('Payment Terms & Delivery',X+6,y+3,W-12,{size:8,bold:true,color:BLK});
      let pty=y+18;
      ptLines.forEach(l=>{ txt(l,X+6,pty,W-12,{size:7.5,color:BLK}); pty+=12; });
      y+=ptH;
    }

    // ── 7. BANK + SIGNATURE ───────────────────────────────────────────────────
    y=checkPage(y,70);
    const bankLines=[['Bank:',inv.bankName||'N/A'],['A/c Name:',inv.bankAcName||'N/A'],['A/c No.:',inv.bankAccount||'N/A'],['IFSC:',inv.bankIfsc||'N/A'],['Branch:',inv.bankBranch||'N/A']];
    const bankH=bankLines.length*12+20;
    box(X,y,HW,bankH,LBD); fillBox(X,y,HW,14,HBG); hLine(y+14,X,X+HW,LBD);
    txt('Bank Account Details:',X+6,y+3,HW-12,{size:8,bold:true,color:BLK});
    let bky=y+18;
    bankLines.forEach(([label,val])=>{ txt(label+' '+val,X+6,bky,HW-12,{size:7.5,color:BLK}); bky+=12; });
    box(X+HW,y,HW,bankH,LBD);
    txt('For '+(inv.sellerName||''),X+HW+4,y+bankH-30,HW-10,{size:8,bold:true,color:BLK,align:'right'});
    txt('Authorized Signatory',X+HW+4,y+bankH-16,HW-10,{size:8,color:BLK,align:'right'});
    y+=bankH;

    // ── 8. FOOTER ─────────────────────────────────────────────────────────────
    y=checkPage(y,32);
    const footLines=[inv.termsConditions||'','Note: This is a Proforma Invoice only. Not a Tax Invoice — no legal payment obligation is created.'].filter(Boolean);
    box(X,y,W,footLines.length*11+10,LBD);
    let ny=y+5;
    footLines.forEach(line=>{ txt(line,X+6,ny,W-12,{size:7,color:GRY}); ny+=11; });

    const CONF_TEXT =
      'Note: This document is the property of DHPE and is confidential. It must not be disclosed, ' +
      'shared, or transmitted to any person or firm not authorized by us. No part of this ' +
      'document may be copied, reproduced, or used in whole or in part without our prior written consent.';
    const pageRange = doc.bufferedPageRange();
    const totalPages = pageRange.count;
    if (totalPages) {
      doc.switchToPage(pageRange.start + totalPages - 1);
      const fy = PH - M - 20;
      doc.moveTo(X, fy).lineTo(X + W, fy).lineWidth(0.3).strokeColor('#aaaaaa').stroke();
      doc.fontSize(5.5).font('Helvetica').fillColor('#888888')
        .text(CONF_TEXT, X, fy + 4, { width: W, align: 'left', lineGap: 0.5 });
    }

    doc.end();
  } catch(err) {
    if(!res.headersSent) res.status(500).json({ message: err.message });
  }
};
