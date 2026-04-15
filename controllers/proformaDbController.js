'use strict';
const { Op } = require('sequelize');
const { Proforma, Invoice, Client, Quotation } = require('../models');

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
