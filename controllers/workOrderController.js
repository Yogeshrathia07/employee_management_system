'use strict';
const { Op } = require('sequelize');
const { WorkOrder, Client, Vendor, ProjectAccount, Company } = require('../models');
const {
  applyCompanyScope,
  assertScopedRelation,
  findScopedByPk,
  syncAccountsCompanyIds,
} = require('./accountsCompanyScope');
const {
  M, PH, W, X, BLK, DRK, GRY, LGY, HBG, LBD, FOOTER_H,
  fmtDate, fmtINR, numWords, buildPdfFilename, createDoc, addFooters,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim().toUpperCase();
  return code && code !== 'AUTO-GENERATED' ? code : prefix + '-' + genCode();
}

async function resolveWorkOrderCompany(req, requestedCompanyId) {
  const actorCompanyId = Number((req.user && req.user.companyId) || 0) || null;
  if (req.user && req.user.role !== 'superadmin') {
    if (!actorCompanyId) return null;
    return Company.findByPk(actorCompanyId);
  }

  const targetCompanyId = Number(requestedCompanyId || 0) || null;
  if (!targetCompanyId) return null;
  return Company.findByPk(targetCompanyId);
}

function missingWorkOrderCompanyMessage(req) {
  return req.user && req.user.role === 'superadmin'
    ? 'Select a company'
    : 'Admin account is not associated with a company';
}

function applyCompanySnapshot(target, company) {
  if (!target || !company) return target;
  target.companyId = company.id || null;
  target.sellerName = company.name || '';
  target.sellerAddress = company.address || '';
  target.sellerPhone = company.phone || '';
  target.sellerEmail = company.email || '';
  target.sellerGstin = company.gstNo || '';
  target.sellerPan = company.panNo || '';
  target.sellerState = company.state || '';
  target.sellerStateCode = company.stateCode || '';
  target.sellerAuthorizedSignatory = company.authorizedSignatory || '';
  target.bankName = company.bankName || '';
  target.bankAcName = company.bankAcName || '';
  target.bankAccount = company.bankAccount || '';
  target.bankIfsc = company.bankIfsc || '';
  target.bankBranch = company.bankBranch || '';
  return target;
}

// ── GET /work-orders ──────────────────────────────────────────────────────────
exports.getWorkOrders = async (req, res) => {
  try {
    const { q, status, type } = req.query;
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const where = applyCompanyScope(req, {});
    if (type)   where.type = type;
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { woNumber:  { [Op.like]: `%${q}%` } },
      { partyName: { [Op.like]: `%${q}%` } },
      { projectName: { [Op.like]: `%${q}%` } },
    ];
    const rows = await WorkOrder.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Client, as: 'client', attributes: ['id','name','clientCode'], required: false },
        { model: Vendor, as: 'vendor', attributes: ['id','name','vendorCode'], required: false },
        { model: ProjectAccount, as: 'projectAccount', attributes: ['id','name','projectCode'], required: false },
        { model: Company, as: 'company', attributes: ['id','name','gstNo'], required: false },
      ],
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /work-orders/:id ──────────────────────────────────────────────────────
exports.getWorkOrder = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const wo = await findScopedByPk(WorkOrder, 'workOrder', req, req.params.id, {
      include: [
        { model: Client, as: 'client', required: false },
        { model: Vendor, as: 'vendor', required: false },
        { model: ProjectAccount, as: 'projectAccount', required: false },
        { model: Company, as: 'company', required: false },
      ],
    }, 'Work Order not found');
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });
    res.json(wo);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /work-orders ─────────────────────────────────────────────────────────
