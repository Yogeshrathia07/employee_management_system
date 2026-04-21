'use strict';
const { Op } = require('sequelize');
const { ProjectAccount, PurchaseOrder, Invoice, WorkOrder, Client, Company } = require('../models');
const {
  M, W, X, BLK, GRY, HBG, LBD,
  fmtDate, fmtINR, createDoc, addFooters,
  drawSectionLabel, drawSignature,
} = require('./pdfHelper');

function genCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }
function cleanGeneratedCode(value, prefix) {
  const code = String(value || '').trim().toUpperCase();
  return code && code !== 'AUTO-GENERATED' ? code : prefix + '-' + genCode();
}

// ── GET /project-accounts ─────────────────────────────────────────────────────
exports.getProjectAccounts = async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) where[Op.or] = [
      { name:        { [Op.like]: `%${q}%` } },
      { projectCode: { [Op.like]: `%${q}%` } },
      { clientName:  { [Op.like]: `%${q}%` } },
    ];
    const rows = await ProjectAccount.findAll({ where, order: [['createdAt','DESC']],
      include: [
        { model: Client, as: 'client', attributes: ['id','name','clientCode'], required: false },
        { model: PurchaseOrder, as: 'purchaseOrders', attributes: ['id','totalAmount'] },
        { model: Invoice, as: 'invoices', attributes: ['id','totalAmount'] },
      ],
    });
    // compute spent for each project
    const result = rows.map(r => {
      const plain = r.toJSON();
      const poSpent = (plain.purchaseOrders || []).reduce((s, po) => s + parseFloat(po.totalAmount || 0), 0);
      const invBilled = (plain.invoices || []).reduce((s, inv) => s + parseFloat(inv.totalAmount || 0), 0);
      plain.spent = poSpent;
      plain.billed = invBilled;
      plain.remaining = parseFloat(plain.budget || 0) - poSpent;
      return plain;
    });
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /project-accounts/:id ─────────────────────────────────────────────────
exports.getProjectAccount = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id, {
      include: [
        { model: Client, as: 'client', required: false },
        { model: PurchaseOrder, as: 'purchaseOrders' },
        { model: Invoice, as: 'invoices' },
        { model: WorkOrder, as: 'workOrders' },
      ],
    });
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });
    const plain = pa.toJSON();
    plain.spent = (plain.purchaseOrders || []).reduce((s, po) => s + parseFloat(po.totalAmount || 0), 0);
    plain.billed = (plain.invoices || []).reduce((s, inv) => s + parseFloat(inv.totalAmount || 0), 0);
    plain.remaining = parseFloat(plain.budget || 0) - plain.spent;
    res.json(plain);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /project-accounts/:id/pdf ─────────────────────────────────────────────