exports.createWorkOrder = async (req, res) => {
  try {
    const data = Object.assign({}, req.body);
    if (!data.type) return res.status(400).json({ message: 'Type (CWO/VWO) required' });
    if (!data.partyName && !data.clientId && !data.vendorId) {
      return res.status(400).json({ message: 'Party (client or vendor) required' });
    }
    if (data.clientId) {
      await assertScopedRelation(Client, 'client', req, data.clientId, 'Client not found');
    }
    if (data.vendorId) {
      await assertScopedRelation(Vendor, 'vendor', req, data.vendorId, 'Vendor not found');
    }
    if (data.projectAccountId) {
      await assertScopedRelation(ProjectAccount, 'projectAccount', req, data.projectAccountId, 'Project account not found');
    }
    data.woNumber = cleanGeneratedCode(data.woNumber, data.type === 'CWO' ? 'CWO' : 'VWO');
    data.createdBy = req.user.id;
    // auto-fill partyName
    if (data.type === 'CWO' && data.clientId && !data.partyName) {
      const c = await Client.findByPk(data.clientId);
      if (c) data.partyName = c.name;
    }
    if (data.type === 'VWO' && data.vendorId && !data.partyName) {
      const v = await Vendor.findByPk(data.vendorId);
      if (v) data.partyName = v.name;
    }
    const company = await resolveWorkOrderCompany(req, data.companyId);
    if (!company) return res.status(400).json({ message: missingWorkOrderCompanyMessage(req) });
    applyCompanySnapshot(data, company);
    const wo = await WorkOrder.create(data);
    res.status(201).json(wo);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /work-orders/:id ──────────────────────────────────────────────────────
exports.updateWorkOrder = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const wo = await findScopedByPk(WorkOrder, 'workOrder', req, req.params.id, null, 'Work Order not found');
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });
    const updates = Object.assign({}, req.body);
    if (updates.clientId) {
      await assertScopedRelation(Client, 'client', req, updates.clientId, 'Client not found');
    }
    if (updates.vendorId) {
      await assertScopedRelation(Vendor, 'vendor', req, updates.vendorId, 'Vendor not found');
    }
    if (updates.projectAccountId) {
      await assertScopedRelation(ProjectAccount, 'projectAccount', req, updates.projectAccountId, 'Project account not found');
    }
    const nextType = updates.type || wo.type;
    if (updates.woNumber !== undefined) {
      updates.woNumber = cleanGeneratedCode(updates.woNumber, nextType === 'CWO' ? 'CWO' : 'VWO');
    }
    if (nextType === 'CWO' && updates.clientId && !updates.partyName) {
      const client = await Client.findByPk(updates.clientId);
      if (client) updates.partyName = client.name;
    }
    if (nextType === 'VWO' && updates.vendorId && !updates.partyName) {
      const vendor = await Vendor.findByPk(updates.vendorId);
      if (vendor) updates.partyName = vendor.name;
    }
    const company = await resolveWorkOrderCompany(req, updates.companyId || wo.companyId);
    if (!company) return res.status(400).json({ message: missingWorkOrderCompanyMessage(req) });
    applyCompanySnapshot(updates, company);
    await wo.update(updates);
    res.json(wo);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /work-orders/:id/pdf ──────────────────────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const wo = await findScopedByPk(WorkOrder, 'workOrder', req, req.params.id, {
      include: [
        { model: Client, as: 'client', required: false },
        { model: Vendor, as: 'vendor', required: false },
        { model: Company, as: 'company', required: false },
      ],
    }, 'Work Order not found');
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });

    const company = wo.company || await resolveWorkOrderCompany(req, wo.companyId);
    const co = Object.assign({}, company && company.toJSON ? company.toJSON() : (company || {}), {
      name: wo.sellerName || (company && company.name) || 'DHPE',
      address: wo.sellerAddress || (company && company.address) || '',
      phone: wo.sellerPhone || (company && company.phone) || '',
      email: wo.sellerEmail || (company && company.email) || '',
      gstNo: wo.sellerGstin || (company && company.gstNo) || '',
      panNo: wo.sellerPan || (company && company.panNo) || '',
      state: wo.sellerState || (company && company.state) || '',
      stateCode: wo.sellerStateCode || (company && company.stateCode) || '',
      authorizedSignatory: wo.sellerAuthorizedSignatory || (company && company.authorizedSignatory) || '',
      bankName: wo.bankName || (company && company.bankName) || '',
      bankAcName: wo.bankAcName || (company && company.bankAcName) || '',
      bankAccount: wo.bankAccount || (company && company.bankAccount) || '',
      bankIfsc: wo.bankIfsc || (company && company.bankIfsc) || '',
      bankBranch: wo.bankBranch || (company && company.bankBranch) || '',
    });

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      (inline?'inline':'attachment') + `; filename="${buildPdfFilename([
        co.name || 'DHPE',
        wo.type === 'CWO' ? 'Client-Work-Order' : 'Vendor-Work-Order',
        wo.woNumber || wo.id,
      ])}"`);

    const { doc, hLine, vLine, box, fillBox, txt, txtH, checkPage } = createDoc();
    doc.pipe(res);

    const HW = W / 2;
    const RX = X + HW;
    const isCWO = wo.type === 'CWO';
    const party = isCWO ? (wo.client || {}) : (wo.vendor || {});
    const milestones = wo.milestones || [];

    // ── 1. HEADER ──────────────────────────────────────────────────────────────
    const sellerLines = [
      co.name || 'DHPE',
      co.address ? 'Address: '+co.address : '',
      (co.phone||co.email) ? 'Phone: '+(co.phone||'')+(co.email?' | Email: '+co.email:'') : '',
      [co.gstNo?'GSTIN: '+co.gstNo:'', co.panNo?'PAN: '+co.panNo:'', co.state?'State: '+co.state:'']
        .filter(Boolean).join(' | '),
    ].filter(Boolean);

    const docTitle = isCWO ? 'CLIENT WORK ORDER' : 'VENDOR WORK ORDER';
    const metaRight = [
      docTitle,
      'Date: '+fmtDate(wo.startDate||wo.createdAt)+'   Status: '+(wo.status||'Draft'),
      'Ref No.: '+(wo.woNumber||''),
      wo.startDate ? 'Start Date: '+fmtDate(wo.startDate) : '',
      wo.endDate   ? 'End Date: '  +fmtDate(wo.endDate)   : '',
      wo.totalAmount ? 'Contract Value: '+fmtINR(wo.totalAmount) : '',
    ].filter(Boolean);

    let hBoxH = 8;
    sellerLines.forEach((l,i) => { hBoxH += txtH(l, HW-14, i===0?12:7.5, i===0)+1.5; });
    const hBoxHR = metaRight.reduce((s,l,i) => s+txtH(l, HW-12, i===0?8.5:7.5, i===0)+1.5, 5);
    const headerH = Math.max(hBoxH, hBoxHR)+5;

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

    // ── 2. PARTY DETAILS ───────────────────────────────────────────────────────
    const partyLabel = isCWO ? 'Client Details:' : 'Vendor Details:';
    y = drawSectionLabel({ fillBox, box, txt }, partyLabel, y);

    const pLeft = [
      party.name    || wo.partyName || '',
      party.address ? 'Address: '+party.address : '',
      (party.phone||party.email)
        ? 'Phone: '+(party.phone||'')+(party.email?' | Email: '+party.email:'') : '',
    ].filter(Boolean);
    const pRight = [
      party.gstin   ? 'GSTIN: '+party.gstin : '',
      party.pan     ? 'PAN: '  +party.pan   : '',
      party.state   ? 'State: '+party.state+(party.stateCode?', Code: '+party.stateCode:'') : '',
      party.contactPerson ? 'Contact: '+party.contactPerson : '',
    ].filter(Boolean);

    let plH = 6;
    pLeft.forEach((l,i) => { plH += txtH(l, HW-12, i===0?8.5:7.5, i===0)+1.5; });
    const prH = pRight.reduce((s,l) => s+txtH(l, HW-12, 7.5)+1.5, 6);
    const partyBoxH = Math.max(plH, prH)+3;

    box(X, y, W, partyBoxH, LBD);
    vLine(X+HW, y, y+partyBoxH, LBD);
    let ply=y+4, pry=y+4;
    pLeft.forEach((line,i) => {
      if (!line) return;
      txt(line, X+5, ply, HW-10, { size:i===0?8.5:7.5, bold:i===0, color:BLK });
      ply = doc.y+0.5;
    });
    pRight.forEach(line => {
      if (!line) return;
      txt(line, RX+4, pry, HW-10, { size:7.5, color:BLK });
      pry = doc.y+0.5;
    });
    y += partyBoxH;

    // ── 3. PROJECT / SCOPE ─────────────────────────────────────────────────────
    const scopeLines = [
      wo.projectName ? 'Project: '+wo.projectName : '',
      wo.scope       ? 'Scope of Work: '+wo.scope  : '',
    ].filter(Boolean);

    if (scopeLines.length) {
      let scH = 5;
      scopeLines.forEach(l => { scH += txtH(l, W-12, 7.5)+1.5; });
      scH += 3;
      y = checkPage(y, scH);
      box(X, y, W, scH, LBD);
      let wy = y+4;
      scopeLines.forEach((line,i) => {
        txt(line, X+5, wy, W-10, { size:7.5, bold:i===0, color:BLK });
        wy = doc.y+0.5;
      });
      y += scH;
    }

    // ── 4. MILESTONES TABLE (if any) ───────────────────────────────────────────
    if (milestones.length) {
      // Sl(20) | Milestone(265) | Due Date(90) | Amount(90) | Status(90) = 555
      const MC = { sl:20, title:265, due:90, amt:90, st:90 };
      y = checkPage(y, 26);
      y = drawSectionLabel({ fillBox, box, txt }, 'Milestones', y);

      const MRH = 14;
      fillBox(X, y, W, MRH, HBG);
      box(X, y, W, MRH, LBD);
      let mcx = X;
      function mth(label, w) {
        vLine(mcx, y, y+MRH, LBD);
        txt(label, mcx+2, y+3, w-4, { size:6.5, bold:true, color:BLK, align:'center' });
        mcx += w;
      }
      mth('Sl.', MC.sl); mth('Milestone', MC.title);
      mth('Due Date', MC.due); mth('Amount (Rs.)', MC.amt); mth('Status', MC.st);
      y += MRH;

      milestones.forEach((ms, idx) => {
        y = checkPage(y, MRH+1);
        if (idx%2===0) fillBox(X, y, W, MRH, '#fafafa');
        box(X, y, W, MRH, LBD);
        let mcx2 = X;
        function mtd(text, w, opts) {
          vLine(mcx2, y, y+MRH, LBD);
          const to = Object.assign({ size:7.5, align:'center', lineGap:0.5 }, opts||{});
          const ty = y+(MRH-(to.size+2))/2+1;
          txt(String(text), mcx2+3, ty, w-6, to);
          mcx2 += w;
        }
        mtd(idx+1,                   MC.sl);
        mtd(ms.title||ms.name||'',   MC.title, { align:'left' });
        mtd(fmtDate(ms.dueDate||ms.due), MC.due);
        mtd(ms.amount ? fmtINR(ms.amount) : '—', MC.amt, { align:'right' });
        mtd(ms.status||'Pending',    MC.st);
        y += MRH;
      });
    }

    // ── 5. NOTES + SIGNATURE ───────────────────────────────────────────────────
    y = checkPage(y, 32);
    box(X, y, W, 9+7, LBD);
    txt('This is a computer-generated Work Order.', X+5, y+4, W-10, { size:7, color:GRY });
    y += 9+7;

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

// ── DELETE /work-orders/:id ───────────────────────────────────────────────────
exports.deleteWorkOrder = async (req, res) => {
  try {
    if (req.user.role === 'admin') await syncAccountsCompanyIds();
    const wo = await findScopedByPk(WorkOrder, 'workOrder', req, req.params.id, null, 'Work Order not found');
    if (!wo) return res.status(404).json({ message: 'Work Order not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin(wo.type === 'CWO' ? 'client_work_order' : 'vendor_work_order',
      wo.id, req.user, wo.toJSON(), wo.woNumber);
    await wo.destroy();
    res.json({ message: 'Work Order deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