exports.generatePDF = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id, {
      include: [
        { model: Client, as: 'client', required: false },
        { model: PurchaseOrder, as: 'purchaseOrders' },
        { model: Invoice, as: 'invoices' },
        { model: WorkOrder, as: 'workOrders' },
      ],
    });
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });

    const company = req.user.companyId ? await Company.findByPk(req.user.companyId) : null;
    const plain = pa.toJSON();
    const spent = (plain.purchaseOrders || []).reduce((sum, po) => sum + parseFloat(po.totalAmount || 0), 0);
    const billed = (plain.invoices || []).reduce((sum, inv) => sum + parseFloat(inv.totalAmount || 0), 0);
    const budget = parseFloat(plain.budget || 0);
    const remaining = budget - spent;
    const co = company || {};

    const inline = req.query.view === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename="Project-${pa.projectCode || pa.id}.pdf"`
    );

    const { doc, hLine, vLine, box, fillBox, txt, checkPage } = createDoc();
    doc.pipe(res);

    const HW = W / 2;
    const RX = X + HW;
    const headerH = 56;
    box(X, M, W, headerH, LBD);
    vLine(X + HW, M, M + headerH, LBD);
    txt(co.name || 'DHPE', X + 5, M + 6, HW - 10, { size: 12, bold: true, color: BLK });
    txt(co.address || '', X + 5, M + 22, HW - 10, { size: 7.5, color: BLK });
    txt((co.phone || co.email) ? 'Phone: ' + (co.phone || '') + (co.email ? ' | Email: ' + co.email : '') : '', X + 5, M + 38, HW - 10, { size: 7.5, color: BLK });
    txt('PROJECT ACCOUNT', RX + 4, M + 6, HW - 10, { size: 9, bold: true, align: 'right', color: BLK });
    txt('Ref No.: ' + (pa.projectCode || pa.id), RX + 4, M + 22, HW - 10, { size: 7.5, align: 'right', color: BLK });
    txt('Status: ' + (pa.status || 'Planning'), RX + 4, M + 34, HW - 10, { size: 7.5, align: 'right', color: BLK });

    let y = M + headerH;
    y = drawSectionLabel({ fillBox, box, txt }, 'Project Details', y);
    const details = [
      ['Project Name', pa.name],
      ['Client', pa.clientName || (pa.client && pa.client.name) || ''],
      ['Start Date', fmtDate(pa.startDate)],
      ['End Date', fmtDate(pa.endDate)],
      ['Budget', fmtINR(budget)],
      ['Purchase Spent', fmtINR(spent)],
      ['Invoiced/Billed', fmtINR(billed)],
      ['Remaining Budget', fmtINR(remaining)],
    ];
    const rowH = 14;
    details.forEach(([label, value], idx) => {
      y = checkPage(y, rowH);
      if (idx % 2 === 0) fillBox(X, y, W, rowH, '#fafafa');
      box(X, y, W, rowH, LBD);
      vLine(X + 150, y, y + rowH, LBD);
      txt(label, X + 5, y + 3, 140, { size: 7.5, bold: true, color: BLK });
      txt(value || 'N/A', X + 156, y + 3, W - 162, { size: 7.5, color: BLK });
      y += rowH;
    });

    if (pa.description) {
      y = checkPage(y, 42);
      y = drawSectionLabel({ fillBox, box, txt }, 'Description', y);
      box(X, y, W, 30, LBD);
      txt(pa.description, X + 5, y + 5, W - 10, { size: 7.5, color: GRY });
      y += 30;
    }

    const linkedRows = [
      ['Purchase Orders', (plain.purchaseOrders || []).length, fmtINR(spent)],
      ['Invoices', (plain.invoices || []).length, fmtINR(billed)],
      ['Work Orders', (plain.workOrders || []).length, ''],
    ];
    y = checkPage(y, 60);
    y = drawSectionLabel({ fillBox, box, txt }, 'Linked Records Summary', y);
    fillBox(X, y, W, rowH, HBG);
    box(X, y, W, rowH, LBD);
    vLine(X + 250, y, y + rowH, LBD);
    vLine(X + 360, y, y + rowH, LBD);
    txt('Record Type', X + 5, y + 3, 240, { size: 7.5, bold: true, color: BLK });
    txt('Count', X + 255, y + 3, 100, { size: 7.5, bold: true, align: 'center', color: BLK });
    txt('Amount', X + 365, y + 3, W - 370, { size: 7.5, bold: true, align: 'right', color: BLK });
    y += rowH;
    linkedRows.forEach(([label, count, amount]) => {
      y = checkPage(y, rowH);
      box(X, y, W, rowH, LBD);
      vLine(X + 250, y, y + rowH, LBD);
      vLine(X + 360, y, y + rowH, LBD);
      txt(label, X + 5, y + 3, 240, { size: 7.5, color: BLK });
      txt(count, X + 255, y + 3, 100, { size: 7.5, align: 'center', color: BLK });
      txt(amount, X + 365, y + 3, W - 370, { size: 7.5, align: 'right', color: BLK });
      y += rowH;
    });

    y = checkPage(y, 55);
    const bankLines = [
      ['Bank:', co.bankName || 'N/A'],
      ['A/c Name:', co.bankAcName || 'N/A'],
      ['A/c No.:', co.bankAccount || 'N/A'],
      ['IFSC:', co.bankIfsc || 'N/A'],
      ['Branch:', co.bankBranch || 'N/A'],
    ];
    drawSignature({ fillBox, box, vLine, hLine, txt }, y, co.name || 'DHPE', bankLines);

    addFooters(doc);
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
};

// ── POST /project-accounts ────────────────────────────────────────────────────
exports.createProjectAccount = async (req, res) => {
  try {
    const data = req.body;
    if (!data.name) return res.status(400).json({ message: 'Project name required' });
    data.projectCode = cleanGeneratedCode(data.projectCode, 'PRJ');
    data.createdBy = req.user.id;
    // auto-fill clientName
    if (data.clientId && !data.clientName) {
      const c = await Client.findByPk(data.clientId);
      if (c) data.clientName = c.name;
    }
    const pa = await ProjectAccount.create(data);
    res.status(201).json(pa);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PUT /project-accounts/:id ─────────────────────────────────────────────────
exports.updateProjectAccount = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id);
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });
    await pa.update(req.body);
    res.json(pa);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /project-accounts/:id ──────────────────────────────────────────────
exports.deleteProjectAccount = async (req, res) => {
  try {
    const pa = await ProjectAccount.findByPk(req.params.id);
    if (!pa) return res.status(404).json({ message: 'Project Account not found' });
    const { moveToRecycleBin } = require('./recycleBinController');
    await moveToRecycleBin('project_account', pa.id, req.user, pa.toJSON(), pa.name);
    await pa.destroy();
    res.json({ message: 'Project Account deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
